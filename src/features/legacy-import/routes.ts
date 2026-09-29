// /admin/legacy-member-import/* = approved + superadmin (disemak dalam laluan,
// sebelum id/body - pariti). /auth/legacy-member-claim/* = awam, baldi auth.
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { emailSchema, passwordResetConfirmSchema } from '../auth'
import { requireApproved } from '../profile'
import { actorOf } from '../../shared/audit'
import { getConfig } from '../../shared/config'
import { ApiError, parseBody } from '../../shared/http'
import { requireAuth, userId } from '../../shared/middleware/auth'
import { rateLimit } from '../../shared/middleware/rate-limit'
import type { AppEnv } from '../../shared/types'
import * as service from './service'
import type { LegacyCtx, LegacyDeps } from './service'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const upTo = (n: number) => z.string().refine((s) => [...s].length <= n)
const required = (n: number) => z.string().min(1).pipe(upTo(n))

const claimRequest = z.object({ email: emailSchema, staff_id: required(64) })
const rowEdit = z.object({ legacy_staff_id: upTo(64).nullish() })
const resolve = z.object({ from: required(200), code: required(64), name: upTo(200).default('') })

export function legacyImportRoutes(deps: LegacyDeps) {
  const r = new Hono<AppEnv>()
  const ctx = (c: Context<AppEnv>): LegacyCtx => ({
    env: c.env,
    config: getConfig(c.env),
    deps,
    now: Date.now(),
    actor: actorOf(c),
    userId: c.get('userId') ?? '',
    waitUntil: (p) => c.executionCtx.waitUntil(p),
  })
  const superadmin = async (c: Context<AppEnv>, next: () => Promise<void>) => {
    await service.requireSuperAdmin({ env: c.env, userId: userId(c) })
    await next()
  }
  const id = (c: Context<AppEnv>, message: string) => {
    const v = c.req.param('id') ?? ''
    if (!UUID.test(v)) throw new ApiError(400, message)
    return v.toLowerCase()
  }
  const admin = [requireAuth, requireApproved, superadmin] as const
  const P = '/admin/legacy-member-import'

  r.post(`${P}/dry-run`, ...admin, async (c) => {
    let file: File | undefined
    try {
      const f = (await c.req.parseBody())['file']
      if (f instanceof File) file = f
    } catch {
      // multipart cacat = tiada fail
    }
    return c.json(await service.dryRun(ctx(c), file), 201)
  })
  r.get(`${P}/batches`, ...admin, async (c) => c.json(await service.batches(ctx(c))))
  r.patch(`${P}/rows/:id`, ...admin, async (c) => {
    const rowId = id(c, 'id baris tidak sah')
    const body = await parseBody(c, rowEdit)
    return c.json(await service.updateRow(ctx(c), rowId, body.legacy_staff_id ?? undefined))
  })
  r.get(`${P}/:id`, ...admin, async (c) => c.json(await service.batch(ctx(c), id(c, 'id batch tidak sah'))))
  r.post(`${P}/:id/import`, ...admin, async (c) => c.json(await service.importBatch(ctx(c), id(c, 'id batch tidak sah'))))
  r.post(`${P}/:id/resolve-department`, ...admin, async (c) => {
    const batchId = id(c, 'id batch tidak sah')
    return c.json(await service.resolveDepartment(ctx(c), batchId, await parseBody(c, resolve)))
  })

  // Respons sama untuk padan / tidak padan / akaun wujud (tiada enumerasi).
  r.post('/auth/legacy-member-claim/request', rateLimit('RL_AUTH'), async (c) => {
    const body = await parseBody(c, claimRequest)
    await service.requestClaim(ctx(c), body.email, body.staff_id)
    return c.body(null, 204)
  })
  r.post('/auth/legacy-member-claim/complete', rateLimit('RL_AUTH'), async (c) => {
    const body = await parseBody(c, passwordResetConfirmSchema)
    await service.completeClaim(ctx(c), body.token, body.password)
    return c.body(null, 204)
  })

  return r
}
