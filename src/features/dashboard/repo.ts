// Read-model skrin Utama: baca sahaja, tiada jadual milik.
// cross-read: profiles, roles, departments, activities, activity_categories,
// activity_sessions, activity_registrations, activity_attendances,
// activity_certificates, registration_payments, donations.

const n = (r: D1Result | undefined) => (r!.results[0] as { n: number }).n

export async function memberBlock(db: D1Database, userId: string, now: number, outstandingFee: D1PreparedStatement) {
  const [me, certs, total, open, fee] = await db.batch([
    db.prepare(
      `SELECT p.status, p.member_id, p.staff_id_verified_at,
         r.rank >= (SELECT rank FROM roles WHERE key = 'admin') AS is_admin,
         r.rank >= (SELECT rank FROM roles WHERE key = 'superadmin') AS is_superadmin
       FROM profiles p JOIN roles r ON r.id = p.role_id WHERE p.user_id = ?`,
    ).bind(userId),
    db.prepare('SELECT COUNT(*) AS n FROM activity_certificates WHERE user_id = ? AND revoked_at IS NULL').bind(userId),
    db.prepare("SELECT COUNT(*) AS n FROM profiles WHERE status = 'approved' AND is_active = 1"),
    // Aktiviti terbitan akan datang yang pemanggil BELUM daftar.
    db.prepare(
      `SELECT a.id, a.title, a.starts_at, c.name AS category_name, a.fee_cents, a.currency,
         (SELECT COUNT(*) FROM activity_registrations r2 WHERE r2.activity_id = a.id AND r2.status <> 'cancelled') AS registration_count
       FROM activities a JOIN activity_categories c ON c.id = a.category_id
       WHERE a.deleted_at IS NULL AND a.status = 'published' AND a.ends_at >= ?
         AND NOT EXISTS (SELECT 1 FROM activity_registrations r WHERE r.activity_id = a.id AND r.user_id = ? AND r.status <> 'cancelled')
       ORDER BY a.starts_at ASC LIMIT 3`,
    ).bind(now, userId),
    outstandingFee,
  ])
  return {
    me: me!.results[0] as { status: string; member_id: string | null; staff_id_verified_at: number | null; is_admin: number; is_superadmin: number },
    certificatesTotal: n(certs),
    totalMembers: n(total),
    open: open!.results as { id: string; title: string; starts_at: number; category_name: string; fee_cents: number; currency: string; registration_count: number }[],
    outstandingFeeCents: (fee!.results[0] as { cents: number | null } | undefined)?.cents ?? null,
  }
}

// `monthStart` = 1hb bulan semasa 00:00 MYT (marc_go: date_trunc zon sesi DB =
// UTC, jadi 1hb 00:00-07:59 MYT jatuh ke bulan lepas - dibetulkan).
export async function adminBlock(db: D1Database, now: number, monthStart: number, withDonations: boolean) {
  // Sesi yang SUDAH TAMAT dalam bulan ini (kadar tidak rendah palsu sepanjang bulan).
  const endedSessions = 'SELECT s.id FROM activity_sessions s WHERE s.ends_at >= ?1 AND s.ends_at < ?2'
  const [pending, active, fresh, depts, upcoming, regs, attended, expected, regRev, actRev, donRev] = await db.batch([
    db.prepare("SELECT COUNT(*) AS n FROM profiles WHERE status = 'pending'"),
    db.prepare("SELECT COUNT(*) AS n FROM profiles WHERE status = 'approved' AND is_active = 1"),
    db.prepare('SELECT COUNT(*) AS n FROM profiles WHERE approved_at >= ?').bind(monthStart),
    db.prepare(
      `SELECT COALESCE(d.code, '') AS code, COALESCE(d.name, 'Tiada bahagian') AS name, COUNT(*) AS count
       FROM profiles p LEFT JOIN departments d ON d.code = p.department_code
       WHERE p.status = 'approved' AND p.is_active = 1 GROUP BY d.code, d.name ORDER BY count DESC`,
    ),
    db.prepare("SELECT COUNT(*) AS n FROM activities WHERE deleted_at IS NULL AND status = 'published' AND ends_at >= ?").bind(now),
    db.prepare("SELECT COUNT(*) AS n FROM activity_registrations WHERE status <> 'cancelled' AND registered_at >= ?").bind(monthStart),
    db.prepare(`SELECT COUNT(*) AS n FROM activity_attendances WHERE session_id IN (${endedSessions})`).bind(monthStart, now),
    db.prepare(
      `SELECT COUNT(*) AS n FROM activity_registrations WHERE status <> 'cancelled'
         AND activity_id IN (SELECT s.activity_id FROM activity_sessions s WHERE s.ends_at >= ?1 AND s.ends_at < ?2)`,
    ).bind(monthStart, now),
    db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS n FROM registration_payments WHERE status = 'succeeded' AND created_at >= ?").bind(monthStart),
    // fee_cents_paid = snapshot amaun dibayar, bukan activities.fee_cents hidup.
    db.prepare("SELECT COALESCE(SUM(fee_cents_paid), 0) AS n FROM activity_registrations WHERE payment_status = 'paid' AND fee_cents_paid IS NOT NULL AND registered_at >= ?").bind(monthStart),
    withDonations
      ? db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS n FROM donations WHERE status = 'succeeded' AND created_at >= ?").bind(monthStart)
      : db.prepare('SELECT NULL AS n'),
  ])
  return {
    pending: n(pending),
    active: n(active),
    newThisMonth: n(fresh),
    departments: depts!.results as { code: string; name: string; count: number }[],
    upcoming: n(upcoming),
    registrationsThisMonth: n(regs),
    attended: n(attended),
    expected: n(expected),
    registrationCents: n(regRev),
    activityCents: n(actRev),
    donationCents: n(donRev) as number | null,
  }
}
