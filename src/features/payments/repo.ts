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
