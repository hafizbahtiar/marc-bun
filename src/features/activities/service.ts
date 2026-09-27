// Aktiviti & kategori - pariti marc_go handlers/activities.go. Susunan semakan
// & mesej = marc_go. `FOR UPDATE` diganti CAS updated_at / WHERE bersyarat (R1).
import { atLeastRole, isManagement, listApprovedUserIds } from '../profile'
import { auditStmt, type Actor } from '../../shared/audit'
import { expectedUpdatedAt, staleWrite } from '../../shared/concurrency'
import { decodeCursor, encodeCursor } from '../../shared/cursor'
import { uuid } from '../../shared/db'
import { ApiError } from '../../shared/http'
import { enqueueNotify, type Enqueue, type NotifyMessage } from '../../shared/jobs'
import { activityDto, activitySnapshot, categoryDto, sessionDto, sessionsSnapshot } from './dto'
import * as repo from './repo'
import type { ActivityRow, Category } from './repo'
import type { CreateActivity, SessionInput, UpdateActivity } from './schema'

export type ActivitiesDeps = { enqueue: Enqueue }

export type ActivitiesCtx = { env: CloudflareBindings; deps: ActivitiesDeps; now: number; actor: Actor; userId: string; waitUntil(p: Promise<unknown>): void }

const NOT_FOUND = 'aktiviti tidak dijumpai'
const NO_SESSIONS = 'aktiviti perlu sekurang-kurangnya satu sesi'
const STATUSES = new Set(['draft', 'published', 'cancelled', 'completed'])
const DEFAULT_STATUSES = ['published', 'cancelled', 'completed'] // draf bukan untuk mata ahli

async function check(ok: Promise<boolean>, forbidden: string) {
  let allowed: boolean
  try {
    allowed = await ok
  } catch {
    throw new ApiError(500, 'gagal semak kebenaran')
  }
  if (!allowed) throw new ApiError(403, forbidden)
}

export const requireManagement = (ctx: ActivitiesCtx) => check(isManagement(ctx.env.DB, ctx.userId), 'tindakan ini untuk pengurusan sahaja')
export const requireManager = (ctx: ActivitiesCtx) => check(atLeastRole(ctx.env.DB, ctx.userId, 'manager'), 'tindakan ini untuk manager ke atas sahaja')

const isFkError = (err: unknown) => String(err).includes('FOREIGN KEY constraint failed')

function notify(ctx: ActivitiesCtx, msg: Omit<NotifyMessage, 'type' | 'recipientIds' | 'actorId'>, recipients: () => Promise<string[]>) {
  ctx.waitUntil(
    (async () => enqueueNotify(ctx.deps.enqueue, ctx.env, { ...msg, actorId: ctx.userId }, await recipients()))().catch((err) =>
      console.error(JSON.stringify({ level: 'error', msg: 'notify aktiviti gagal', kind: msg.kind, activity: msg.activityId, error: String(err) })),
    ),
  )
}

// ---- kategori ----

export async function listCategories(ctx: ActivitiesCtx, all: boolean) {
  if (all) await requireManager(ctx)
  return { categories: (await repo.listCategories(ctx.env.DB, all)).map(categoryDto) }
}

const categorySnapshot = (c: Category) => ({ key: c.key, name: c.name, sort_order: c.sort_order, is_active: c.is_active === 1 })

export async function createCategory(ctx: ActivitiesCtx, input: { key: string; name: string; sort_order: number }) {
  const key = input.key.trim()
  const name = input.name.trim()
  if (!/^[a-z][a-z0-9_]{1,49}$/.test(key)) throw new ApiError(400, 'kunci kategori mesti huruf kecil, nombor dan garis bawah sahaja')
  if (!name) throw new ApiError(400, 'nama kategori diperlukan')
  const db = ctx.env.DB
  const id = uuid()
  const snapshot = { key, name, sort_order: input.sort_order, is_active: true }
  const [res] = await db.batch([
    repo.createCategoryStmt(db, { id, key, name, sortOrder: input.sort_order, now: ctx.now }),
    auditStmt(db, { entityType: 'activity_category', entityId: id, action: 'create', actor: ctx.actor, new: snapshot }, { sql: 'EXISTS (SELECT 1 FROM activity_categories WHERE id = ?)', params: [id] })!,
  ])
  const row = res!.results[0] as Category | undefined
  if (!row) throw new ApiError(409, 'kunci kategori sudah wujud')
  return categoryDto(row)
}

