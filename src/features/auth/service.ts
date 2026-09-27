// Peraturan auth - pariti marc_go handlers/auth.go + sessions.go. Tiada Hono,
// tiada SQL: HTTP di routes.ts, SQL di repo.ts. Kebergantungan luaran
// (emel, queue) disuntik melalui AuthDeps.
import bcrypt from 'bcryptjs'
import { isBlocked } from '../blocked-email-domains'
import { createInitialStmt, isBanned, listManagementUserIds, markEmailVerified } from '../profile'
import type { Config } from '../../shared/config'
import { opaqueToken, sha256Hex } from '../../shared/crypto'
import { uuid } from '../../shared/db'
import { domainOf, isAllowed, isDisposable } from '../../shared/disposable-email'
import { emailEnabled, type SendEmail } from '../../shared/email'
import { ApiError } from '../../shared/http'
import { enqueueNotify, type Enqueue } from '../../shared/jobs'
import { signAccess } from '../../shared/jwt'
import { normalizeMY } from '../../shared/phone'
import { revokeSessions, revokeUser } from '../../shared/revocation'
import { passwordResetEmailHtml, verificationEmailHtml } from './html'
import * as repo from './repo'

export type AuthDeps = { sendEmail: SendEmail; enqueue: Enqueue }

export type AuthCtx = {
  env: CloudflareBindings
  config: Config
  deps: AuthDeps
  now: number
  ip: string
  deviceLabel: string
  waitUntil(promise: Promise<unknown>): void
}

export type TokenPair = { access_token: string; refresh_token: string; expires_in: number }

const HOUR = 60 * 60 * 1000
const EMAIL_VERIFY_TTL = HOUR
const PASSWORD_RESET_TTL = HOUR
const VERIFY_SEND_COOLDOWN = 60 * 1000
const VERIFY_SEND_DAILY_MAX = 5
const VERIFY_SEND_WINDOW = 24 * HOUR
// Reuse dalam tempoh ini DARI IP YANG SAMA = retry/race sah, bukan curi.
const REUSE_GRACE = 5 * 1000
const BCRYPT_COST = 10 // bcrypt.DefaultCost Go

// Hash tetap (bukan kata laluan sesiapa) - bakar masa bcrypt yang sama bila
// emel tidak wujud, supaya masa respons tidak membezakan akaun wujud.
const DUMMY_HASH = '$2a$10$/8Dd.SDyfy2jxDvvxwPheeHLucYAitJ42OSSoz8wtyR1UTR8A3JfW'

const DISPOSABLE = 'sila guna alamat emel kekal, bukan emel pelupusan/sekali-guna'

const log = (msg: string, extra: Record<string, unknown> = {}) => console.error(JSON.stringify({ level: 'error', msg, ...extra }))

export const hashPassword = (password: string) => bcrypt.hash(password, BCRYPT_COST)

// ---- token ----

async function issueTokens(ctx: AuthCtx, userId: string, familyId: string): Promise<TokenPair> {
  const refresh = opaqueToken()
  await repo.insertRefresh(ctx.env.DB, {
    id: uuid(),
    userId,
    hash: await sha256Hex(refresh),
    familyId,
    expiresAt: ctx.now + ctx.config.REFRESH_TOKEN_TTL_DAYS * 24 * HOUR,
    userAgent: ctx.deviceLabel,
    ip: ctx.ip,
  })
  return {
    access_token: await signAccess(ctx.config.JWT_SECRET, ctx.config.ACCESS_TOKEN_TTL_MINUTES, userId, familyId),
    refresh_token: refresh,
    expires_in: ctx.config.ACCESS_TOKEN_TTL_MINUTES * 60,
  }
}

// ---- register / login ----

