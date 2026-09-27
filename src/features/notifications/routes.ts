import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { requireApproved, requireVerified } from '../profile'
import { decodeCursor, encodeCursor, pageLimit } from '../../shared/cursor'
import { ApiError, parseBody, uuidParam } from '../../shared/http'
import { requireAuth, userId } from '../../shared/middleware/auth'
import { toJson } from '../../shared/time'
import type { AppEnv } from '../../shared/types'
import * as repo from './repo'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const selected = z.object({ ids: z.array(z.string().regex(UUID).transform((s) => s.toLowerCase())).min(1).max(100) }, { error: 'senarai notifikasi tidak sah' })
const token = z.object({
  onesignal_id: z.string({ error: 'OneSignal ID diperlukan' }).min(1, 'OneSignal ID diperlukan').max(200, 'OneSignal ID diperlukan'),
  platform: z.string().default(''),
})

export function notificationsRoutes() {
  const r = new Hono<AppEnv>()
  const noContent = (c: Context<AppEnv>) => c.body(null, 204)

  r.use('/notifications/*', requireAuth, requireApproved, requireVerified)
  r.use('/notifications', requireAuth, requireApproved, requireVerified)
  r.use('/device-tokens/*', requireAuth, requireApproved)
  r.use('/device-tokens', requireAuth, requireApproved)

  r.get('/notifications', async (c) => {
    const limit = pageLimit(c.req.query('limit'))
    const cursor = c.req.query('cursor')
    const after = cursor ? decodeCursor(cursor) : null
    if (cursor && !after) throw new ApiError(400, 'cursor tidak sah')
    const rows = await repo.list(c.env.DB, userId(c), limit, after)
    const last = rows.at(-1)
    return c.json({
      notifications: rows.map(({ read_at, created_at, ...n }) => ({ ...n, read: read_at !== null, created_at: toJson(created_at) })),
      next_cursor: rows.length === limit && last ? encodeCursor(last.created_at, last.id) : null,
    })
  })
  // Laluan statik didaftar sebelum `/:id`.
  r.post('/notifications/read-all', async (c) => {
    await repo.markAllRead(c.env.DB, userId(c), Date.now())
    return noContent(c)
  })
  r.delete('/notifications/read', async (c) => {
    await repo.removeRead(c.env.DB, userId(c))
    return noContent(c)
  })
  r.delete('/notifications/selected', async (c) => {
    let ids: string[]
    try {
      ids = selected.parse(await c.req.json()).ids
    } catch {
      throw new ApiError(400, 'senarai notifikasi tidak sah')
    }
    await repo.removeSelected(c.env.DB, userId(c), ids)
    return noContent(c)
  })
  r.post('/notifications/:id/read', async (c) => {
    await repo.markRead(c.env.DB, uuidParam(c, 'id'), userId(c), Date.now())
    return noContent(c)
  })
  r.delete('/notifications/:id', async (c) => {
    await repo.remove(c.env.DB, uuidParam(c, 'id'), userId(c))
    return noContent(c)
  })

  r.post('/device-tokens', async (c) => {
    const body = await parseBody(c, token)
    if (!(await repo.upsertToken(c.env.DB, userId(c), body.onesignal_id, body.platform || null, Date.now()))) {
      throw new ApiError(409, 'peranti ini sudah didaftarkan pada akaun lain')
    }
    return noContent(c)
  })
  r.delete('/device-tokens/by-onesignal/:onesignalId', async (c) => {
    await repo.removeTokenByOnesignal(c.env.DB, c.req.param('onesignalId'), userId(c))
    return noContent(c)
  })
  r.delete('/device-tokens/:id', async (c) => {
    await repo.removeToken(c.env.DB, uuidParam(c, 'id'), userId(c))
    return noContent(c)
  })

  return r
}
