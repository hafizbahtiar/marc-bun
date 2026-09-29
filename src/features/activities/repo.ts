// SQL milik features/activities: activity_categories, activities, activity_sessions.
import type { SessionInput } from './schema'

export type Category = { id: string; key: string; name: string; sort_order: number; is_active: number; created_at: number; updated_at: number }

export type ActivityRow = {
  id: string
  category_id: string
  title: string
  description: string
  location_name: string
  location_address: string
  starts_at: number
  ends_at: number
  registration_opens_at: number | null
  registration_closes_at: number
  capacity: number | null
  fee_cents: number
  currency: string
  attendance_threshold_pct: number
  status: string
  cancelled_reason: string | null
  certificates_issued_at: number | null
  created_by: string | null
  created_at: number
  updated_at: number
  deleted_at: number | null
  reminder_sent_at: number | null
  category_key: string
  category_name: string
}

export type SessionRow = { id: string; activity_id: string; seq: number; title: string; starts_at: number; ends_at: number }

// ---- kategori ----

export async function listCategories(db: D1Database, all: boolean): Promise<Category[]> {
  const { results } = await db.prepare(`SELECT * FROM activity_categories ${all ? '' : 'WHERE is_active = 1'} ORDER BY sort_order, name`).all<Category>()
  return results
}

export const getCategory = (db: D1Database, id: string) => db.prepare('SELECT * FROM activity_categories WHERE id = ?').bind(id).first<Category>()

// Kunci pendua → tiada baris (409).
export const createCategoryStmt = (db: D1Database, c: { id: string; key: string; name: string; sortOrder: number; now: number }) =>
  db
    .prepare('INSERT INTO activity_categories (id, key, name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (key) DO NOTHING RETURNING *')
    .bind(c.id, c.key, c.name, c.sortOrder, c.now, c.now)

// `key` tidak boleh diubah (pengecam stabil). CAS updated_at.
export const updateCategoryStmt = (
  db: D1Database,
  id: string,
  p: { name: string | null; sortOrder: number | null; isActive: boolean | null },
  expected: number,
  now: number,
) =>
  db
    .prepare(
      `UPDATE activity_categories SET name = COALESCE(?, name), sort_order = COALESCE(?, sort_order), is_active = COALESCE(?, is_active), updated_at = ?
       WHERE id = ? AND updated_at = ? RETURNING *`,
    )
    .bind(p.name, p.sortOrder, p.isActive === null ? null : Number(p.isActive), now, id, expected)

// ---- aktiviti ----

const SELECT = `SELECT a.*, c.key AS category_key, c.name AS category_name FROM activities a JOIN activity_categories c ON c.id = a.category_id`
// cross-read: activity_registrations (kiraan)
const REG_COUNT = `(SELECT COUNT(*) FROM activity_registrations r WHERE r.activity_id = a.id AND r.status <> 'cancelled')`

export const getActivity = (db: D1Database, id: string) => db.prepare(`${SELECT} WHERE a.id = ? AND a.deleted_at IS NULL`).bind(id).first<ActivityRow>()

export async function listActivities(
  db: D1Database,
  q: { statuses: string[]; categoryId: string | null; upcoming: boolean; after: { createdAt: number; id: string } | null; limit: number; now: number },
): Promise<(ActivityRow & { registration_count: number })[]> {
  const [cmp, dir] = q.upcoming ? ['>', 'ASC'] : ['<', 'DESC']
  const where = [
    'a.deleted_at IS NULL',
    'a.status IN (SELECT value FROM json_each(?))',
    '(? IS NULL OR a.category_id = ?)',
    q.upcoming ? 'a.ends_at >= ?' : 'a.ends_at < ?',
    ...(q.after ? [`(a.starts_at, a.id) ${cmp} (?, ?)`] : []),
  ]
  const params = [JSON.stringify(q.statuses), q.categoryId, q.categoryId, q.now, ...(q.after ? [q.after.createdAt, q.after.id] : []), q.limit]
  const { results } = await db
    .prepare(`SELECT a.*, c.key AS category_key, c.name AS category_name, ${REG_COUNT} AS registration_count
       FROM activities a JOIN activity_categories c ON c.id = a.category_id
       WHERE ${where.join(' AND ')} ORDER BY a.starts_at ${dir}, a.id ${dir} LIMIT ?`)
    .bind(...params)
    .all<ActivityRow & { registration_count: number }>()
  return results
}

export async function detailExtras(db: D1Database, id: string, viewerId: string) {
  const [sessions, count, mine] = await db.batch([
    listSessionsStmt(db, id),
    db.prepare(`SELECT ${REG_COUNT} AS n FROM activities a WHERE a.id = ?`).bind(id),
    // cross-read: activity_registrations
    db.prepare("SELECT 1 FROM activity_registrations WHERE activity_id = ? AND user_id = ? AND status <> 'cancelled'").bind(id, viewerId),
  ])
  return {
    sessions: sessions!.results as SessionRow[],
    registrationCount: (count!.results[0] as { n: number } | undefined)?.n ?? 0,
    isRegistered: mine!.results.length > 0,
  }
}

export const listSessionsStmt = (db: D1Database, activityId: string) => db.prepare('SELECT * FROM activity_sessions WHERE activity_id = ? ORDER BY seq').bind(activityId)

