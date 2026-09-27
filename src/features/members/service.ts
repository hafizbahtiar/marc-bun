// Tindakan pengurusan ke atas ahli - pariti marc_go handlers/profile.go
// (Members, GetMemberDetail, ListRoles, UpdateMember*, setMemberStatus,
// VerifyStaffID, CorrectStaffID, CorrectMemberID). SUSUNAN SEMAKAN & MESEJ =
// marc_go (ia menentukan ralat mana yang pengguna nampak).
import { deleteAllRefreshStmt } from '../auth'
import { exists as departmentExists } from '../departments'
import * as profile from '../profile'
import type { MemberRow } from '../profile'
import { signedUrl } from '../uploads'
import { auditStmt, ENTITY, type Actor } from '../../shared/audit'
import { expectedUpdatedAt, staleWrite } from '../../shared/concurrency'
import type { SendEmail } from '../../shared/email'
import { ApiError } from '../../shared/http'
import type { Enqueue } from '../../shared/jobs'
import type { Config } from '../../shared/config'
import { revokeUser } from '../../shared/revocation'
import { mytYear, toJson, toJsonNullable } from '../../shared/time'
import { memberDetailDto, memberDto } from './dto'
import * as repo from './repo'
import { codeFor, formatMemberId, MANAGEMENT, memberIdCode, SUPERADMIN, visibleRankCeiling } from './rules'

export type MembersDeps = { sendEmail: SendEmail; enqueue: Enqueue }

export type MembersCtx = {
  env: CloudflareBindings
  config: Config
  deps: MembersDeps
  now: number
  actor: Actor
  callerId: string
  waitUntil(p: Promise<unknown>): void
}

const STALE = 'profil ahli telah berubah. Muat semula sebelum mengemas kini lagi.'
const HIGHER = 'tidak boleh edit ahli setaraf/lebih tinggi drpd anda'
const runes = (s: string) => [...s].length
const log = (msg: string, extra: Record<string, unknown> = {}) => console.error(JSON.stringify({ level: 'error', msg, ...extra }))

async function caller(ctx: MembersCtx, failure: { status: 404 | 500; message: string }) {
  const row = await profile.getMember(ctx.env.DB, ctx.callerId)
  if (!row) throw new ApiError(failure.status, failure.message)
  return row
}

async function target(ctx: MembersCtx, id: string) {
  const row = await profile.getMember(ctx.env.DB, id)
  if (!row) throw new ApiError(404, 'ahli tidak dijumpai')
  return row
}

// rank(caller) >= rank(peranan `key`)
async function atLeast(ctx: MembersCtx, key: string): Promise<boolean> {
  const [me, roles] = await Promise.all([profile.getMember(ctx.env.DB, ctx.callerId), repo.listRoles(ctx.env.DB)])
  const min = roles.find((r) => r.key === key)?.rank ?? Number.POSITIVE_INFINITY
  return !!me && me.role_rank >= min
}

// Identiti pelaku disalin ke new_values (bacaan timeline tanpa silang-rujuk).
const actorFields = (me: MemberRow) => ({
  actor_user_id: me.user_id,
  ...(me.member_id ? { actor_member_id: me.member_id } : {}),
  actor_role_key: me.role_key,
})

// Guard audit: hanya bila UPDATE kita benar-benar berlaku (updated_at = now).
const touched = (userId: string, now: number) => ({ sql: 'EXISTS (SELECT 1 FROM profiles WHERE user_id = ? AND updated_at = ?)', params: [userId, now] })

async function batchWithAudit(ctx: MembersCtx, stmt: D1PreparedStatement, audit: D1PreparedStatement | null) {
  const [res] = await ctx.env.DB.batch(audit ? [stmt, audit] : [stmt])
  return (res?.results[0] as MemberRow | undefined) ?? null
}

// ---- senarai & butiran ----

export async function list(ctx: MembersCtx, status: string | null) {
  const me = await caller(ctx, { status: 404, message: 'profil tidak dijumpai' })
  const management = me.role_category === MANAGEMENT
  if (status && !management) throw new ApiError(403, 'cuma pengurusan boleh tapis ahli ikut status')
  const roles = await repo.listRoles(ctx.env.DB)
  const rows = await profile.listVisible(ctx.env.DB, { maxRank: visibleRankCeiling(roles, me.role_rank), status: status || null, includeAll: management, viewerId: me.user_id })
  return Promise.all(
    rows.map(async (r) => {
      const self = r.user_id === me.user_id
      return memberDto(r, { email: management || self, payment: management, staffId: management || self }, await signedUrl(ctx.env, r.avatar_r2_key))
    }),
  )
}

