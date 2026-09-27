// /me/activities = approved; selebihnya verified (pendaftaran meletakkan nama
// sebenar pada sijil). Siling pengurusan dalam service (pariti marc_go).
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { requireApproved, requireVerified } from '../profile'
import { actorOf } from '../../shared/audit'
import { parseBody, uuidParam } from '../../shared/http'
import { requireAuth, userId } from '../../shared/middleware/auth'
import type { AppEnv } from '../../shared/types'
import * as service from './service'
import type { RegistrationsCtx } from './service'

const markBody = z.object({
  registration_id: z.string().default(''),
  checkin_token: z.string().default(''),
  method: z.string().default(''),
  amend: z.boolean().default(false),
  reason: z
    .string()
    .refine((s) => [...s].length <= 500)
    .default(''),
})

export function registrationsRoutes() {
  const r = new Hono<AppEnv>()
  const ctx = (c: Context<AppEnv>): RegistrationsCtx => ({ env: c.env, now: Date.now(), actor: actorOf(c), userId: userId(c) })
  const verified = [requireAuth, requireApproved, requireVerified] as const

  r.get('/me/activities', requireAuth, requireApproved, async (c) => c.json(await service.listMine(ctx(c))))
  r.post('/activities/:id/registration', ...verified, async (c) => c.json(await service.register(ctx(c), uuidParam(c, 'id')), 201))
  r.delete('/activities/:id/registration', ...verified, async (c) => c.json(await service.cancel(ctx(c), uuidParam(c, 'id'))))
  r.get('/activities/:id/registrations', ...verified, async (c) => {
    const x = ctx(c)
    await service.requireManagement(x)
    return c.json(await service.listForActivity(x, uuidParam(c, 'id')))
  })
  r.post('/activities/:id/sessions/:sid/attendance', ...verified, async (c) => {
    const id = uuidParam(c, 'id')
    const sid = uuidParam(c, 'sid')
    return c.json(await service.mark(ctx(c), id, sid, await parseBody(c, markBody)))
  })
  r.delete('/activities/:id/sessions/:sid/attendance/:rid', ...verified, async (c) => {
    const x = ctx(c)
    await service.requireManagement(x)
    return c.json(await service.unmark(x, uuidParam(c, 'id'), uuidParam(c, 'sid'), uuidParam(c, 'rid')))
  })

  return r
}
