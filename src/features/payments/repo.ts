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