export async function updateCategory(ctx: ActivitiesCtx, id: string, input: { name?: string | null; sort_order?: number | null; is_active?: boolean | null; updated_at: string }) {
  let name = input.name ?? null
  if (name !== null) {
    name = name.trim()
    if (!name) throw new ApiError(400, 'nama kategori tidak boleh kosong')
  }
  const expected = expectedUpdatedAt(input.updated_at)
  const db = ctx.env.DB
  const before = await repo.getCategory(db, id)
  if (!before) throw new ApiError(404, 'kategori tidak dijumpai')
  const after = { ...before, name: name ?? before.name, sort_order: input.sort_order ?? before.sort_order, is_active: input.is_active == null ? before.is_active : Number(input.is_active) }
  const audit = auditStmt(
    db,
    { entityType: 'activity_category', entityId: id, action: 'update', actor: ctx.actor, old: categorySnapshot(before), new: categorySnapshot(after) },
    { sql: 'EXISTS (SELECT 1 FROM activity_categories WHERE id = ? AND updated_at = ?)', params: [id, ctx.now] },
  )
  const stmt = repo.updateCategoryStmt(db, id, { name, sortOrder: input.sort_order ?? null, isActive: input.is_active ?? null }, expected, ctx.now)
  const [res] = await db.batch(audit ? [stmt, audit] : [stmt])
  const row = res!.results[0] as Category | undefined
  if (!row) throw staleWrite('kategori telah berubah. Muat semula sebelum menyunting lagi.')
  return categoryDto(row)
}

// ---- baca ----

export async function list(
  ctx: ActivitiesCtx,
  q: { status?: string; category_id?: string; upcoming?: string; limit?: string; cursor?: string },
) {
  let statuses = DEFAULT_STATUSES
  if (q.status) {
    statuses = q.status.split(',')
    for (const s of statuses) {
      if (!STATUSES.has(s)) throw new ApiError(400, 'status tidak sah')
      if (s === 'draft') await requireManagement(ctx)
    }
  }
  let categoryId: string | null = null
  if (q.category_id) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q.category_id)) throw new ApiError(400, 'kategori tidak sah')
    categoryId = q.category_id.toLowerCase()
  }
  let upcoming = true
  if (q.upcoming) {
    // strconv.ParseBool
    if (['1', 't', 'T', 'TRUE', 'true', 'True'].includes(q.upcoming)) upcoming = true
    else if (['0', 'f', 'F', 'FALSE', 'false', 'False'].includes(q.upcoming)) upcoming = false
    else throw new ApiError(400, 'parameter upcoming tidak sah')
  }
  // 400, bukan jatuh senyap ke lalai (pariti marc_go).
  let limit = 20
  if (q.limit) {
    limit = /^[+-]?\d+$/.test(q.limit) ? Number(q.limit) : NaN
    if (!(limit >= 1 && limit <= 100)) throw new ApiError(400, 'parameter limit mesti antara 1 dan 100')
  }
  const after = q.cursor ? decodeCursor(q.cursor) : null
  if (q.cursor && !after) throw new ApiError(400, 'cursor tidak sah')

  const rows = await repo.listActivities(ctx.env.DB, { statuses, categoryId, upcoming, after, limit, now: ctx.now })
  const last = rows.at(-1)
  return {
    activities: rows.map((r) => ({ ...activityDto(r), registration_count: r.registration_count })),
    next_cursor: rows.length === limit && last ? encodeCursor(last.starts_at, last.id) : null,
  }
}

