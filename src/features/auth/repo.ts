// SQL milik features/auth: users, refresh_tokens, email_verification_tokens,
// email_verification_sends, password_reset_tokens. Tiada peraturan di sini.

export type RefreshRow = { family_id: string; consumed_at: number | null; consumed_ip: string | null; expires_at: number }
export type SessionRow = { family_id: string; user_agent: string | null; created_ip: string | null; created_at: number; expires_at: number }
export type NewRefresh = { id: string; userId: string; hash: string; familyId: string; expiresAt: number; userAgent: string; ip: string }

// ---- users ----

export const findUserByEmail = (db: D1Database, email: string) =>
  db.prepare('SELECT id, password_hash FROM users WHERE email = ?').bind(email).first<{ id: string; password_hash: string }>()

export const findUserEmail = async (db: D1Database, id: string) =>
  (await db.prepare('SELECT email FROM users WHERE id = ?').bind(id).first<{ email: string }>())?.email ?? null

export const createUserStmt = (db: D1Database, u: { id: string; email: string; passwordHash: string }) =>
  db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)').bind(u.id, u.email, u.passwordHash)

// ---- refresh_tokens ----

export async function insertRefresh(db: D1Database, t: NewRefresh): Promise<void> {
  await db
    .prepare('INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at, user_agent, created_ip) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(t.id, t.userId, t.hash, t.familyId, t.expiresAt, t.userAgent, t.ip)
    .run()
}

// Rotasi sekali-guna ATOMIK: satu batch = satu transaksi. Kedua-dua statement
// berkongsi guard yang sama (belum digunakan, belum luput), jadi sama ada
// token lama digunakan DAN token baharu wujud, atau tiada apa berlaku. Dua
// permintaan serentak diserialkan - yang kedua tidak menemui baris.
export async function rotateRefresh(
  db: D1Database,
  oldHash: string,
  next: Omit<NewRefresh, 'userId' | 'familyId'>,
  now: number,
): Promise<{ user_id: string; family_id: string } | null> {
  const [, consumed] = await db.batch([
    db
      .prepare(
        `INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at, user_agent, created_ip)
         SELECT ?, user_id, ?, family_id, ?, ?, ? FROM refresh_tokens
         WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
      )
      .bind(next.id, next.hash, next.expiresAt, next.userAgent, next.ip, oldHash, now),
    db
      .prepare(
        `UPDATE refresh_tokens SET consumed_at = ?, consumed_ip = ?
         WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
         RETURNING user_id, family_id`,
      )
      .bind(now, next.ip, oldHash, now),
  ])
  return (consumed?.results[0] as { user_id: string; family_id: string } | undefined) ?? null
}

export const findRefresh = (db: D1Database, hash: string) =>
  db.prepare('SELECT family_id, consumed_at, consumed_ip, expires_at FROM refresh_tokens WHERE token_hash = ?').bind(hash).first<RefreshRow>()

export async function deleteFamily(db: D1Database, familyId: string): Promise<void> {
  await db.prepare('DELETE FROM refresh_tokens WHERE family_id = ?').bind(familyId).run()
}

// Log keluar SATU peranti = seluruh keluarga token itu.
export async function deleteFamilyOfToken(db: D1Database, hash: string): Promise<string | null> {
  const { results } = await db
    .prepare('DELETE FROM refresh_tokens WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = ?) RETURNING family_id')
    .bind(hash)
    .all<{ family_id: string }>()
  return results[0]?.family_id ?? null
}

export async function deleteAllRefreshForUser(db: D1Database, userId: string): Promise<void> {
  await db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').bind(userId).run()
}

export async function activeSessions(db: D1Database, userId: string, now: number): Promise<SessionRow[]> {
  const { results } = await db
    .prepare('SELECT family_id, user_agent, created_ip, created_at, expires_at FROM refresh_tokens WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC')
    .bind(userId, now)
    .all<SessionRow>()
  return results
}

// Pemilikan dalam query: keluarga ahli lain diabaikan senyap. Pulang bilangan
// BARIS token dipadam (pariti marc_go) + keluarga yang terjejas.
export async function deleteFamiliesForUser(db: D1Database, userId: string, familyIds: string[]) {
  const { results } = await db
    .prepare(`DELETE FROM refresh_tokens WHERE user_id = ? AND family_id IN (${familyIds.map(() => '?').join(', ')}) RETURNING family_id`)
    .bind(userId, ...familyIds)
    .all<{ family_id: string }>()
  return { rows: results.length, familyIds: [...new Set(results.map((r) => r.family_id))] }
}

// ---- email_verification_* ----

export async function verificationSendStats(db: D1Database, userId: string, since: number) {
  const row = await db
    .prepare('SELECT MAX(created_at) AS last, SUM(created_at > ?) AS recent FROM email_verification_sends WHERE user_id = ?')
    .bind(since, userId)
    .first<{ last: number | null; recent: number | null }>()
  return { last: row?.last ?? null, recent: row?.recent ?? 0 }
}

// Token baharu membunuh yang lama + catat penghantaran (untuk had).
export async function replaceVerificationToken(db: D1Database, t: { id: string; sendId: string; userId: string; hash: string; expiresAt: number; now: number }) {
  await db.batch([
    db.prepare('DELETE FROM email_verification_tokens WHERE user_id = ?').bind(t.userId),
    db.prepare('INSERT INTO email_verification_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)').bind(t.id, t.userId, t.hash, t.expiresAt),
    db.prepare('INSERT INTO email_verification_sends (id, user_id, created_at) VALUES (?, ?, ?)').bind(t.sendId, t.userId, t.now),
  ])
}

// Tuntutan sekali-guna: satu statement. Token luput turut dipadam (pariti).
export const claimVerificationToken = (db: D1Database, hash: string) =>
  db.prepare('DELETE FROM email_verification_tokens WHERE token_hash = ? RETURNING user_id, expires_at').bind(hash).first<{ user_id: string; expires_at: number }>()

export async function deleteVerificationTokensForUser(db: D1Database, userId: string): Promise<void> {
  await db.prepare('DELETE FROM email_verification_tokens WHERE user_id = ?').bind(userId).run()
}

// ---- password_reset_tokens ----

export async function replaceResetToken(db: D1Database, t: { id: string; userId: string; hash: string; expiresAt: number }) {
  await db.batch([
    db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').bind(t.userId),
    db.prepare('INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)').bind(t.id, t.userId, t.hash, t.expiresAt),
  ])
}

// Reset ATOMIK dalam satu batch: tukar kata laluan + bunuh SEMUA sesi hanya
// jika token sah & belum luput; statement terakhir menuntut token (dan token
// lain ahli itu) dan memulangkannya supaya pemanggil tahu sebab kegagalan.
// Dua permintaan serentak: yang kedua tidak menemui token.
export async function resetPassword(db: D1Database, hash: string, passwordHash: string, now: number) {
  const owner = 'SELECT user_id FROM password_reset_tokens WHERE token_hash = ?'
  const [, , claimed] = await db.batch([
    db.prepare(`UPDATE users SET password_hash = ? WHERE id = (${owner} AND expires_at > ?)`).bind(passwordHash, hash, now),
    db.prepare(`DELETE FROM refresh_tokens WHERE user_id = (${owner} AND expires_at > ?)`).bind(hash, now),
    db.prepare(`DELETE FROM password_reset_tokens WHERE user_id = (${owner}) RETURNING token_hash, user_id, expires_at`).bind(hash),
  ])
  const rows = (claimed?.results ?? []) as { token_hash: string; user_id: string; expires_at: number }[]
  return rows.find((r) => r.token_hash === hash) ?? null
}
