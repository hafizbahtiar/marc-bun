// GET /audit-logs - lapisan approved, pengurusan sahaja (pariti handlers/audit.go).
import { Hono } from 'hono'
import { isManagement, requireApproved } from '../profile'
import { ApiError } from '../../shared/http'
import { requireAuth, userId } from '../../shared/middleware/auth'
import { toJson } from '../../shared/time'
import type { AppEnv } from '../../shared/types'
import * as repo from './repo'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const INT = /^[+-]?\d+$/
const FAILED = 'gagal muat jejak audit'

const dto = (r: repo.AuditRow) => ({
  id: r.id,
  entity_type: r.entity_type,
  entity_id: r.entity_id,
  action: r.action,
  actor_id: r.actor_id,
  actor_member_id: r.actor_member_id,
  actor_role_key: r.actor_role_key,
  changed_fields: JSON.parse(r.changed_fields) as string[],
  old_values: r.old_values === null ? null : (JSON.parse(r.old_values) as unknown),
  new_values: r.new_values === null ? null : (JSON.parse(r.new_values) as unknown),
  created_at: toJson(r.created_at),
})

export function auditRoutes() {
  const r = new Hono<AppEnv>()
  r.get('/audit-logs', requireAuth, requireApproved, async (c) => {
    const db = c.env.DB
    let ok: boolean
    try {
      ok = await isManagement(db, userId(c))
    } catch {
      throw new ApiError(500, FAILED)
    }
    if (!ok) throw new ApiError(403, 'cuma pengurusan boleh lihat jejak audit')

    const q = c.req.query()
    let limit = 50
    if (q.limit) {
      const n = INT.test(q.limit) ? Number(q.limit) : NaN
      if (!(n > 0)) throw new ApiError(400, 'limit tidak sah')
      limit = Math.min(n, 200)
    }
    let beforeId: number | null = null
    if (q.before_id) {
      if (!INT.test(q.before_id)) throw new ApiError(400, 'before_id tidak sah')
      beforeId = Number(q.before_id)
    }
    let actorId: string | null = null
    if (q.actor_id) {
      if (!UUID.test(q.actor_id)) throw new ApiError(400, 'actor_id tidak sah')
      actorId = q.actor_id.toLowerCase()
    }
    try {
      if (q.entity_id) {
        if (!UUID.test(q.entity_id)) throw new ApiError(400, 'entity_id tidak sah')
        if (!q.entity_type) throw new ApiError(400, 'entity_type wajib bersama entity_id')
        return c.json({ logs: (await repo.byEntity(db, q.entity_type, q.entity_id.toLowerCase(), limit)).map(dto) })
      }
      return c.json({ logs: (await repo.list(db, { entityType: q.entity_type || null, action: q.action || null, actorId, beforeId, limit })).map(dto) })
    } catch (err) {
      if (err instanceof ApiError) throw err
      throw new ApiError(500, FAILED)
    }
  })
  return r
}
