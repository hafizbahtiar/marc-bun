export async function isBlocked(db: D1Database, domain: string): Promise<boolean> {
  return (await db.prepare('SELECT 1 FROM blocked_email_domains WHERE domain = ?').bind(domain).first()) !== null
}
