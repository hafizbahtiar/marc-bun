// SQL milik features/registrations: activity_registrations, activity_attendances.
// Baris aktiviti/sesi dibaca melalui JOIN FK (cross-read: activities,
// activity_sessions, activity_categories, profiles).

export type Registration = {
  id: string
  activity_id: string
  user_id: string
  status: string
  payment_status: string
  payment_ref: string | null
  checkin_token: string
  registered_at: number
  cancelled_at: number | null
  fee_cents_paid: number | null
}

export const CHECKIN_PADDING_MS = 2 * 3600_000

// Kapasiti + tetingkap + status dalam SATU statement (R1) - tiada kunci.
// Indeks unik separa menolak daftar berganda (ON CONFLICT → tiada baris).
export const registerStmt = (db: D1Database, r: { id: string; activityId: string; userId: string; token: string; now: number }) =>
  db
    .prepare(
      `INSERT INTO activity_registrations (id, activity_id, user_id, status, payment_status, checkin_token, registered_at)
       SELECT ?1, a.id, ?2, 'registered', CASE WHEN a.fee_cents > 0 THEN 'pending' ELSE 'not_required' END, ?3, ?4
       FROM activities a
       WHERE a.id = ?5 AND a.deleted_at IS NULL AND a.status = 'published'
         AND (a.registration_opens_at IS NULL OR ?4 >= a.registration_opens_at) AND ?4 <= a.registration_closes_at
         AND (a.capacity IS NULL OR (SELECT COUNT(*) FROM activity_registrations x WHERE x.activity_id = a.id AND x.status <> 'cancelled') < a.capacity)
       ON CONFLICT DO NOTHING
       RETURNING *`,
    )
    .bind(r.id, r.userId, r.token, r.now, r.activityId)

export const activeRegistration = (db: D1Database, activityId: string, userId: string) =>
  db.prepare("SELECT * FROM activity_registrations WHERE activity_id = ? AND user_id = ? AND status <> 'cancelled'").bind(activityId, userId).first<Registration>()

export const getRegistration = (db: D1Database, id: string) => db.prepare('SELECT * FROM activity_registrations WHERE id = ?').bind(id).first<Registration>()

export const byCheckinToken = (db: D1Database, token: string) =>
  db.prepare("SELECT * FROM activity_registrations WHERE checkin_token = ? AND status <> 'cancelled'").bind(token).first<Registration>()

// Tidak boleh batal selepas aktiviti tamat (L15) - guard dalam SQL.
export const cancelStmt = (db: D1Database, activityId: string, userId: string, now: number) =>
  db
    .prepare(
      `UPDATE activity_registrations SET status = 'cancelled', cancelled_at = ?3
       WHERE activity_id = ?1 AND user_id = ?2 AND status <> 'cancelled'
         AND EXISTS (SELECT 1 FROM activities a WHERE a.id = ?1 AND a.ends_at > ?3)
       RETURNING *`,
    )
    .bind(activityId, userId, now)
    .first<Registration>()

export type ActivityGlance = { status: string; ends_at: number; registration_opens_at: number | null; registration_closes_at: number }

export const activity = (db: D1Database, id: string) =>
  db.prepare('SELECT status, ends_at, registration_opens_at, registration_closes_at FROM activities WHERE id = ? AND deleted_at IS NULL').bind(id).first<ActivityGlance>()

// checkin_token SENGAJA tiada (L12): kelayakan kehadiran ahli lain.
export async function listForActivity(db: D1Database, activityId: string) {
  const { results } = await db
    .prepare(
      `SELECT r.id, r.activity_id, r.user_id, r.status, r.payment_status, r.payment_ref, r.fee_cents_paid, r.registered_at, r.cancelled_at,
         pr.member_id, pr.display_name, pr.avatar_r2_key,
         (SELECT json_group_array(session_id) FROM (
            SELECT at.session_id FROM activity_attendances at JOIN activity_sessions s ON s.id = at.session_id
            WHERE at.registration_id = r.id ORDER BY s.seq)) AS attended_session_ids
       FROM activity_registrations r JOIN profiles pr ON pr.user_id = r.user_id
       WHERE r.activity_id = ? AND r.status <> 'cancelled'
       ORDER BY pr.display_name IS NULL, pr.display_name`,
    )
    .bind(activityId)
    .all<Omit<Registration, 'checkin_token'> & { member_id: string | null; display_name: string | null; avatar_r2_key: string | null; attended_session_ids: string }>()
  return results
}

// Yuran: snapshot dibayar, jatuh balik ke yuran semasa.
export async function listMine(db: D1Database, userId: string) {
  const { results } = await db
    .prepare(
      `SELECT r.*, a.title, a.starts_at, a.ends_at, a.status AS activity_status, c.name AS category_name,
         COALESCE(r.fee_cents_paid, a.fee_cents) AS fee_cents, a.currency
       FROM activity_registrations r JOIN activities a ON a.id = r.activity_id JOIN activity_categories c ON c.id = a.category_id
       WHERE r.user_id = ? AND r.status <> 'cancelled' AND a.deleted_at IS NULL
       ORDER BY a.starts_at DESC`,
    )
    .bind(userId)
    .all<Registration & { title: string; starts_at: number; ends_at: number; activity_status: string; category_name: string; fee_cents: number; currency: string }>()
  return results
}

// ---- kehadiran ----

// Semua syarat dalam WHERE: pendaftaran aktif, sesi milik aktiviti yang sama,
// aktiviti belum dipadam, tetingkap (kecuali pindaan). Ulang = tiada baris.
export const markStmt = (db: D1Database, a: { id: string; registrationId: string; sessionId: string; method: string; markedBy: string; now: number; amend: boolean }) =>
  db
    .prepare(
      `INSERT INTO activity_attendances (id, registration_id, session_id, method, marked_by, checked_in_at)
       SELECT ?1, r.id, s.id, ?2, ?3, ?4
       FROM activity_registrations r
       JOIN activity_sessions s ON s.activity_id = r.activity_id
       JOIN activities a ON a.id = s.activity_id AND a.deleted_at IS NULL
       WHERE r.id = ?5 AND s.id = ?6 AND r.status <> 'cancelled'
         AND (?7 OR ?4 BETWEEN s.starts_at - ?8 AND s.ends_at + ?8)
       ON CONFLICT DO NOTHING
       RETURNING id`,
    )
    .bind(a.id, a.method, a.markedBy, a.now, a.registrationId, a.sessionId, a.amend ? 1 : 0, CHECKIN_PADDING_MS)

export const session = (db: D1Database, id: string) =>
  db
    .prepare('SELECT s.activity_id, s.starts_at, s.ends_at, a.deleted_at IS NULL AS live FROM activity_sessions s LEFT JOIN activities a ON a.id = s.activity_id WHERE s.id = ?')
    .bind(id)
    .first<{ activity_id: string; starts_at: number; ends_at: number; live: number }>()

export const getAttendance = (db: D1Database, registrationId: string, sessionId: string) =>
  db.prepare('SELECT * FROM activity_attendances WHERE registration_id = ? AND session_id = ?').bind(registrationId, sessionId).first<{ id: string; method: string; checked_in_at: number }>()

export const deleteAttendanceStmt = (db: D1Database, id: string) => db.prepare('DELETE FROM activity_attendances WHERE id = ? RETURNING id').bind(id)

// cross-read: profiles (paparan skrin pengimbas)
export const memberOf = (db: D1Database, userId: string) =>
  db.prepare('SELECT display_name, member_id FROM profiles WHERE user_id = ?').bind(userId).first<{ display_name: string | null; member_id: string | null }>()
