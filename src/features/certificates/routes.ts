import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { requireApproved, requireVerified } from '../profile'
import { actorOf } from '../../shared/audit'
import { ApiError, parseBody, uuidParam } from '../../shared/http'
import { requireAuth, userId } from '../../shared/middleware/auth'
import { cors } from '../../shared/middleware/cors'
import { rateLimit } from '../../shared/middleware/rate-limit'
import type { AppEnv } from '../../shared/types'
import * as repo from './repo'
import * as service from './service'
import type { CertificatesCtx, CertificatesDeps } from './service'

const revokeBody = z.object({ reason: z.string().refine((s) => [...s].length <= 500).default('') })
const updatedAt = z.object({ updated_at: z.string().min(1) })
const s = z.string().default('')
const templateBody = z.object({
  name: s,
  primary_color: s,
  secondary_color: s,
  logo_url: z.string().nullish(),
  title: s,
  subtitle: s,
  body_text: s,
  issuer_name: s,
  signature_name: s,
  footer_text: s,
  updated_at: z.string().min(1),
})

export function certificatesRoutes(deps: CertificatesDeps) {
  const r = new Hono<AppEnv>()
  const ctx = (c: Context<AppEnv>): CertificatesCtx => ({ env: c.env, deps, now: Date.now(), actor: actorOf(c), userId: userId(c), waitUntil: (p) => c.executionCtx.waitUntil(p) })
  const approved = [requireAuth, requireApproved] as const
  const verified = [requireAuth, requireApproved, requireVerified] as const
  const management = async (c: Context<AppEnv>, next: () => Promise<void>) => {
    await service.requireManagement({ env: c.env, userId: userId(c) })
    await next()
  }

  r.post('/activities/:id/certificates', ...verified, management, async (c) => c.json(await service.issue(ctx(c), uuidParam(c, 'id'))))
  r.post('/certificates/:id/revoke', ...verified, management, async (c) => {
    const id = uuidParam(c, 'id')
    return c.json(await service.revoke(ctx(c), id, (await parseBody(c, revokeBody)).reason))
  })

  r.get('/me/certificates', ...approved, async (c) => c.json(await service.listMine({ env: c.env, userId: userId(c) })))
  r.get('/me/certificates/:id/file', ...approved, async (c) => {
    const pdf = await service.download({ env: c.env, userId: userId(c) }, uuidParam(c, 'id'))
    return c.body(pdf as Uint8Array<ArrayBuffer>, 200, { 'Content-Type': 'application/pdf' })
  })

  // AWAM: QR pada sijil bercetak diimbas oleh orang tanpa akaun. Baldi had kadar sendiri.
  r.get('/verify/certificates/:token', cors('GET, OPTIONS'), rateLimit('RL_VERIFY'), async (c) => c.json(await service.verify(c.env, c.req.param('token'))))

  r.get('/admin/certificate-templates', ...verified, management, async (c) => c.json({ templates: (await repo.listTemplates(c.env.DB)).map(service.templateDto) }))
  r.get('/admin/certificate-templates/:id', ...verified, management, async (c) => {
    const t = await repo.getTemplate(c.env.DB, uuidParam(c, 'id'))
    if (!t) throw new ApiError(404, 'template sijil tidak dijumpai')
    return c.json(service.templateDto(t))
  })
  r.patch('/admin/certificate-templates/:id', ...verified, management, async (c) => {
    const id = uuidParam(c, 'id')
    return c.json(await service.updateTemplate(ctx(c), id, await parseBody(c, templateBody)))
  })
  r.post('/admin/certificate-templates/:id/publish', ...verified, management, async (c) => {
    const id = uuidParam(c, 'id')
    return c.json(await service.publishTemplate(ctx(c), id, (await parseBody(c, updatedAt)).updated_at))
  })

  return r
}