export async function detail(ctx: MembersCtx, targetId: string) {
  const me = await caller(ctx, { status: 404, message: 'profil tidak dijumpai' })
  const t = await target(ctx, targetId)
  const roles = await repo.listRoles(ctx.env.DB)
  // Keterlihatan BARIS dahulu - 404 (bukan 403) supaya kewujudan tidak bocor.
  if (t.role_rank > visibleRankCeiling(roles, me.role_rank)) throw new ApiError(404, 'ahli tidak dijumpai')
  const management = me.role_category === MANAGEMENT
  if (!management && t.status !== 'approved' && t.user_id !== me.user_id) throw new ApiError(404, 'ahli tidak dijumpai')
  const superadmin = me.role_key === SUPERADMIN
  const addresses = superadmin ? await profile.listAddresses(ctx.env.DB, targetId) : null
  return memberDetailDto(t, { management, superadmin }, await signedUrl(ctx.env, t.avatar_r2_key), addresses)
}

// Hanya peranan yang caller BOLEH assign (rank lebih rendah).
export async function assignableRoles(ctx: MembersCtx) {
  const me = await caller(ctx, { status: 500, message: 'gagal muat senarai role' })
  if (me.role_category !== MANAGEMENT) throw new ApiError(403, 'cuma pengurusan boleh lihat senarai role')
  return (await repo.listRoles(ctx.env.DB)).filter((r) => r.rank < me.role_rank).map((r) => ({ key: r.key, name: r.name, rank: r.rank }))
}

// ---- peranan / aktif / bahagian ----

export async function setRole(ctx: MembersCtx, targetId: string, input: { role_key: string; updated_at: string }) {
  if (targetId === ctx.callerId) throw new ApiError(400, 'tidak boleh tukar role akaun sendiri')
  const me = await caller(ctx, { status: 500, message: 'gagal kemas kini role ahli' })
  if (me.role_category !== MANAGEMENT) throw new ApiError(403, 'cuma pengurusan boleh tukar role ahli')
  const t = await target(ctx, targetId)
  if (me.role_rank <= t.role_rank) throw new ApiError(403, HIGHER)
  const role = (await repo.listRoles(ctx.env.DB)).find((r) => r.key === input.role_key)
  if (!role) throw new ApiError(400, 'role tidak sah')
  if (role.rank >= me.role_rank) throw new ApiError(403, 'tidak boleh assign role setaraf/lebih tinggi drpd anda')
  const expected = expectedUpdatedAt(input.updated_at)

  const db = ctx.env.DB
  const updated = await batchWithAudit(
    ctx,
    profile.setRoleStmt(db, targetId, role.id, expected, ctx.now),
    // Perubahan keistimewaan: rank direkod, bukan kunci sahaja.
    auditStmt(db, { entityType: ENTITY.profile, entityId: targetId, action: 'update', actor: ctx.actor, old: { role_key: t.role_key, role_rank: t.role_rank }, new: { role_key: role.key, role_rank: role.rank } }, touched(targetId, ctx.now)),
  )
  if (!updated) throw staleWrite(STALE)
  const fresh = (await profile.getMember(db, targetId))!
  return memberDto(fresh, { email: true, payment: false, staffId: true }, await signedUrl(ctx.env, fresh.avatar_r2_key))
}

export async function setActive(ctx: MembersCtx, targetId: string, input: { is_active: boolean; updated_at: string }) {
  if (targetId === ctx.callerId) throw new ApiError(400, 'tidak boleh tukar status aktif akaun sendiri')
  const me = await caller(ctx, { status: 500, message: 'gagal kemas kini status aktif ahli' })
  if (me.role_category !== MANAGEMENT) throw new ApiError(403, 'cuma pengurusan boleh tukar status aktif ahli')
  const t = await target(ctx, targetId)
  if (me.role_rank <= t.role_rank) throw new ApiError(403, HIGHER)
  const expected = expectedUpdatedAt(input.updated_at)

  const db = ctx.env.DB
  const updated = await batchWithAudit(
    ctx,
    profile.setActiveStmt(db, targetId, input.is_active, expected, ctx.now),
    auditStmt(db, { entityType: ENTITY.profile, entityId: targetId, action: 'update', actor: ctx.actor, old: { is_active: t.is_active === 1 }, new: { is_active: input.is_active } }, touched(targetId, ctx.now)),
  )
  if (!updated) throw staleWrite(STALE)
  return { user_id: updated.user_id, is_active: updated.is_active === 1, updated_at: toJson(updated.updated_at) }
}