export async function register(ctx: AuthCtx, input: { email: string; password: string; phone: string; staff_id: string }): Promise<TokenPair> {
  const email = input.email.trim().toLowerCase()
  if (isDisposable(email)) throw new ApiError(400, DISPOSABLE)
  const domain = domainOf(email)
  // Jadual DB tidak tahu allowlist tester - semak semula di sini.
  if (domain && !isAllowed(email)) {
    const blocked = await isBlocked(ctx.env.DB, domain).catch(() => {
      throw new ApiError(500, 'gagal proses pendaftaran')
    })
    if (blocked) throw new ApiError(400, DISPOSABLE)
  }

  const phone = normalizeMY(input.phone)
  if (!phone) throw new ApiError(400, 'format nombor telefon tidak sah')
  const staffId = input.staff_id.trim()
  if (!staffId) throw new ApiError(400, 'nombor staff diperlukan')
  if (staffId.includes('/')) throw new ApiError(400, "nombor staff tidak boleh mengandungi '/'")

  const userId = uuid()
  const db = ctx.env.DB
  try {
    await db.batch([
      repo.createUserStmt(db, { id: userId, email, passwordHash: await hashPassword(input.password) }),
      createInitialStmt(db, { id: uuid(), userId, staffId, phone }),
    ])
  } catch (err) {
    const msg = String(err)
    if (/UNIQUE constraint failed: (users\.email|index 'users_email_lower_idx')/.test(msg)) throw new ApiError(409, 'email ini sudah berdaftar')
    if (msg.includes('UNIQUE constraint failed: profiles.staff_id')) throw new ApiError(409, 'nombor staff ini sudah didaftarkan')
    log('daftar gagal', { error: msg })
    throw new ApiError(500, 'gagal proses pendaftaran')
  }

  let tokens: TokenPair
  try {
    tokens = await issueTokens(ctx, userId, uuid())
  } catch (err) {
    log('daftar: token gagal', { error: String(err) })
    throw new ApiError(500, 'pendaftaran berjaya tapi gagal log masuk, sila log masuk semula')
  }

  // Best-effort, selepas respons: notifikasi tidak menggagalkan pendaftaran.
  ctx.waitUntil(
    (async () => {
      await enqueueNotify(ctx.deps.enqueue, ctx.env, { kind: 'member_pending', actorId: userId }, await listManagementUserIds(db))
    })().catch((err) => log('notify member_pending gagal', { error: String(err) })),
  )
  return tokens
}

export async function login(ctx: AuthCtx, input: { email: string; password: string }): Promise<TokenPair> {
  const user = await repo.findUserByEmail(ctx.env.DB, input.email.trim().toLowerCase())
  if (!user) {
    await bcrypt.compare(input.password, DUMMY_HASH)
    throw new ApiError(401, 'email atau kata laluan salah')
  }
  if (!(await bcrypt.compare(input.password, user.password_hash))) throw new ApiError(401, 'email atau kata laluan salah')

  const banned = await isBanned(ctx.env.DB, user.id, ctx.now).catch(() => {
    throw new ApiError(500, 'gagal semak status akaun')
  })
  if (banned) throw new ApiError(403, 'akaun anda sedang digantung')

  return issueTokens(ctx, user.id, uuid()).catch((err) => {
    log('log masuk gagal', { error: String(err) })
    throw new ApiError(500, 'log masuk gagal')
  })
}

// ---- refresh / logout ----

export async function refresh(ctx: AuthCtx, token: string): Promise<TokenPair> {
  const db = ctx.env.DB
  const hash = await sha256Hex(token)
  const next = opaqueToken()
  const fail = (err: unknown): never => {
    // Ralat DB BUKAN penolakan token: 500, bukan 401 (401 = app log keluar).
    log('refresh gagal', { error: String(err) })
    throw new ApiError(500, 'gagal reset sesi')
  }

  const rotated = await repo
    .rotateRefresh(
      db,
      hash,
      { id: uuid(), hash: await sha256Hex(next), expiresAt: ctx.now + ctx.config.REFRESH_TOKEN_TTL_DAYS * 24 * HOUR, userAgent: ctx.deviceLabel, ip: ctx.ip },
      ctx.now,
    )
    .catch(fail)

  if (!rotated) {
    const existing = await repo.findRefresh(db, hash).catch(fail)
    if (existing?.consumed_at != null) {
      const grace = ctx.now - existing.consumed_at <= REUSE_GRACE && !!existing.consumed_ip && existing.consumed_ip === ctx.ip
      if (!grace) {
        // Reuse = token dicuri. Bunuh keluarga: rantaian penyerang DAN sesi asal.
        await repo.deleteFamily(db, existing.family_id).catch((err) => log('revoke keluarga gagal', { error: String(err) }))
        await revokeSessions(ctx.env.KV, [existing.family_id], ctx.config.ACCESS_TOKEN_TTL_MINUTES).catch(() => {})
      }
    } else if (existing && existing.expires_at <= ctx.now) {
      throw new ApiError(401, 'refresh token sudah luput')
    }
    throw new ApiError(401, 'refresh token tidak sah')
  }

  // D1 sumber kebenaran ban (KV hanya untuk access token di edge).
  if (await isBanned(db, rotated.user_id, ctx.now).catch(fail)) throw new ApiError(403, 'akaun anda sedang digantung')

  return {
    access_token: await signAccess(ctx.config.JWT_SECRET, ctx.config.ACCESS_TOKEN_TTL_MINUTES, rotated.user_id, rotated.family_id),
    refresh_token: next,
    expires_in: ctx.config.ACCESS_TOKEN_TTL_MINUTES * 60,
  }
}