async function detail(ctx: ActivitiesCtx, row: ActivityRow) {
  const x = await repo.detailExtras(ctx.env.DB, row.id, ctx.userId)
  return { ...activityDto(row), sessions: x.sessions.map(sessionDto), registration_count: x.registrationCount, is_registered: x.isRegistered }
}

// Setiap mutasi memulangkan bentuk GET /activities/:id.
async function respond(ctx: ActivitiesCtx, id: string) {
  const row = await repo.getActivity(ctx.env.DB, id)
  if (!row) throw new ApiError(500, 'aktiviti disimpan tetapi gagal dimuat semula')
  return detail(ctx, row)
}

export async function get(ctx: ActivitiesCtx, id: string) {
  const row = await repo.getActivity(ctx.env.DB, id)
  if (!row) throw new ApiError(404, NOT_FOUND)
  if (row.status === 'draft') {
    let ok: boolean
    try {
      ok = await isManagement(ctx.env.DB, ctx.userId)
    } catch {
      throw new ApiError(500, 'gagal semak kebenaran')
    }
    if (!ok) throw new ApiError(404, NOT_FOUND)
  }
  return detail(ctx, row)
}

// ---- tulis (pengurusan) ----

function validateSessions(sessions: SessionInput[]) {
  if (!sessions.length) throw new ApiError(400, NO_SESSIONS)
  const seen = new Set<number>()
  for (const s of sessions) {
    if (s.ends_at <= s.starts_at) throw new ApiError(400, 'masa tamat sesi mesti selepas masa mula')
    if (seen.has(s.seq)) throw new ApiError(400, 'nombor urutan sesi mesti unik')
    seen.add(s.seq)
  }
}

const span = (sessions: SessionInput[]) => ({ startsAt: Math.min(...sessions.map((s) => s.starts_at)), endsAt: Math.max(...sessions.map((s) => s.ends_at)) })

export async function create(ctx: ActivitiesCtx, input: CreateActivity) {
  const threshold = input.attendance_threshold_pct || 100
  if (threshold < 1 || threshold > 100) throw new ApiError(400, 'ambang kehadiran mesti antara 1 dan 100 peratus')
  if (input.fee_cents < 0) throw new ApiError(400, 'yuran tidak boleh negatif')
  if (input.capacity != null && input.capacity <= 0) throw new ApiError(400, 'kapasiti mesti lebih daripada sifar')
  validateSessions(input.sessions)

  const db = ctx.env.DB
  const id = uuid()
  const { startsAt, endsAt } = span(input.sessions)
  const row = {
    categoryId: input.category_id,
    title: input.title,
    description: input.description,
    locationName: input.location_name,
    locationAddress: input.location_address,
    // Sementara (NOT NULL); recomputeWindowStmt satu-satunya penulis sebenar.
    startsAt: input.sessions[0]!.starts_at,
    endsAt: input.sessions[0]!.ends_at,
    opensAt: input.registration_opens_at ?? null,
    closesAt: input.registration_closes_at,
    capacity: input.capacity ?? null,
    feeCents: input.fee_cents,
    thresholdPct: threshold,
    createdBy: ctx.userId,
    now: ctx.now,
  }
  const snapshot: Record<string, unknown> = {
    category_id: row.categoryId,
    title: row.title,
    description: row.description,
    location_name: row.locationName,
    location_address: row.locationAddress,
    starts_at: new Date(startsAt).toISOString(),
    ends_at: new Date(endsAt).toISOString(),
    registration_closes_at: new Date(row.closesAt).toISOString(),
    fee_cents: row.feeCents,
    attendance_threshold_pct: threshold,
    status: 'draft',
    ...(row.opensAt !== null && { registration_opens_at: new Date(row.opensAt).toISOString() }),
    ...(row.capacity !== null && { capacity: row.capacity }),
  }
  try {
    await db.batch([
      repo.createActivityStmt(db, { id, ...row }),
      ...input.sessions.map((s) => repo.insertSessionStmt(db, uuid(), id, s)),
      repo.recomputeWindowStmt(db, id, ctx.now),
      auditStmt(db, { entityType: 'activity', entityId: id, action: 'create', actor: ctx.actor, new: snapshot })!,
    ])
  } catch (err) {
    if (isFkError(err)) throw new ApiError(400, 'kategori tidak dijumpai')
    throw err
  }
  return respond(ctx, id)
}