// Manager ke atas; rank caller >= target (SETARAF dibenarkan, termasuk diri sendiri).
export async function setDepartment(ctx: MembersCtx, targetId: string, input: { department_code?: string | null; position?: string | null; updated_at: string }) {
  if (input.position != null && runes(input.position) > 150) throw new ApiError(400, 'jawatan terlalu panjang (maksimum 150 aksara)')
  if (!(await atLeast(ctx, 'manager'))) throw new ApiError(403, 'cuma manager ke atas boleh tukar bahagian/jawatan ahli')
  const me = await caller(ctx, { status: 500, message: 'gagal kemas kini bahagian/jawatan ahli' })
  const t = await target(ctx, targetId)
  if (me.role_rank < t.role_rank) throw new ApiError(403, 'tidak boleh edit ahli lebih tinggi drpd anda')

  const code = input.department_code?.trim() || null
  if (code && !(await departmentExists(ctx.env.DB, code))) throw new ApiError(400, 'bahagian tidak sah')
  const position = input.position?.trim() || null
  const expected = expectedUpdatedAt(input.updated_at)

  const db = ctx.env.DB
  const updated = await batchWithAudit(
    ctx,
    profile.setDepartmentStmt(db, targetId, code, position, expected, ctx.now),
    auditStmt(
      db,
      { entityType: ENTITY.profile, entityId: targetId, action: 'update', actor: ctx.actor, old: { department_code: t.department_code, position: t.position }, new: { department_code: code, position } },
      touched(targetId, ctx.now),
    ),
  )
  if (!updated) throw staleWrite(STALE)
  const fresh = (await profile.getMember(db, targetId))!
  return { user_id: fresh.user_id, department_code: fresh.department_code, department_name: fresh.department_name, position: fresh.position, updated_at: toJson(fresh.updated_at) }
}

// ---- kelulusan ----

const statusResponse = (userId: string, status: string, by: string | null, at: number | null) => ({ user_id: userId, status, approved_by: by, approved_at: toJsonNullable(at) })

const STATUS_EMAIL = {
  approved: {
    kind: 'member_approved' as const,
    subject: 'Pendaftaran MARC Diluluskan',
    html: '<p>Pendaftaran anda telah diluluskan oleh pihak pengurusan. Log masuk semula dan sahkan email anda untuk mula guna app MARC.</p>',
  },
  rejected: {
    kind: 'member_rejected' as const,
    subject: 'Pendaftaran MARC Ditolak',
    html: '<p>Pendaftaran anda ke app MARC tidak diluluskan pada masa ini. Jika ini satu kesilapan, sila hubungi pihak pengurusan MARC.</p>',
  },
}

