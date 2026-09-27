// Pendaftaran & kehadiran - pariti marc_go activity_registrations.go +
// activity_attendance.go. Kunci baris marc_go diganti WHERE bersyarat (R1).
import { isManagement } from '../profile'
import { auditStmt, type Actor } from '../../shared/audit'
import { uuid } from '../../shared/db'
import { ApiError } from '../../shared/http'
import { toJson, toJsonNullable } from '../../shared/time'
import * as repo from './repo'
import type { Registration } from './repo'

export type RegistrationsCtx = { env: CloudflareBindings; now: number; actor: Actor; userId: string }

export async function requireManagement(ctx: RegistrationsCtx) {
  let ok: boolean
  try {
    ok = await isManagement(ctx.env.DB, ctx.userId)
  } catch {
    throw new ApiError(500, 'gagal semak kebenaran')
  }
  if (!ok) throw new ApiError(403, 'tindakan ini untuk pengurusan sahaja')
}

export const registrationDto = (r: Registration) => ({
  id: r.id,
  activity_id: r.activity_id,
  user_id: r.user_id,
  status: r.status,
  payment_status: r.payment_status,
  payment_ref: r.payment_ref,
  checkin_token: r.checkin_token,
  registered_at: toJson(r.registered_at),
  cancelled_at: toJsonNullable(r.cancelled_at),
  fee_cents_paid: r.fee_cents_paid,
})