// Gabung PATCH ke atas baris sedia ada (pariti updateActivityRequest.merge).
function merge(before: ActivityRow, r: UpdateActivity): ActivityRow {
  const out = { ...before }
  const notNull = <K extends keyof ActivityRow & keyof UpdateActivity>(field: K) => {
    const v = r[field]
    if (v === undefined) return
    if (v === null) throw new ApiError(400, `medan ${field} tidak boleh null`)
    ;(out as Record<string, unknown>)[field] = v
  }
  for (const f of ['category_id', 'title', 'description', 'location_name', 'location_address', 'fee_cents', 'attendance_threshold_pct', 'registration_closes_at'] as const) notNull(f)
  // Nullable: null eksplisit bermakna "buang tarikh buka" / "tiada had".
  if (r.registration_opens_at !== undefined) out.registration_opens_at = r.registration_opens_at
  if (r.capacity !== undefined) out.capacity = r.capacity

  if (r.title !== undefined && !out.title.trim()) throw new ApiError(400, 'medan title tidak boleh kosong')
  if (r.location_name !== undefined && !out.location_name.trim()) throw new ApiError(400, 'medan location_name tidak boleh kosong')
  if (out.attendance_threshold_pct < 1 || out.attendance_threshold_pct > 100) throw new ApiError(400, 'ambang kehadiran mesti antara 1 dan 100 peratus')
  if (out.fee_cents < 0) throw new ApiError(400, 'yuran tidak boleh negatif')
  if (out.capacity !== null && out.capacity <= 0) throw new ApiError(400, 'kapasiti mesti lebih daripada sifar')
  return out
}

const LIMITS = [
  ['title', 200, 'tajuk terlalu panjang (maksimum 200 aksara)'],
  ['location_name', 300, 'nama lokasi terlalu panjang (maksimum 300 aksara)'],
  ['description', 2000, 'keterangan terlalu panjang (maksimum 2000 aksara)'],
  ['location_address', 500, 'alamat lokasi terlalu panjang (maksimum 500 aksara)'],
] as const

export async function update(ctx: ActivitiesCtx, id: string, input: UpdateActivity) {
  const db = ctx.env.DB
  const before = await repo.getActivity(db, id)
  if (!before) throw new ApiError(404, NOT_FOUND)
  const after = merge(before, input)
  for (const [field, max, message] of LIMITS) if ([...after[field]].length > max) throw new ApiError(400, message)

  const audit = auditStmt(
    db,
    { entityType: 'activity', entityId: id, action: 'update', actor: ctx.actor, old: activitySnapshot(before), new: activitySnapshot(after) },
    { sql: 'EXISTS (SELECT 1 FROM activities WHERE id = ? AND updated_at = ?)', params: [id, ctx.now] },
  )
  const stmt = repo.updateActivityStmt(db, id, after, before.updated_at, ctx.now)
  let res: D1Result | undefined
  try {
    ;[res] = await db.batch(audit ? [stmt, audit] : [stmt])
  } catch (err) {
    if (isFkError(err)) throw new ApiError(400, 'kategori tidak dijumpai')
    throw err
  }
  // Hanya berlaku bila dua PATCH berlumba (marc_go menyerikan dengan FOR UPDATE).
  if (!res?.results.length) throw staleWrite('aktiviti telah berubah. Muat semula sebelum menyunting lagi.')
  return respond(ctx, id)
}

