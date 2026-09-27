// HTTP sahaja. Semua lapisan `protected` (bukan approved): ahli pending /
// rejected mesti boleh baca status sendiri dan mengurus data peribadinya.
import { Hono, type Context } from 'hono'
import { actorOf } from '../../shared/audit'
import { getConfig } from '../../shared/config'
import { parseBody, uuidParam } from '../../shared/http'
import { requireAuth, userId } from '../../shared/middleware/auth'
import { rateLimit } from '../../shared/middleware/rate-limit'
import type { AppEnv } from '../../shared/types'
import { createAddressSchema, updateAddressSchema, updateMeSchema } from './schema'
import * as service from './service'

const ctx = (c: Context<AppEnv>): service.ProfileCtx => ({
  env: c.env,
  now: Date.now(),
  actor: actorOf(c),
  feeCents: getConfig(c.env).REGISTRATION_FEE_CENTS,
})

export function profileRoutes() {
  const r = new Hono<AppEnv>()
  const limit = rateLimit('RL_PROFILE_UPDATE')

  r.get('/me', requireAuth, async (c) => c.json(await service.me(ctx(c), userId(c))))
  r.patch('/me', requireAuth, limit, async (c) => c.json(await service.updateMe(ctx(c), userId(c), await parseBody(c, updateMeSchema))))
  r.post('/me/deletion-request', requireAuth, rateLimit('RL_ACCOUNT_DELETION_REQUEST'), async (c) => c.json(await service.requestDeletion(ctx(c), userId(c))))

  r.get('/me/addresses', requireAuth, async (c) => c.json(await service.listAddresses(ctx(c), userId(c))))
  r.post('/me/addresses', requireAuth, limit, async (c) => c.json(await service.createAddress(ctx(c), userId(c), await parseBody(c, createAddressSchema)), 201))
  r.patch('/me/addresses/:id', requireAuth, limit, async (c) => {
    const id = uuidParam(c, 'id')
    return c.json(await service.updateAddress(ctx(c), userId(c), id, await parseBody(c, updateAddressSchema)))
  })
  r.delete('/me/addresses/:id', requireAuth, limit, async (c) => {
    await service.deleteAddress(ctx(c), userId(c), uuidParam(c, 'id'))
    return c.body(null, 204)
  })

  return r
}