// Pintu bayaran (bypass admin) marc_go TIDAK dipindah: ia tidak boleh dicapai
// sejak pengesahan staff menjadi gate keras (staff disahkan = dikecualikan
// yuran). bypass_payment diterima (pariti body) tetapi tiada kesan.
export async function setStatus(ctx: MembersCtx, targetId: string, status: 'approved' | 'rejected') {
  const db = ctx.env.DB
  const me = await profile.getMember(db, ctx.callerId)
  if (me?.role_category !== MANAGEMENT) throw new ApiError(403, 'cuma pengurusan boleh luluskan/tolak ahli')
  if (targetId === ctx.callerId) throw new ApiError(400, 'tidak boleh laksanakan tindakan ini pada akaun sendiri')
  const t = await target(ctx, targetId)
  // Elak semua pengurusan ditolak (sistem kelulusan buntu).
  if (status === 'rejected' && t.role_category === MANAGEMENT) throw new ApiError(403, 'tidak boleh tolak ahli pengurusan')
  if (t.status === status) return statusResponse(t.user_id, t.status, t.approved_by, t.approved_at)

  if (status === 'approved') {
    if (t.staff_id_verified_at === null) throw new ApiError(400, 'nombor staff ahli ni belum disahkan - sahkan nombor staff dulu sebelum meluluskan')
    // Staff disahkan = dikecualikan yuran. Bil pending tidak menyekat - log
    // untuk semakan refund manual kalau bil itu dibayar kemudian.
    if (t.registration_payment_status === 'pending') log('approve ahli staff-exempt ada bil pendaftaran pending - semak manual', { target: targetId })
  }

  // Tindakan kita sahaja yang menulis approved_at = now untuk status ini.
  const changed = { sql: 'EXISTS (SELECT 1 FROM profiles WHERE user_id = ? AND status = ? AND approved_at = ?)', params: [targetId, status, ctx.now] }
  const stmts = [
    profile.setStatusStmt(db, targetId, status, ctx.callerId, ctx.now),
    auditStmt(db, { entityType: ENTITY.profile, entityId: targetId, action: 'update', actor: ctx.actor, old: { status: t.status }, new: { status, ...actorFields(me) } }, changed)!,
  ]
  // Ditolak: sesi hidup = jurang keselamatan - dibatalkan dalam batch yang SAMA.
  if (status === 'rejected') stmts.push(deleteAllRefreshStmt(db, targetId, changed))
  const [res] = await db.batch(stmts)
  const updated = res?.results[0] as { user_id: string; status: string; approved_by: string; approved_at: number } | undefined
  // Kalah perlumbaan (permintaan lain menukar dahulu) = no-op.
  if (!updated) return statusResponse(t.user_id, status, t.approved_by, t.approved_at)

  if (status === 'rejected') await revokeUser(ctx.env.KV, targetId, ctx.config.ACCESS_TOKEN_TTL_MINUTES, ctx.now).catch((err) => log('KV revokeUser gagal', { error: String(err) }))

  // Selepas komit, best-effort: emel + notifikasi tidak membatalkan keputusan.
  const msg = STATUS_EMAIL[status]
  ctx.waitUntil(ctx.deps.sendEmail(ctx.config, { to: t.email, subject: msg.subject, html: msg.html }).catch((err) => log('emel status ahli gagal', { error: String(err) })))
  ctx.waitUntil(ctx.deps.enqueue(ctx.env, { type: 'notify', kind: msg.kind, actorId: ctx.callerId, recipientIds: [targetId] }).catch((err) => log('notify status ahli gagal', { error: String(err) })))

  return statusResponse(updated.user_id, updated.status, updated.approved_by, updated.approved_at)
}

// ---- staff_id / member_id ----

function validStaffId(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed || runes(trimmed) > 64) throw new ApiError(400, 'nombor staff tidak sah')
  if (trimmed.includes('/')) throw new ApiError(400, "nombor staff tidak boleh mengandungi '/'")
  return trimmed
}

const verifyResponse = (r: MemberRow) => ({ user_id: r.user_id, member_id: r.member_id ?? '', verified_at: toJsonNullable(r.staff_id_verified_at) })

export async function verifyStaffId(ctx: MembersCtx, targetId: string, override: string | null | undefined) {
  if (!(await atLeast(ctx, 'manager'))) throw new ApiError(403, 'cuma manager ke atas boleh sahkan nombor staff')
  if (targetId === ctx.callerId) throw new ApiError(400, 'tidak boleh sahkan nombor staff akaun sendiri')
  const me = await caller(ctx, { status: 500, message: 'gagal sahkan nombor staff' })
  const t = await target(ctx, targetId)
  if (me.role_rank <= t.role_rank) throw new ApiError(403, HIGHER)
  if (t.status === 'rejected') throw new ApiError(409, 'ahli ni dah ditolak')

  if (t.staff_id_verified_at !== null) {
    if (override != null) throw new ApiError(409, 'ahli ni dah disahkan - guna PATCH /members/:id/staff-id untuk betulkan nombor staff')
    return verifyResponse(t)
  }

  const staffId = override != null ? validStaffId(override) : null
  // Nombor staff placeholder migrasi lama (= user_id) tidak boleh disahkan.
  if (staffId === null && t.staff_id === t.user_id) throw new ApiError(400, 'staff_id ahli ni masih placeholder - sila isi nombor staff sebenar semasa sahkan')

  const db = ctx.env.DB
  let memberId: string | null = null
  if (t.member_id === null) {
    const { sequenceKey } = memberIdCode(t.role_key)
    // Dua pusingan (siri dahulu): kegagalan selepas ini membakar satu nombor - diterima (R4).
    const seq = sequenceKey ? await repo.nextSequence(db, sequenceKey, ctx.now) : null
    memberId = formatMemberId(staffId ?? t.staff_id, mytYear(ctx.now), codeFor(t.role_key, seq))
  }

  let updated: MemberRow | null
  try {
    updated = await batchWithAudit(
      ctx,
      profile.verifyStaffIdStmt(db, { userId: targetId, staffId, by: ctx.callerId, memberId, now: ctx.now }),
      auditStmt(
        db,
        {
          entityType: ENTITY.staffIdVerification,
          entityId: targetId,
          action: 'update',
          actor: ctx.actor,
          old: { staff_id_verified_at: null, member_id: t.member_id },
          new: { member_id: t.member_id ?? memberId, staff_id_verified_at: toJson(ctx.now), staff_id_verified_by: ctx.callerId, ...(staffId ? { staff_id: staffId } : {}), ...actorFields(me) },
        },
        touched(targetId, ctx.now),
      ),
    )
  } catch (err) {
    const m = String(err)
    if (m.includes('UNIQUE constraint failed: profiles.staff_id')) throw new ApiError(409, 'nombor staff ini sudah digunakan')
    if (m.includes('UNIQUE constraint failed: profiles.member_id')) throw new ApiError(409, 'nombor ahli yang dijana berlanggar dengan rekod sedia ada - cuba sahkan semula')
    if (m.includes('UNIQUE constraint failed')) throw new ApiError(409, 'konflik data - cuba semula')
    throw err
  }
  // Kalah perlumbaan: permintaan lain mengesahkan dahulu - pulang keadaannya.
  return verifyResponse(updated ?? (await target(ctx, targetId)))
}

