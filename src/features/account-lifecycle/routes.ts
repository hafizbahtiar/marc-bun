// Pariti marc_go handlers/account_lifecycle.go (superadmin sahaja). ORKESTRATOR:
// tiada jadual sendiri - satu db.batch() daripada statement setiap pemilik,
// semuanya dengan guard yang sama (atomik; separuh jalan mustahil).
//
// Beza marc_go: null-out rujukan sejarah tidak diperlukan (skema D1 guna
// ON DELETE SET NULL pada setiap rujukan audit); derma dipisahkan dengan
// menyalin emel (marc_go gagal 500 bila ahli pernah menderma semasa log masuk).
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { deleteUserStmt } from '../auth'
import { SUPERADMIN } from '../members'
import { detachDonationsStmt } from '../payments'
import { getMember, listDeletionRequests, listDeletionTargets, PENDING_DELETION_REQUEST_SQL, requireApproved, requireMinRole, type MemberRow } from '../profile'
import { enqueueUserObjectsStmt } from '../uploads'
import { actorOf, auditStmt, ENTITY } from '../../shared/audit'
import { getConfig } from '../../shared/config'
import { ApiError, parseBody } from '../../shared/http'
import { requireAuth, userId } from '../../shared/middleware/auth'
import { revokeUser } from '../../shared/revocation'
import { toJson, toJsonNullable } from '../../shared/time'
import type { AppEnv } from '../../shared/types'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const rowDto = (r: Awaited<ReturnType<typeof listDeletionRequests>>[number]) => ({
  user_id: r.user_id,
  member_id: r.member_id,
  display_name: r.display_name,
  email: r.email,
  role_key: r.role_key,
  account_status: r.account_status,
  status: r.status,
  requested_at: toJson(r.requested_at),
  completed_at: toJsonNullable(r.completed_at),
})

async function execute(c: Context<AppEnv>, mode: 'member_request' | 'admin_direct', reason: string) {
  const id = c.req.param('id') ?? ''
  if (!UUID.test(id)) throw new ApiError(400, 'ID pengguna tidak sah')
  const targetId = id.toLowerCase()
  const callerId = userId(c)
  if (targetId === callerId) throw new ApiError(400, 'akaun sendiri tidak boleh dipadam melalui modul ini')

  const db = c.env.DB
  const target: MemberRow | null = await getMember(db, targetId)
  if (!target) throw new ApiError(404, 'akaun tidak dijumpai')
  const requiresRequest = mode === 'member_request'
  if (requiresRequest && !(await db.prepare(`SELECT ${PENDING_DELETION_REQUEST_SQL} AS ok`).bind(targetId).first<{ ok: number }>())?.ok) {
    throw new ApiError(409, 'akaun ini tiada permintaan pemadaman yang menunggu')
  }
  if (target.role_key === SUPERADMIN) throw new ApiError(400, 'akaun superadmin tidak boleh dipadam melalui modul ini')

  // Guard dikongsi: pengguna masih wujud, bukan superadmin, (dan permintaan masih menunggu).
  const guard = {
    sql: `EXISTS (SELECT 1 FROM profiles p JOIN roles r ON r.id = p.role_id WHERE p.user_id = ? AND r.key <> 'superadmin')${requiresRequest ? ` AND ${PENDING_DELETION_REQUEST_SQL}` : ''}`,
    params: requiresRequest ? [targetId, targetId] : [targetId],
  }
  const results = await db.batch([
    enqueueUserObjectsStmt(db, targetId, 'account_deleted', guard),
    detachDonationsStmt(db, targetId, guard),
    auditStmt(
      db,
      {
        entityType: ENTITY.profile,
        entityId: targetId,
        action: 'delete',
        actor: actorOf(c),
        old: { email: target.email, member_id: target.member_id, display_name: target.display_name, role_key: target.role_key, deletion_mode: mode, reason },
      },
      guard,
    )!,
    deleteUserStmt(db, targetId, guard),
  ])
  if (!results.at(-1)?.results.length) throw new ApiError(404, 'akaun tidak dijumpai')

  // Access token ahli yang dipadam tidak boleh hidup sehingga tamat.
  const config = getConfig(c.env)
  await revokeUser(c.env.KV, targetId, config.ACCESS_TOKEN_TTL_MINUTES, Date.now()).catch((err) =>
    console.error(JSON.stringify({ level: 'error', msg: 'KV revokeUser gagal', error: String(err) })),
  )
  return c.json({ ok: true, user_id: targetId })
}

export function accountLifecycleRoutes() {
  const r = new Hono<AppEnv>()
  const guard = [requireAuth, requireApproved, requireMinRole(SUPERADMIN, 'tindakan ini untuk superadmin sahaja')] as const
  r.use('/admin/account-deletion-requests', ...guard)
  r.use('/admin/account-deletion-requests/*', ...guard)
  r.use('/admin/account-deletion-targets', ...guard)
  r.use('/admin/account-deletion-targets/*', ...guard)

  r.get('/admin/account-deletion-requests', async (c) => c.json({ requests: (await listDeletionRequests(c.env.DB)).map(rowDto) }))
  r.get('/admin/account-deletion-targets', async (c) => c.json({ accounts: (await listDeletionTargets(c.env.DB)).map(rowDto) }))

  r.post('/admin/account-deletion-requests/:id/execute', (c) => execute(c, 'member_request', ''))
  r.post('/admin/account-deletion-targets/:id/execute', async (c) => {
    const { reason: raw } = await parseBody(c, z.object({ reason: z.string().min(1).max(500) }))
    const reason = raw.trim()
    if (!reason) throw new ApiError(400, 'sebab pemadaman diperlukan')
    return execute(c, 'admin_direct', reason)
  })

  return r
}
