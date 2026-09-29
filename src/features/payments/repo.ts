// SQL milik features/payments: donations, registration_payments, payment_logs.
// Fasa 3 hanya perlukan detach untuk pemadaman akaun; selebihnya Fasa 7.

// Sebelum `users` dipadam (FK SET NULL pada donations.user_id): salin emel
// akaun ke donor_email yang kosong, supaya rekod kewangan kekal boleh dijejak
// DAN `donations_traceable` tidak menggagalkan pemadaman. (marc_go: pemadaman
// ahli yang pernah menderma semasa log masuk gagal 500 - donor_email NULL.)
export const detachDonationsStmt = (db: D1Database, userId: string, guard: { sql: string; params: unknown[] }) =>
  db
    .prepare(
      // cross-read: users (emel akaun)
      `UPDATE donations SET donor_email = COALESCE(NULLIF(donor_email, ''), (SELECT email FROM users WHERE id = ?))
       WHERE user_id = ? AND ${guard.sql}`,
    )
    .bind(userId, userId, ...guard.params)

// Yuran pendaftaran tertunggak (sen) atau NULL - SATU sumber untuk /dashboard
// dan /me/payments (pariti outstandingRegistrationFee + staffFeeExempt +
// latestPendingRegistrationFeeCents marc_go). Amaun = bil `pending` TERBARU
// (snapshot), jatuh balik kepada fi semasa bila tiada bil.
// cross-read: profiles (pengecualian staf)
export const outstandingFeeStmt = (db: D1Database, userId: string, feeCents: number) =>
  db
    .prepare(
      `SELECT CASE
         WHEN p.staff_id_verified_at IS NOT NULL OR (p.staff_id <> '' AND p.staff_id <> p.user_id) THEN NULL
         WHEN EXISTS (SELECT 1 FROM registration_payments WHERE user_id = p.user_id AND status = 'succeeded') THEN NULL
         ELSE COALESCE((SELECT amount_cents FROM registration_payments WHERE user_id = p.user_id AND status = 'pending' ORDER BY created_at DESC LIMIT 1), ?)
       END AS cents
       FROM profiles p WHERE p.user_id = ?`,
    )
    .bind(feeCents, userId)

// ---- payment_logs (best-effort; raw_payload tidak pernah didedahkan) ----

export type LogEntry = {
  module: 'donation' | 'registration_fee' | 'activity_fee'
  event: string
  status: string
  gateway: string
  gatewayRef?: string
  amountCents?: number
  userId?: string | null
  relatedId?: string
  message?: string
  rawPayload?: string
}

// Kegagalan log tidak pernah menggagalkan aliran bayaran.
export async function log(db: D1Database, e: LogEntry): Promise<void> {
  await db
    .prepare(
      `INSERT INTO payment_logs (module, event, status, gateway, gateway_ref, amount_cents, user_id, related_id, message, raw_payload)
       SELECT ?, ?, ?, ?, ?, ?, (SELECT id FROM users WHERE id = ?), ?, ?, ?`,
    )
    .bind(e.module, e.event, e.status, e.gateway, e.gatewayRef || null, e.amountCents ?? null, e.userId ?? null, e.relatedId ?? null, e.message || null, e.rawPayload || null)
    .run()
    .catch((err) => console.error(JSON.stringify({ level: 'error', msg: 'paymentlog gagal', module: e.module, event: e.event, error: String(err) })))
}

export type LogRow = { id: number; module: string; event: string; status: string; gateway: string; gateway_ref: string | null; amount_cents: number | null; user_id: string | null; related_id: string | null; message: string | null; created_at: number }

