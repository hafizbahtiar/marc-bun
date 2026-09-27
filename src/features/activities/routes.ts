// Baca = approved; tulis = verified. Siling pengurusan dalam service (pariti marc_go).
import { Hono, type Context } from 'hono'
import { requireApproved, requireVerified } from '../profile'
import { actorOf } from '../../shared/audit'
import { parseBody, uuidParam } from '../../shared/http'
import { requireAuth, userId } from '../../shared/middleware/auth'
import type { AppEnv } from '../../shared/types'
import * as schema from './schema'
import * as service from './service'
import type { ActivitiesCtx, ActivitiesDeps } from './service'

export function activitiesRoutes(deps: ActivitiesDeps) {
  const r = new Hono<AppEnv>()
  const ctx = (c: Context<AppEnv>): ActivitiesCtx => ({ env: c.env, deps, now: Date.now(), actor: actorOf(c), userId: userId(c), waitUntil: (p) => c.executionCtx.waitUntil(p) })
  const approved = [requireAuth, requireApproved] as const
  const verified = [requireAuth, requireApproved, requireVerified] as const

  r.get('/activity-categories', ...approved, async (c) => c.json(await service.listCategories(ctx(c), c.req.query('all') === 'true')))
  r.post('/activity-categories', ...verified, async (c) => {
    const x = ctx(c)
    await service.requireManager(x)
    return c.json(await service.createCategory(x, await parseBody(c, schema.createCategory)), 201)
  })
  r.patch('/activity-categories/:id', ...verified, async (c) => {
    const x = ctx(c)
    await service.requireManager(x)
    const id = uuidParam(c, 'id')
    return c.json(await service.updateCategory(x, id, await parseBody(c, schema.updateCategory)))
  })

  r.get('/activities', ...approved, async (c) => c.json(await service.list(ctx(c), c.req.query())))
  r.get('/activities/:id', ...approved, async (c) => c.json(await service.get(ctx(c), uuidParam(c, 'id'))))

  r.post('/activities', ...verified, async (c) => {
    const x = ctx(c)
    await service.requireManagement(x)
    return c.json(await service.create(x, await parseBody(c, schema.createActivity)), 201)
  })
  r.patch('/activities/:id', ...verified, async (c) => {
    const x = ctx(c)
    await service.requireManagement(x)
    const id = uuidParam(c, 'id')
    return c.json(await service.update(x, id, await parseBody(c, schema.updateActivity)))
  })
  r.post('/activities/:id/publish', ...verified, async (c) => {
    const x = ctx(c)
    await service.requireManagement(x)
    return c.json(await service.publish(x, uuidParam(c, 'id')))
  })
  r.post('/activities/:id/cancel', ...verified, async (c) => {
    const x = ctx(c)
    await service.requireManagement(x)
    const id = uuidParam(c, 'id')
    return c.json(await service.cancel(x, id, (await parseBody(c, schema.cancel)).reason))
  })
  r.put('/activities/:id/sessions', ...verified, async (c) => {
    const x = ctx(c)
    await service.requireManagement(x)
    const id = uuidParam(c, 'id')
    return c.json(await service.replaceSessions(x, id, (await parseBody(c, schema.sessions)).sessions))
  })

  return r
}