export async function correctStaffId(ctx: MembersCtx, targetId: string, raw: string) {
  if (!(await atLeast(ctx, 'admin'))) throw new ApiError(403, 'cuma admin ke atas boleh betulkan nombor staff')
  if (targetId === ctx.callerId) throw new ApiError(400, 'tidak boleh betulkan nombor staff akaun sendiri')
  const me = await caller(ctx, { status: 500, message: 'gagal betulkan nombor staff' })
  const t = await target(ctx, targetId)
  if (me.role_rank <= t.role_rank) throw new ApiError(403, HIGHER)
  const staffId = validStaffId(raw)

  const db = ctx.env.DB
  let updated: MemberRow | null
  try {
    updated = await batchWithAudit(
      ctx,
      profile.correctStaffIdStmt(db, targetId, staffId, ctx.now),
      auditStmt(db, { entityType: ENTITY.staffIdCorrection, entityId: targetId, action: 'update', actor: ctx.actor, old: { staff_id: t.staff_id }, new: { staff_id: staffId, ...actorFields(me) } }, touched(targetId, ctx.now)),
    )
  } catch (err) {
    if (String(err).includes('UNIQUE constraint failed')) throw new ApiError(409, 'nombor staff ini sudah digunakan')
    throw err
  }
  if (!updated) throw new ApiError(404, 'ahli tidak dijumpai')
  return { user_id: updated.user_id, staff_id: updated.staff_id }
}

export async function correctMemberId(ctx: MembersCtx, targetId: string, raw: string) {
  if (!(await atLeast(ctx, 'admin'))) throw new ApiError(403, 'cuma admin ke atas boleh betulkan nombor ahli')
  if (targetId === ctx.callerId) throw new ApiError(400, 'tidak boleh betulkan nombor ahli akaun sendiri')
  const me = await caller(ctx, { status: 500, message: 'gagal betulkan nombor ahli' })
  const t = await target(ctx, targetId)
  if (me.role_rank <= t.role_rank) throw new ApiError(403, HIGHER)
  const memberId = raw.trim()
  if (!memberId || runes(memberId) > 128) throw new ApiError(400, 'nombor ahli tidak sah')

  const db = ctx.env.DB
  let updated: MemberRow | null
  try {
    updated = await batchWithAudit(
      ctx,
      profile.correctMemberIdStmt(db, targetId, memberId, ctx.now),
      auditStmt(db, { entityType: ENTITY.memberIdCorrection, entityId: targetId, action: 'update', actor: ctx.actor, old: { member_id: t.member_id }, new: { member_id: memberId, ...actorFields(me) } }, touched(targetId, ctx.now)),
    )
  } catch (err) {
    if (String(err).includes('UNIQUE constraint failed')) throw new ApiError(409, 'nombor ahli ini sudah digunakan ahli lain')
    throw err
  }
  if (!updated) throw new ApiError(409, 'ahli ni belum ada nombor ahli - sahkan nombor staff dulu (`POST /members/:id/verify-staff-id`)')
  return { user_id: updated.user_id, member_id: updated.member_id }
}
