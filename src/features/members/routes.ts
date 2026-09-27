// Semua lapisan `approved`; siling sebenar dalam service.
import { Hono, type Context } from 'hono'
import type { z } from 'zod'
import { requireApproved } from '../profile'
import { actorOf } from '../../shared/audit'
import { getConfig } from '../../shared/config'
import { ApiError, INVALID_DATA, parseBody, uuidParam } from '../../shared/http'
import { requireAuth, userId } from '../../shared/middleware/auth'
import type { AppEnv } from '../../shared/types'
import * as schema from './schema'
import * as service from './service'
import type { MembersCtx, MembersDeps } from './service'

// Body PILIHAN (approve, verify-staff-id): kosong = {}, cacat = 400.
async function optionalBody<T extends z.ZodType>(c: Context<AppEnv>, s: T): Promise<z.infer<T>> {
  const text = await c.req.text()
  if (!text.trim()) return s.parse({})
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new ApiError(400, INVALID_DATA)
  }
  const result = s.safeParse(raw)
  if (!result.success) throw new ApiError(400, result.error.issues[0]?.message ?? INVALID_DATA)
  return result.data
}

export function membersRoutes(deps: MembersDeps) {
  const r = new Hono<AppEnv>()
  const ctx = (c: Context<AppEnv>): MembersCtx => ({
    env: c.env,
    config: getConfig(c.env),
    deps,
    now: Date.now(),
    actor: actorOf(c),
    callerId: userId(c),
    waitUntil: (p) => c.executionCtx.waitUntil(p),
  })
  r.use('/members', requireAuth, requireApproved)
  r.use('/members/*', requireAuth, requireApproved)
  r.use('/roles', requireAuth, requireApproved)

  r.get('/members', async (c) => c.json(await service.list(ctx(c), c.req.query('status') ?? null)))
  r.get('/members/:id', async (c) => c.json(await service.detail(ctx(c), uuidParam(c, 'id'))))
  r.get('/roles', async (c) => c.json(await service.assignableRoles(ctx(c))))

  r.post('/members/:id/approve', async (c) => {
    await optionalBody(c, schema.approveSchema)
    return c.json(await service.setStatus(ctx(c), uuidParam(c, 'id'), 'approved'))
  })
  r.post('/members/:id/reject', async (c) => c.json(await service.setStatus(ctx(c), uuidParam(c, 'id'), 'rejected')))

  r.post('/members/:id/verify-staff-id', async (c) => {
    const id = uuidParam(c, 'id')
    const { staff_id } = await optionalBody(c, schema.verifyStaffSchema)
    return c.json(await service.verifyStaffId(ctx(c), id, staff_id))
  })
  r.patch('/members/:id/staff-id', async (c) => {
    const id = uuidParam(c, 'id')
    return c.json(await service.correctStaffId(ctx(c), id, (await parseBody(c, schema.correctStaffSchema)).staff_id))
  })
  r.patch('/members/:id/member-id', async (c) => {
    const id = uuidParam(c, 'id')
    return c.json(await service.correctMemberId(ctx(c), id, (await parseBody(c, schema.correctMemberIdSchema)).member_id))
  })
  r.patch('/members/:id/role', async (c) => {
    const id = uuidParam(c, 'id')
    return c.json(await service.setRole(ctx(c), id, await parseBody(c, schema.roleSchema)))
  })
  r.patch('/members/:id/active', async (c) => {
    const id = uuidParam(c, 'id')
    return c.json(await service.setActive(ctx(c), id, await parseBody(c, schema.activeSchema)))
  })
  r.patch('/members/:id/department', async (c) => {
    const id = uuidParam(c, 'id')
    return c.json(await service.setDepartment(ctx(c), id, await parseBody(c, schema.departmentSchema)))
  })

  return r
}