// Idempoten. Memadam SELURUH keluarga peranti (marc_go: satu baris sahaja,
// jadi peranti yang log keluar masih tersenarai dalam /me/sessions -
// 00001 §8).
export async function logout(ctx: AuthCtx, token: string): Promise<void> {
  const familyId = await repo.deleteFamilyOfToken(ctx.env.DB, await sha256Hex(token)).catch(() => null)
  if (familyId) await revokeSessions(ctx.env.KV, [familyId], ctx.config.ACCESS_TOKEN_TTL_MINUTES).catch(() => {})
}

export async function logoutAll(ctx: AuthCtx, userId: string): Promise<void> {
  await repo.deleteAllRefreshForUser(ctx.env.DB, userId).catch(() => {
    throw new ApiError(500, 'gagal log keluar semua sesi')
  })
  await revokeUser(ctx.env.KV, userId, ctx.config.ACCESS_TOKEN_TTL_MINUTES, ctx.now).catch((err) => log('KV revokeUser gagal', { error: String(err) }))
}

// ---- sesi ----

export async function sessions(ctx: AuthCtx, userId: string) {
  return repo.activeSessions(ctx.env.DB, userId, ctx.now).catch(() => {
    throw new ApiError(500, 'gagal muat senarai sesi')
  })
}

export async function revokeFamilies(ctx: AuthCtx, userId: string, familyIds: string[]): Promise<number> {
  const { rows, familyIds: gone } = await repo.deleteFamiliesForUser(ctx.env.DB, userId, familyIds).catch(() => {
    throw new ApiError(500, 'gagal log keluar sesi')
  })
  if (rows === 0) throw new ApiError(404, 'sesi tidak dijumpai')
  await revokeSessions(ctx.env.KV, gone, ctx.config.ACCESS_TOKEN_TTL_MINUTES).catch(() => {})
  return rows
}

// ---- pengesahan emel ----

export async function requestEmailVerification(ctx: AuthCtx, userId: string): Promise<void> {
  const db = ctx.env.DB
  const failed = () => {
    throw new ApiError(500, 'gagal jana token pengesahan')
  }
  const stats = await repo.verificationSendStats(db, userId, ctx.now - VERIFY_SEND_WINDOW).catch(failed)
  if (stats.last !== null && ctx.now - stats.last < VERIFY_SEND_COOLDOWN) throw new ApiError(429, 'tunggu sebentar sebelum minta emel pengesahan semula')
  if (stats.recent >= VERIFY_SEND_DAILY_MAX) throw new ApiError(429, 'had harian emel pengesahan tercapai. Cuba lagi esok.')

  const token = opaqueToken()
  await repo
    .replaceVerificationToken(db, { id: uuid(), sendId: uuid(), userId, hash: await sha256Hex(token), expiresAt: ctx.now + EMAIL_VERIFY_TTL, now: ctx.now })
    .catch(failed)

  const base = ctx.config.EMAIL_VERIFY_URL || `${ctx.config.PUBLIC_BASE_URL}/auth/verify-email/confirm`
  const link = `${base}?token=${token}`
  if (!emailEnabled(ctx.config)) return devLog('pengesahan emel', userId, link, ctx.config)

  const email = await repo.findUserEmail(db, userId).catch(failed)
  if (!email) failed()
  // Kegagalan penghantaran tidak menggagalkan permintaan - token sudah wujud.
  await ctx.deps
    .sendEmail(ctx.config, { to: email!, subject: 'Sahkan emel akaun MARC', html: verificationEmailHtml(email!, link) })
    .catch((err) => log('hantar emel pengesahan gagal', { error: String(err) }))
}