// Token QR legap: 24 bait CSPRNG, base64url tanpa padding.
function checkinToken() {
  const b = crypto.getRandomValues(new Uint8Array(24))
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function register(ctx: RegistrationsCtx, activityId: string) {
  const db = ctx.env.DB
  const row = await repo.registerStmt(db, { id: uuid(), activityId, userId: ctx.userId, token: checkinToken(), now: ctx.now }).first<Registration>()
  if (row) return { registration: registrationDto(row) }

  // Tiada baris: baca sekali untuk mesej yang tepat (susunan semakan marc_go).
  const a = await repo.activity(db, activityId)
  if (!a) throw new ApiError(404, 'aktiviti tidak dijumpai')
  if (a.status !== 'published') throw new ApiError(409, 'aktiviti belum dibuka')
  if ((a.registration_opens_at !== null && ctx.now < a.registration_opens_at) || ctx.now > a.registration_closes_at) throw new ApiError(409, 'pendaftaran telah ditutup')
  if (await repo.activeRegistration(db, activityId, ctx.userId)) throw new ApiError(409, 'anda sudah berdaftar')
  throw new ApiError(409, 'aktiviti sudah penuh')
}

export async function cancel(ctx: RegistrationsCtx, activityId: string) {
  const db = ctx.env.DB
  // Dibaca dahulu hanya untuk membezakan mesej; guard sebenar dalam SQL.
  const a = await repo.activity(db, activityId)
  if (!a) throw new ApiError(404, 'aktiviti tidak dijumpai')
  if (ctx.now >= a.ends_at) throw new ApiError(422, 'aktiviti sudah tamat, pendaftaran tidak boleh dibatalkan')
  const row = await repo.cancelStmt(db, activityId, ctx.userId, ctx.now)
  if (!row) throw new ApiError(404, 'anda tidak berdaftar')
  return { registration: registrationDto(row) }
}

export async function listForActivity(ctx: RegistrationsCtx, activityId: string) {
  const rows = await repo.listForActivity(ctx.env.DB, activityId)
  return {
    registrations: rows.map((r) => ({
      id: r.id,
      activity_id: r.activity_id,
      user_id: r.user_id,
      status: r.status,
      payment_status: r.payment_status,
      payment_ref: r.payment_ref,
      fee_cents_paid: r.fee_cents_paid,
      registered_at: toJson(r.registered_at),
      cancelled_at: toJsonNullable(r.cancelled_at),
      member_id: r.member_id,
      display_name: r.display_name,
      avatar_r2_key: r.avatar_r2_key,
      attended_session_ids: JSON.parse(r.attended_session_ids) as string[],
    })),
  }
}

export async function listMine(ctx: RegistrationsCtx) {
  const rows = await repo.listMine(ctx.env.DB, ctx.userId)
  return {
    registrations: rows.map((r) => ({
      ...registrationDto(r),
      title: r.title,
      starts_at: toJson(r.starts_at),
      ends_at: toJson(r.ends_at),
      activity_status: r.activity_status,
      category_name: r.category_name,
      fee_cents: r.fee_cents,
      currency: r.currency,
    })),
  }
}

// ---- kehadiran ----

const NOT_REGISTERED = 'ahli ini tidak berdaftar untuk aktiviti ini'
const METHODS = new Set(['manual', 'scan', 'self_scan'])

export type MarkInput = { registration_id: string; checkin_token: string; method: string; amend: boolean; reason: string }

export async function mark(ctx: RegistrationsCtx, activityId: string, sessionId: string, req: MarkInput) {
  if (!METHODS.has(req.method)) throw new ApiError(400, 'kaedah kehadiran tidak sah')
  const db = ctx.env.DB
  let reg: Registration | null

  if (req.method === 'self_scan') {
    // Identiti daripada JWT sahaja; QR venue hanya mengekod aktiviti+sesi.
    if (req.registration_id || req.checkin_token) throw new ApiError(400, 'self_scan tidak menerima registration_id/checkin_token')
    if (req.amend) throw new ApiError(400, 'self_scan tidak menyokong pindaan')
    reg = await repo.activeRegistration(db, activityId, ctx.userId)
    if (!reg) throw new ApiError(409, 'anda tidak berdaftar untuk aktiviti ini')
  } else {
    await requireManagement(ctx)
    if (!req.registration_id === !req.checkin_token) throw new ApiError(400, 'berikan registration_id atau checkin_token, satu sahaja')
    if (req.checkin_token) {
      reg = await repo.byCheckinToken(db, req.checkin_token)
      if (!reg) throw new ApiError(404, 'QR tidak dikenali')
    } else {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.registration_id)) throw new ApiError(400, 'registration_id tidak sah')
      reg = await repo.getRegistration(db, req.registration_id.toLowerCase())
      if (!reg) throw new ApiError(409, NOT_REGISTERED)
    }
  }
  if (reg.activity_id !== activityId) throw new ApiError(409, NOT_REGISTERED)

  let reason = ''
  if (req.amend) {
    reason = req.reason.trim()
    if (!reason) throw new ApiError(400, 'sebab pindaan diperlukan')
  }

  const id = uuid()
  const newValues: Record<string, unknown> = { registration_id: reg.id, session_id: sessionId, method: req.method, ...(req.amend && { amendment: true, reason }) }
  // Hanya tanda yang BENAR-BENAR mencipta baris diaudit (imbasan berulang tidak).
  const [res] = await db.batch([
    repo.markStmt(db, { id, registrationId: reg.id, sessionId, method: req.method, markedBy: ctx.userId, now: ctx.now, amend: req.amend }),
    auditStmt(db, { entityType: 'activity_attendance', entityId: id, action: 'create', actor: ctx.actor, new: newValues }, { sql: 'EXISTS (SELECT 1 FROM activity_attendances WHERE id = ?)', params: [id] })!,
  ])

  let created = true
  if (!res?.results.length) {
    // Tiada baris: pilih sebab dengan susunan semakan marc_go.
    const s = await repo.session(db, sessionId)
    if (!s) throw new ApiError(404, 'sesi tidak dijumpai')
    if (!s.live) throw new ApiError(404, 'aktiviti tidak dijumpai')
    if (!req.amend && (ctx.now < s.starts_at - repo.CHECKIN_PADDING_MS || ctx.now > s.ends_at + repo.CHECKIN_PADDING_MS)) throw new ApiError(422, 'di luar tetingkap check-in')
    const current = await repo.getRegistration(db, reg.id)
    if (!current || current.activity_id !== s.activity_id || current.status === 'cancelled') throw new ApiError(409, NOT_REGISTERED)
    if (!(await repo.getAttendance(db, reg.id, sessionId))) throw new ApiError(500, 'gagal tanda kehadiran')
    created = false // sudah ditanda: bukan ralat
  }

  const m = await repo.memberOf(db, reg.user_id).catch(() => null)
  return { created, member: { display_name: m?.display_name ?? '', member_id: m?.member_id ?? '' } }
}

// Membuang bukti sijil: pengurusan sahaja, sentiasa diaudit, tanpa tetingkap.
export async function unmark(ctx: RegistrationsCtx, activityId: string, sessionId: string, registrationId: string) {
  const db = ctx.env.DB
  if (!(await repo.activity(db, activityId))) throw new ApiError(404, 'aktiviti tidak dijumpai')
  const s = await repo.session(db, sessionId)
  if (!s || s.activity_id !== activityId) throw new ApiError(404, 'sesi tidak dijumpai')
  const before = await repo.getAttendance(db, registrationId, sessionId)
  if (!before) throw new ApiError(404, 'kehadiran tidak dijumpai')
  const [res] = await db.batch([
    repo.deleteAttendanceStmt(db, before.id),
    // changes() = baris dipadam oleh statement sebelumnya dalam batch yang sama.
    auditStmt(
      db,
      {
        entityType: 'activity_attendance',
        entityId: before.id,
        action: 'delete',
        actor: ctx.actor,
        old: { registration_id: registrationId, session_id: sessionId, method: before.method, checked_in_at: toJson(before.checked_in_at) },
      },
      { sql: 'changes() > 0', params: [] },
    )!,
  ])
  if (!res?.results.length) throw new ApiError(404, 'kehadiran tidak dijumpai')
  return { deleted: true }
}