export async function listLogs(db: D1Database, modules: string[], beforeId: number | null, limit: number): Promise<LogRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, module, event, status, gateway, gateway_ref, amount_cents, user_id, related_id, message, created_at FROM payment_logs
       WHERE module IN (SELECT value FROM json_each(?)) AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`,
    )
    .bind(JSON.stringify(modules), beforeId, beforeId, limit)
    .all<LogRow>()
  return results
}

// ---- pembayar (cross-read: profiles, users) ----

export type Payer = { status: string; display_name: string | null; member_id: string | null; phone: string | null; email: string }

export const payer = (db: D1Database, userId: string) =>
  db.prepare('SELECT p.status, p.display_name, p.member_id, p.phone, u.email FROM profiles p JOIN users u ON u.id = p.user_id WHERE p.user_id = ?').bind(userId).first<Payer>()

// ---- donations ----

export type Donation = { id: string; user_id: string | null; donor_name: string | null; donor_email: string | null; amount_cents: number; currency: string; gateway: string; gateway_ref: string; status: string; created_at: number }

export const createDonation = (db: D1Database, d: Omit<Donation, 'status' | 'created_at'>, now: number) =>
  db
    .prepare("INSERT INTO donations (id, user_id, donor_name, donor_email, amount_cents, currency, gateway, gateway_ref, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)")
    .bind(d.id, d.user_id, d.donor_name, d.donor_email, d.amount_cents, d.currency, d.gateway, d.gateway_ref, now)
    .run()

// 'succeeded' terminal: replay webhook = tiada baris = tiada resit kedua.
export const updateDonationStatus = (db: D1Database, gateway: string, ref: string, status: string) =>
  db.prepare("UPDATE donations SET status = ? WHERE gateway = ? AND gateway_ref = ? AND status <> 'succeeded' RETURNING *").bind(status, gateway, ref).first<Donation>()

export async function myDonations(db: D1Database, userId: string): Promise<Donation[]> {
  const { results } = await db.prepare('SELECT * FROM donations WHERE user_id = ? ORDER BY created_at DESC').bind(userId).all<Donation>()
  return results
}

export const myDonation = (db: D1Database, id: string, userId: string) => db.prepare('SELECT * FROM donations WHERE id = ? AND user_id = ?').bind(id, userId).first<Donation>()

export async function pendingStripeDonations(db: D1Database, staleBefore: number, limit: number): Promise<Donation[]> {
  const { results } = await db
    .prepare("SELECT * FROM donations WHERE gateway = 'stripe' AND status = 'pending' AND created_at < ? ORDER BY created_at LIMIT ?")
    .bind(staleBefore, limit)
    .all<Donation>()
  return results
}

// ---- registration_payments ----

export type RegPayment = { id: string; user_id: string; amount_cents: number; currency: string; gateway: string; gateway_ref: string | null; status: string; created_at: number }

// L29: baris DITULIS DAHULU, bil kemudian - bil tidak pernah wujud tanpa baris.
export const createRegPayment = (db: D1Database, p: { id: string; userId: string; amountCents: number; gateway: string; now: number }) =>
  db.prepare("INSERT INTO registration_payments (id, user_id, amount_cents, currency, gateway, status, created_at) VALUES (?, ?, ?, 'myr', ?, 'pending', ?)").bind(p.id, p.userId, p.amountCents, p.gateway, p.now).run()

export const setRegPaymentRef = (db: D1Database, id: string, ref: string) =>
  db.prepare('UPDATE registration_payments SET gateway_ref = ? WHERE id = ? AND gateway_ref IS NULL RETURNING id').bind(ref, id).first()

// Tiada bil wujud (ref NULL) → selamat ditanda gagal.
export const markRegPaymentFailedNoRef = (db: D1Database, id: string) => db.prepare("UPDATE registration_payments SET status = 'failed' WHERE id = ? AND gateway_ref IS NULL").bind(id)

export const updateRegPaymentStatusStmt = (db: D1Database, gateway: string, ref: string, status: string) =>
  db.prepare("UPDATE registration_payments SET status = ? WHERE gateway = ? AND gateway_ref = ? AND status <> 'succeeded' RETURNING *").bind(status, gateway, ref)

export const updateRegPaymentStatus = (db: D1Database, gateway: string, ref: string, status: string) => updateRegPaymentStatusStmt(db, gateway, ref, status).first<RegPayment>()

export const expireRegPaymentStmt = (db: D1Database, id: string) => db.prepare("UPDATE registration_payments SET status = 'failed' WHERE id = ? AND status = 'pending' RETURNING *").bind(id)

export const hasSucceededRegPayment = async (db: D1Database, userId: string) =>
  (await db.prepare("SELECT 1 FROM registration_payments WHERE user_id = ? AND status = 'succeeded' LIMIT 1").bind(userId).first()) !== null

export const latestPendingRegPayment = (db: D1Database, userId: string) =>
  db.prepare("SELECT * FROM registration_payments WHERE user_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1").bind(userId).first<RegPayment>()

export async function myRegPayments(db: D1Database, userId: string): Promise<RegPayment[]> {
  const { results } = await db.prepare('SELECT * FROM registration_payments WHERE user_id = ? ORDER BY created_at DESC').bind(userId).all<RegPayment>()
  return results
}

// cross-read: profiles, users
export const myRegPaymentForReceipt = (db: D1Database, id: string, userId: string) =>
  db
    .prepare(
      `SELECT rp.*, p.member_id, p.display_name, u.email FROM registration_payments rp
       JOIN profiles p ON p.user_id = rp.user_id JOIN users u ON u.id = rp.user_id WHERE rp.id = ? AND rp.user_id = ?`,
    )
    .bind(id, userId)
    .first<RegPayment & { member_id: string | null; display_name: string | null; email: string }>()

export async function pendingRegPayments(db: D1Database, staleBefore: number, oldest: number, limit: number): Promise<RegPayment[]> {
  const { results } = await db
    .prepare("SELECT * FROM registration_payments WHERE status = 'pending' AND gateway_ref IS NOT NULL AND created_at < ? AND created_at > ? ORDER BY created_at LIMIT ?")
    .bind(staleBefore, oldest, limit)
    .all<RegPayment>()
  return results
}

export async function stalePendingRegPayments(db: D1Database, cutoff: number, limit: number): Promise<RegPayment[]> {
  const { results } = await db.prepare("SELECT * FROM registration_payments WHERE status = 'pending' AND created_at < ? ORDER BY created_at LIMIT ?").bind(cutoff, limit).all<RegPayment>()
  return results
}

// ---- yuran aktiviti (cross-read: activity_registrations, activities, profiles, users) ----

export type ActivityFeeRow = {
  id: string
  activity_id: string
  user_id: string
  status: string
  payment_status: string
  payment_ref: string | null
  fee_cents_paid: number | null
  registered_at: number
  title: string
  fee_cents: number
  currency: string
  starts_at: number
}

// Sejarah TERMASUK yang dibatalkan (percubaan gagal kekal kelihatan).
export async function myActivityPayments(db: D1Database, userId: string): Promise<ActivityFeeRow[]> {
  const { results } = await db
    .prepare(
      `SELECT r.id, r.activity_id, r.user_id, r.status, r.payment_status, r.payment_ref, r.fee_cents_paid, r.registered_at,
         a.title, COALESCE(r.fee_cents_paid, a.fee_cents) AS fee_cents, a.currency, a.starts_at
       FROM activity_registrations r JOIN activities a ON a.id = r.activity_id
       WHERE r.user_id = ? AND r.payment_status <> 'not_required' ORDER BY r.registered_at DESC`,
    )
    .bind(userId)
    .all<ActivityFeeRow>()
  return results
}

export const myActivityFee = (db: D1Database, id: string, userId: string) =>
  db
    .prepare(
      `SELECT r.id, r.payment_status, r.payment_ref, r.registered_at, a.title, COALESCE(r.fee_cents_paid, a.fee_cents) AS fee_cents, a.currency,
         p.member_id, p.display_name, u.email
       FROM activity_registrations r JOIN activities a ON a.id = r.activity_id JOIN profiles p ON p.user_id = r.user_id JOIN users u ON u.id = r.user_id
       WHERE r.id = ? AND r.user_id = ?`,
    )
    .bind(id, userId)
    .first<{ id: string; payment_status: string; payment_ref: string | null; registered_at: number; title: string; fee_cents: number; currency: string; member_id: string | null; display_name: string | null; email: string }>()

export const activityForCheckout = (db: D1Database, id: string) =>
  db.prepare('SELECT id, title, fee_cents, currency FROM activities WHERE id = ? AND deleted_at IS NULL').bind(id).first<{ id: string; title: string; fee_cents: number; currency: string }>()

export async function pendingActivityPayments(db: D1Database, staleBefore: number, oldest: number, limit: number) {
  const { results } = await db
    .prepare(
      `SELECT id, user_id, payment_status, payment_ref FROM activity_registrations
       WHERE payment_status = 'pending' AND status <> 'cancelled' AND payment_ref IS NOT NULL AND registered_at < ? AND registered_at > ?
       ORDER BY registered_at LIMIT ?`,
    )
    .bind(staleBefore, oldest, limit)
    .all<{ id: string; user_id: string; payment_status: string; payment_ref: string }>()
  return results
}

// Retention (features/audit), berkeping.
export const prunePaymentLogsStmt = (db: D1Database, before: number, limit: number) =>
  db.prepare('DELETE FROM payment_logs WHERE id IN (SELECT id FROM payment_logs WHERE created_at < ? LIMIT ?)').bind(before, limit)