export async function confirmEmailVerification(ctx: AuthCtx, token: string): Promise<void> {
  const claimed = await repo.claimVerificationToken(ctx.env.DB, await sha256Hex(token)).catch(() => {
    throw new ApiError(500, 'gagal sahkan email')
  })
  if (!claimed) throw new ApiError(400, 'token tidak sah')
  if (claimed.expires_at <= ctx.now) throw new ApiError(400, 'token sudah luput')
  try {
    await markEmailVerified(ctx.env.DB, claimed.user_id)
    await repo.deleteVerificationTokensForUser(ctx.env.DB, claimed.user_id)
  } catch {
    throw new ApiError(500, 'gagal sahkan email')
  }
}

// ---- reset kata laluan ----

// Sentiasa berjaya (204) sama ada akaun wujud atau tidak - tiada enumerasi.
export async function requestPasswordReset(ctx: AuthCtx, rawEmail: string): Promise<void> {
  const db = ctx.env.DB
  const user = await repo.findUserByEmail(db, rawEmail.trim().toLowerCase()).catch(() => null)
  if (!user) return

  const token = opaqueToken()
  try {
    await repo.replaceResetToken(db, { id: uuid(), userId: user.id, hash: await sha256Hex(token), expiresAt: ctx.now + PASSWORD_RESET_TTL })
  } catch (err) {
    return log('simpan token reset gagal', { error: String(err) })
  }

  const link = `${ctx.config.PASSWORD_RESET_URL}?token=${token}`
  if (!emailEnabled(ctx.config)) return devLog('reset kata laluan', user.id, link, ctx.config)

  // Selepas respons (waitUntil), bukan sebelum: masa respons tidak boleh
  // membezakan "akaun wujud" (panggil Resend) daripada "tiada akaun".
  const email = await repo.findUserEmail(db, user.id)
  if (!email) return
  ctx.waitUntil(
    ctx.deps
      .sendEmail(ctx.config, { to: email, subject: 'Reset Kata Laluan MARC', html: passwordResetEmailHtml(link) })
      .catch((err) => log('hantar emel reset gagal', { error: String(err) })),
  )
}

export async function confirmPasswordReset(ctx: AuthCtx, input: { token: string; password: string }): Promise<void> {
  const hash = await sha256Hex(input.token)
  const passwordHash = await hashPassword(input.password)
  const claimed = await repo.resetPassword(ctx.env.DB, hash, passwordHash, ctx.now).catch(() => {
    throw new ApiError(500, 'gagal tukar kata laluan')
  })
  if (!claimed) throw new ApiError(400, 'pautan tidak sah')
  if (claimed.expires_at <= ctx.now) throw new ApiError(400, 'pautan sudah luput')
  // Semua sesi sudah dipadam dalam batch; tolak access token sedia ada di edge.
  await revokeUser(ctx.env.KV, claimed.user_id, ctx.config.ACCESS_TOKEN_TTL_MINUTES, ctx.now).catch((err) => log('KV revokeUser gagal', { error: String(err) }))
}

// Emel tidak dikonfigur: pautan hanya dilog dalam development (marc_go
// melognya sentiasa - token dalam log produksi ialah kebocoran).
function devLog(what: string, userId: string, link: string, config: Config): void {
  if (config.ENVIRONMENT === 'development') console.log(JSON.stringify({ level: 'info', msg: `${what} (emel belum dikonfigur)`, user_id: userId, link }))
  else log(`${what}: emel belum dikonfigur`, { user_id: userId })
}
