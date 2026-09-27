// Pariti marc_go handlers/member_bans.go (superadmin sahaja). Tiada jadual
// sendiri: lajur ban milik `profiles` (features/profile) + kunci KV `ban:<id>`
// yang dibaca requireAuth di edge.
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { banStmt, getMember, listBanned, requireApproved, requireMinRole, unbanStmt, type MemberRow } from '../profile'
import { SUPERADMIN } from '../members'
import { actorOf, auditStmt, ENTITY } from '../../shared/audit'
import { ApiError, parseBody } from '../../shared/http'
import { requireAuth, userId } from '../../shared/middleware/auth'
import { clearBan, setBan } from '../../shared/revocation'
import { fromJson, toJsonNullable } from '../../shared/time'
import type { AppEnv } from '../../shared/types'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const targetId = (c: Context<AppEnv>) => {
  const id = c.req.param('id') ?? ''
  if (!UUID.test(id)) throw new ApiError(400, 'id ahli tidak sah')
  return id.toLowerCase()
}

const dto = (r: MemberRow) => ({
  user_id: r.user_id,
  member_id: r.member_id,
  display_name: r.display_name,
  email: r.email,
  role_key: r.role_key,
  banned_at: toJsonNullable(r.banned_at),
  ban_expires_at: toJsonNullable(r.ban_expires_at),
  ban_reason: r.ban_reason ?? '',
  banned_by: r.banned_by,
})

const touched = (id: string, now: number) => ({ sql: 'EXISTS (SELECT 1 FROM profiles WHERE user_id = ? AND updated_at = ?)', params: [id, now] })
const log = (msg: string, err: unknown) => console.error(JSON.stringify({ level: 'error', msg, error: String(err) }))

export function bansRoutes() {
  const r = new Hono<AppEnv>()
  const guard = [requireAuth, requireApproved, requireMinRole(SUPERADMIN, 'tindakan ini untuk superadmin sahaja')] as const
  r.use('/admin/banned-members', ...guard)
  r.use('/admin/members/*', ...guard)

  r.get('/admin/banned-members', async (c) => c.json({ members: (await listBanned(c.env.DB, Date.now())).map(dto) }))

  r.post('/admin/members/:id/ban', async (c) => {
    const id = targetId(c)
    if (id === userId(c)) throw new ApiError(400, 'akaun sendiri tidak boleh digantung')
    const body = await parseBody(c, z.object({ expires_at: z.string().default(''), reason: z.string().min(1).max(500) }))
    const reason = body.reason.trim()
    if (!reason) throw new ApiError(400, 'sebab penggantungan diperlukan')
    const target = await getMember(c.env.DB, id)
    if (!target) throw new ApiError(404, 'ahli tidak dijumpai')
    if (target.role_key === SUPERADMIN) throw new ApiError(403, 'akaun superadmin tidak boleh digantung')

    const now = Date.now()
    let expiresAt: number | null = null
    if (body.expires_at.trim()) {
      expiresAt = fromJson(body.expires_at.trim())
      if (expiresAt === null || expiresAt <= now) throw new ApiError(400, 'tarikh tamat ban tidak sah')
    }

    const db = c.env.DB
    const [res] = await db.batch([
      banStmt(db, { userId: id, expiresAt, reason, by: userId(c), now }),
      auditStmt(db, { entityType: ENTITY.profile, entityId: id, action: 'update', actor: actorOf(c), old: { banned: false }, new: { banned: true, ban_expires_at: body.expires_at, reason } }, touched(id, now))!,
    ])
    if (!res?.results.length) throw new ApiError(409, 'akaun ini sudah digantung')
    // Edge: requireAuth menolak access token serta-merta (≤60 s merentas lokasi).
    await setBan(c.env.KV, id, expiresAt, now).catch((err) => log('KV setBan gagal', err))
    return c.json(dto((await getMember(db, id))!))
  })

  r.delete('/admin/members/:id/ban', async (c) => {
    const id = targetId(c)
    const now = Date.now()
    const db = c.env.DB
    const [res] = await db.batch([
      unbanStmt(db, id, now),
      auditStmt(db, { entityType: ENTITY.profile, entityId: id, action: 'update', actor: actorOf(c), old: { banned: true }, new: { banned: false } }, touched(id, now))!,
    ])
    if (!res?.results.length) throw new ApiError(409, 'akaun ini tidak sedang digantung')
    await clearBan(c.env.KV, id).catch((err) => log('KV clearBan gagal', err))
    return c.json({ user_id: id, banned: false })
  })

  return r
}
