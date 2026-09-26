// SQL milik features/telegram: telegram_link_tokens.

export async function replaceLinkToken(db: D1Database, t: { id: string; userId: string; hash: string; expiresAt: number }) {
  await db.batch([
    db.prepare('DELETE FROM telegram_link_tokens WHERE user_id = ?').bind(t.userId),
    db.prepare('INSERT INTO telegram_link_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)').bind(t.id, t.userId, t.hash, t.expiresAt),
  ])
}

// Tuntutan sekali-guna, satu statement (tiada jurang baca-kemudian-tulis).
export const claimLinkToken = (db: D1Database, hash: string) =>
  db.prepare('DELETE FROM telegram_link_tokens WHERE token_hash = ? RETURNING user_id, expires_at').bind(hash).first<{ user_id: string; expires_at: number }>()
