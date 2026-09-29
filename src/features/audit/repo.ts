// SQL milik features/audit: audit_logs (bacaan + retention). Penulis = shared/audit.ts.

export type AuditRow = {
  id: number
  entity_type: string
  entity_id: string
  action: string
  actor_id: string | null
  actor_member_id: string | null
  actor_role_key: string | null
  changed_fields: string
  old_values: string | null
  new_values: string | null
  created_at: number
}

const COLS = 'id, entity_type, entity_id, action, actor_id, actor_member_id, actor_role_key, changed_fields, old_values, new_values, created_at'

// Garis masa satu entiti - padan indeks (entity_type, entity_id, id DESC).
export async function byEntity(db: D1Database, entityType: string, entityId: string, limit: number): Promise<AuditRow[]> {
  const { results } = await db.prepare(`SELECT ${COLS} FROM audit_logs WHERE entity_type = ? AND entity_id = ? ORDER BY id DESC LIMIT ?`).bind(entityType, entityId, limit).all<AuditRow>()
  return results
}

export async function list(db: D1Database, f: { entityType: string | null; action: string | null; actorId: string | null; beforeId: number | null; limit: number }): Promise<AuditRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${COLS} FROM audit_logs
       WHERE (?1 IS NULL OR entity_type = ?1) AND (?2 IS NULL OR action = ?2) AND (?3 IS NULL OR actor_id = ?3) AND (?4 IS NULL OR id < ?4)
       ORDER BY id DESC LIMIT ?5`,
    )
    .bind(f.entityType, f.action, f.actorId, f.beforeId, f.limit)
    .all<AuditRow>()
  return results
}

// Retention berkeping (had 30 s setiap query). Trigger append-only membenarkan
// pengosongan ip_address/user_agent dan DELETE.
export const redactPiiStmt = (db: D1Database, before: number, limit: number) =>
  db
    .prepare(
      `UPDATE audit_logs SET ip_address = NULL, user_agent = NULL
       WHERE id IN (SELECT id FROM audit_logs WHERE created_at < ? AND (ip_address IS NOT NULL OR user_agent IS NOT NULL) LIMIT ?)`,
    )
    .bind(before, limit)

export const pruneStmt = (db: D1Database, before: number, limit: number) =>
  db.prepare('DELETE FROM audit_logs WHERE id IN (SELECT id FROM audit_logs WHERE created_at < ? LIMIT ?)').bind(before, limit)