export async function publish(ctx: ActivitiesCtx, id: string) {
  const db = ctx.env.DB
  const before = await repo.getActivity(db, id)
  if (!before) throw new ApiError(404, NOT_FOUND)
  if (before.status !== 'draft') throw new ApiError(409, 'hanya aktiviti draf boleh diterbitkan')
  if (!(await repo.hasSessions(db, id))) throw new ApiError(400, NO_SESSIONS)
  const [res] = await db.batch([
    repo.publishStmt(db, id, ctx.now),
    auditStmt(
      db,
      { entityType: 'activity', entityId: id, action: 'update', actor: ctx.actor, old: { status: before.status }, new: { status: 'published' } },
      { sql: "EXISTS (SELECT 1 FROM activities WHERE id = ? AND status = 'published' AND updated_at = ?)", params: [id, ctx.now] },
    )!,
  ])
  if (!res?.results.length) throw new ApiError(409, 'hanya aktiviti draf boleh diterbitkan') // kalah perlumbaan
  notify(ctx, { kind: 'activity_published', activityId: id, push: { title: 'Aktiviti Baharu', message: before.title } }, () => listApprovedUserIds(db))
  return respond(ctx, id)
}

export async function cancel(ctx: ActivitiesCtx, id: string, rawReason: string) {
  const reason = rawReason.trim()
  if (!reason) throw new ApiError(400, 'sebab pembatalan diperlukan')
  const db = ctx.env.DB
  const before = await repo.getActivity(db, id)
  if (!before) throw new ApiError(404, NOT_FOUND)
  if (before.status === 'cancelled') throw new ApiError(409, 'aktiviti ini sudah dibatalkan')
  const [res] = await db.batch([
    repo.cancelStmt(db, id, reason, ctx.now),
    auditStmt(
      db,
      {
        entityType: 'activity',
        entityId: id,
        action: 'update',
        actor: ctx.actor,
        old: { status: before.status, cancelled_reason: before.cancelled_reason ?? '' },
        new: { status: 'cancelled', cancelled_reason: reason },
      },
      { sql: "EXISTS (SELECT 1 FROM activities WHERE id = ? AND status = 'cancelled' AND updated_at = ?)", params: [id, ctx.now] },
    )!,
  ])
  if (!res?.results.length) throw new ApiError(409, 'aktiviti ini sudah dibatalkan')
  // Kepada yang BERDAFTAR sahaja - bukan siaran seluruh kelab.
  notify(ctx, { kind: 'activity_cancelled', activityId: id, push: { title: 'Aktiviti Dibatalkan', message: `${before.title} telah dibatalkan: ${reason}` } }, () => repo.registrantIds(db, id))
  return respond(ctx, id)
}

// Ganti KESELURUHAN set sesi dalam satu batch; tetingkap dikira semula.
export async function replaceSessions(ctx: ActivitiesCtx, id: string, sessions: SessionInput[]) {
  const db = ctx.env.DB
  if (!(await repo.getActivity(db, id))) throw new ApiError(404, NOT_FOUND)
  validateSessions(sessions)
  const before = (await repo.listSessionsStmt(db, id).all<{ seq: number; title: string; starts_at: number; ends_at: number }>()).results
  const ids = sessions.map(() => uuid())
  const results = await db.batch([
    repo.deleteSessionsStmt(db, id),
    ...sessions.map((s, i) => repo.insertSessionStmt(db, ids[i]!, id, s)),
    repo.recomputeWindowStmt(db, id, ctx.now),
    auditStmt(
      db,
      { entityType: 'activity', entityId: id, action: 'update', actor: ctx.actor, old: { sessions: sessionsSnapshot(before) }, new: { sessions: sessionsSnapshot([...sessions].sort((a, b) => a.seq - b.seq)) } },
      { sql: 'EXISTS (SELECT 1 FROM activity_sessions WHERE id = ?)', params: [ids[0]] },
    )!,
  ])
  if (!results[1]?.results.length) {
    if (!(await repo.getActivity(db, id))) throw new ApiError(404, NOT_FOUND)
    throw new ApiError(409, 'sesi yang sudah ada kehadiran tidak boleh diganti')
  }
  const { results: rows } = await repo.listSessionsStmt(db, id).all<repo.SessionRow>()
  return { sessions: rows.map(sessionDto) }
}