export const createActivityStmt = (db: D1Database, a: { id: string; categoryId: string; title: string; description: string; locationName: string; locationAddress: string; startsAt: number; endsAt: number; opensAt: number | null; closesAt: number; capacity: number | null; feeCents: number; thresholdPct: number; createdBy: string; now: number }) =>
  db
    .prepare(
      `INSERT INTO activities (id, category_id, title, description, location_name, location_address, starts_at, ends_at,
         registration_opens_at, registration_closes_at, capacity, fee_cents, attendance_threshold_pct, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(a.id, a.categoryId, a.title, a.description, a.locationName, a.locationAddress, a.startsAt, a.endsAt, a.opensAt, a.closesAt, a.capacity, a.feeCents, a.thresholdPct, a.createdBy, a.now, a.now)

// Satu-satunya penulis starts_at/ends_at selepas cipta (invarian sesi).
export const recomputeWindowStmt = (db: D1Database, activityId: string, now: number) =>
  db
    .prepare(
      `UPDATE activities SET starts_at = (SELECT MIN(starts_at) FROM activity_sessions WHERE activity_id = ?1),
         ends_at = (SELECT MAX(ends_at) FROM activity_sessions WHERE activity_id = ?1), updated_at = ?2
       WHERE id = ?1 AND EXISTS (SELECT 1 FROM activity_sessions WHERE activity_id = ?1)`,
    )
    .bind(activityId, now)

// cross-read: activity_attendances. Sesi berkehadiran tidak boleh dibuang:
// padam DAN insert kedua-duanya bersyarat - bila ada kehadiran, keduanya
// no-op (tiada baris diinsert = 409), tiada perubahan separa.
const NO_ATTENDANCE = `NOT EXISTS (SELECT 1 FROM activity_attendances at JOIN activity_sessions s ON s.id = at.session_id WHERE s.activity_id = ?)`

export const deleteSessionsStmt = (db: D1Database, activityId: string) =>
  db.prepare(`DELETE FROM activity_sessions WHERE activity_id = ? AND ${NO_ATTENDANCE}`).bind(activityId, activityId)

export const insertSessionStmt = (db: D1Database, id: string, activityId: string, s: SessionInput) =>
  db
    .prepare(
      `INSERT INTO activity_sessions (id, activity_id, seq, title, starts_at, ends_at)
       SELECT ?, id, ?, ?, ?, ? FROM activities WHERE id = ? AND deleted_at IS NULL AND ${NO_ATTENDANCE} RETURNING id`,
    )
    .bind(id, s.seq, s.title, s.starts_at, s.ends_at, activityId, activityId)

// CAS pada updated_at baris yang dibaca (ganti kunci baris marc_go).
export const updateActivityStmt = (db: D1Database, id: string, a: ActivityRow, expected: number, now: number) =>
  db
    .prepare(
      `UPDATE activities SET category_id = ?, title = ?, description = ?, location_name = ?, location_address = ?,
         registration_opens_at = ?, registration_closes_at = ?, capacity = ?, fee_cents = ?, attendance_threshold_pct = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL AND updated_at = ? RETURNING id`,
    )
    .bind(a.category_id, a.title, a.description, a.location_name, a.location_address, a.registration_opens_at, a.registration_closes_at, a.capacity, a.fee_cents, a.attendance_threshold_pct, now, id, expected)

// Terbit: draf DAN ada sesi, dalam WHERE yang sama.
export const publishStmt = (db: D1Database, id: string, now: number) =>
  db
    .prepare(
      `UPDATE activities SET status = 'published', updated_at = ? WHERE id = ? AND deleted_at IS NULL AND status = 'draft'
         AND EXISTS (SELECT 1 FROM activity_sessions WHERE activity_id = activities.id) RETURNING id`,
    )
    .bind(now, id)

export const cancelStmt = (db: D1Database, id: string, reason: string, now: number) =>
  db.prepare("UPDATE activities SET status = 'cancelled', cancelled_reason = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL AND status <> 'cancelled' RETURNING id").bind(reason, now, id)

export const hasSessions = async (db: D1Database, id: string) => (await db.prepare('SELECT 1 FROM activity_sessions WHERE activity_id = ? LIMIT 1').bind(id).first()) !== null

// cross-read: activity_registrations (penerima notifikasi batal/peringatan)
export async function registrantIds(db: D1Database, activityId: string): Promise<string[]> {
  const { results } = await db.prepare("SELECT user_id FROM activity_registrations WHERE activity_id = ? AND status <> 'cancelled'").bind(activityId).all<{ user_id: string }>()
  return results.map((r) => r.user_id)
}

// ---- lifecycle ----

// Tuntut peringatan dalam SATU statement: dua cron serentak, satu menang.
export async function claimReminders(db: D1Database, now: number): Promise<{ id: string; title: string }[]> {
  const { results } = await db
    .prepare(
      `UPDATE activities SET reminder_sent_at = ?1
       WHERE status = 'published' AND reminder_sent_at IS NULL AND deleted_at IS NULL AND starts_at > ?1 AND starts_at <= ?1 + 86400000
       RETURNING id, title`,
    )
    .bind(now)
    .all<{ id: string; title: string }>()
  return results
}

// Pariti marc_go: tidak menyentuh updated_at.
export const completeEnded = (db: D1Database, now: number) => db.prepare("UPDATE activities SET status = 'completed' WHERE status = 'published' AND ends_at < ?").bind(now).run()

// Untuk features/certificates (pemilik lajur = activities).
export const markCertificatesIssuedStmt = (db: D1Database, id: string, now: number) =>
  db.prepare('UPDATE activities SET certificates_issued_at = ?, updated_at = ? WHERE id = ?').bind(now, now, id)
