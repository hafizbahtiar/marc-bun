// SQL milik features/blocked-email-domains.
export type BlockedDomainRow = { domain: string; added_by: string | null; created_at: number }

export async function isBlocked(db: D1Database, domain: string): Promise<boolean> {
  return (await db.prepare('SELECT 1 FROM blocked_email_domains WHERE domain = ?').bind(domain).first()) !== null
}

export async function list(db: D1Database): Promise<BlockedDomainRow[]> {
  const { results } = await db.prepare('SELECT * FROM blocked_email_domains ORDER BY created_at DESC').all<BlockedDomainRow>()
  return results
}

export const add = (db: D1Database, domain: string, addedBy: string) =>
  db.prepare('INSERT INTO blocked_email_domains (domain, added_by) VALUES (?, ?) ON CONFLICT (domain) DO NOTHING RETURNING *').bind(domain, addedBy).first<BlockedDomainRow>()

export async function remove(db: D1Database, domain: string): Promise<void> {
  await db.prepare('DELETE FROM blocked_email_domains WHERE domain = ?').bind(domain).run()
}
