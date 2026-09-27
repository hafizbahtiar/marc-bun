// Penulis audit (pariti marc_go internal/audit). Pulang STATEMENT, bukan
// menulis: pemanggil memasukkannya ke db.batch() yang SAMA dengan mutasi
// (R2) - audit best-effort bukan audit. Feature pemilik bacaan & retention:
// features/audit.
import type { Context } from 'hono'
import { clientIp } from './middleware/rate-limit'
import type { AppEnv } from './types'

export type AuditAction = 'create' | 'update' | 'delete'

export type Actor = { userId: string | null; ip: string; userAgent: string }

export type AuditEntry = {
  entityType: string
  entityId: string
  action: AuditAction
  actor: Actor
  // Update: hantar kedua-duanya penuh - delta dikira di sini. Create: old tiada.
  // Delete: new tiada.
  old?: Record<string, unknown> | null
  new?: Record<string, unknown> | null
}

export const actorOf = (c: Context<AppEnv>): Actor => ({
  userId: c.get('userId') ?? null,
  ip: clientIp(c.req),
  userAgent: (c.req.header('User-Agent') ?? '').slice(0, 512),
})

// Delta sahaja: medan yang BERBEZA (nilai dibanding sebagai JSON).
export function diff(old: Record<string, unknown> | null | undefined, next: Record<string, unknown> | null | undefined) {
  if (!old && !next) return { oldDelta: null, newDelta: null, changed: [] as string[] }
  if (!old) return { oldDelta: null, newDelta: next!, changed: Object.keys(next!).sort() }
  if (!next) return { oldDelta: old, newDelta: null, changed: Object.keys(old).sort() }
  const oldDelta: Record<string, unknown> = {}
  const newDelta: Record<string, unknown> = {}
  const changed: string[] = []
  for (const key of new Set([...Object.keys(old), ...Object.keys(next)])) {
    if (JSON.stringify(old[key] ?? null) === JSON.stringify(next[key] ?? null)) continue
    oldDelta[key] = old[key] ?? null
    newDelta[key] = next[key] ?? null
    changed.push(key)
  }
  changed.sort()
  return changed.length ? { oldDelta, newDelta, changed } : { oldDelta: null, newDelta: null, changed }
}

// null = update tanpa perubahan (jangan kotorkan jejak). `guard` = syarat SQL
// yang sama dengan mutasi, supaya audit hanya ditulis bila mutasi berlaku.
export function auditStmt(db: D1Database, e: AuditEntry, guard?: { sql: string; params: unknown[] }): D1PreparedStatement | null {
  const { oldDelta, newDelta, changed } = diff(e.old, e.new)
  if (e.action === 'update' && changed.length === 0) return null
  const json = (v: Record<string, unknown> | null) => (v && Object.keys(v).length ? JSON.stringify(v) : null)
  return db
    .prepare(
      // cross-read: profiles, roles (snapshot member_id & peranan pelaku SEMASA
      // tindakan - peranan boleh berubah kemudian)
      `INSERT INTO audit_logs (entity_type, entity_id, action, actor_id, actor_member_id, actor_role_key,
         changed_fields, old_values, new_values, ip_address, user_agent)
       SELECT ?, ?, ?, ?,
         (SELECT member_id FROM profiles WHERE user_id = ?),
         (SELECT r.key FROM profiles p JOIN roles r ON r.id = p.role_id WHERE p.user_id = ?),
         ?, ?, ?, ?, ?
       ${guard ? `WHERE ${guard.sql}` : ''}`,
    )
    .bind(
      e.entityType,
      e.entityId,
      e.action,
      e.actor.userId,
      e.actor.userId,
      e.actor.userId,
      JSON.stringify(changed),
      json(oldDelta),
      json(newDelta),
      e.actor.ip || null,
      e.actor.userAgent || null,
      ...(guard?.params ?? []),
    )
}

// Pemalar jenis entiti (pariti marc_go). Tambah entiti = tambah pemalar.
export const ENTITY = {
  profile: 'profile',
  staffIdVerification: 'staff_id_verification',
  staffIdCorrection: 'staff_id_correction',
  memberIdCorrection: 'member_id_correction',
  accountDeletionRequest: 'account_deletion_request',
} as const
