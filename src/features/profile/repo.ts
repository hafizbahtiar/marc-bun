// SQL `profiles` - HANYA fail ini menulis jadual itu (docs/modules/README.md).
// Operasi yang perlu atomik bersama jadual lain memulangkan statement untuk
// db.batch() pemanggil.

export function createInitialStmt(db: D1Database, p: { id: string; userId: string; staffId: string; phone: string }) {
  return db
    .prepare(
      // cross-read: roles (id peranan 'ahli' dalam statement yang sama)
      `INSERT INTO profiles (id, user_id, role_id, staff_id, phone)
       VALUES (?, ?, (SELECT id FROM roles WHERE key = 'ahli'), ?, ?)`,
    )
    .bind(p.id, p.userId, p.staffId, p.phone)
}

export async function markEmailVerified(db: D1Database, userId: string): Promise<void> {
  await db.prepare('UPDATE profiles SET email_verified = 1 WHERE user_id = ?').bind(userId).run()
}

export function gateState(db: D1Database, userId: string) {
  return db.prepare('SELECT status, email_verified FROM profiles WHERE user_id = ?').bind(userId).first<{ status: string; email_verified: number }>()
}

export async function isBanned(db: D1Database, userId: string, now: number): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 FROM profiles WHERE user_id = ? AND banned_at IS NOT NULL AND (ban_expires_at IS NULL OR ban_expires_at > ?)')
    .bind(userId, now)
    .first()
  return row !== null
}

export async function listManagementUserIds(db: D1Database): Promise<string[]> {
  const { results } = await db
    // cross-read: roles (kategori peranan melalui FK role_id)
    .prepare(`SELECT p.user_id FROM profiles p JOIN roles r ON r.id = p.role_id WHERE r.category = 'management'`)
    .all<{ user_id: string }>()
  return results.map((r) => r.user_id)
}

export async function userIdByTelegramChat(db: D1Database, chatId: number): Promise<string | null> {
  const row = await db.prepare('SELECT user_id FROM profiles WHERE telegram_chat_id = ?').bind(chatId).first<{ user_id: string }>()
  return row?.user_id ?? null
}

export async function setTelegram(db: D1Database, userId: string, chatId: number, username: string | null, now: number): Promise<void> {
  await db
    .prepare('UPDATE profiles SET telegram_chat_id = ?, telegram_username = ?, telegram_linked_at = ? WHERE user_id = ?')
    .bind(chatId, username, now, userId)
    .run()
}

export async function clearTelegram(db: D1Database, userId: string): Promise<void> {
  await db
    .prepare('UPDATE profiles SET telegram_chat_id = NULL, telegram_username = NULL, telegram_linked_at = NULL WHERE user_id = ?')
    .bind(userId)
    .run()
}
