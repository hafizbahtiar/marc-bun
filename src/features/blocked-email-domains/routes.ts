// Pariti marc_go handlers/blocked_email_domains.go (superadmin sahaja).
import { Hono } from 'hono'
import { z } from 'zod'
import { requireApproved, requireMinRole } from '../profile'
import { ApiError, parseBody } from '../../shared/http'
import { requireAuth, userId } from '../../shared/middleware/auth'
import { toJsonNullable } from '../../shared/time'
import type { AppEnv } from '../../shared/types'
import * as repo from './repo'

const dto = (d: { domain: string; added_by: string | null; created_at: number | null }) => ({ domain: d.domain, added_by: d.added_by, created_at: toJsonNullable(d.created_at) })

export function blockedEmailDomainsRoutes() {
  const r = new Hono<AppEnv>()
  const guard = [requireAuth, requireApproved, requireMinRole('superadmin', 'tindakan ini untuk superadmin sahaja')] as const
  r.use('/admin/blocked-email-domains', ...guard)
  r.use('/admin/blocked-email-domains/*', ...guard)

  r.get('/admin/blocked-email-domains', async (c) => c.json({ domains: (await repo.list(c.env.DB)).map(dto) }))

  // Pendua = 201 dengan domain sahaja (pariti ON CONFLICT DO NOTHING marc_go).
  r.post('/admin/blocked-email-domains', async (c) => {
    const { domain: raw } = await parseBody(c, z.object({ domain: z.string().min(1).max(253) }))
    const domain = raw.trim().toLowerCase()
    if (!domain) throw new ApiError(400, 'domain diperlukan')
    const row = await repo.add(c.env.DB, domain, userId(c))
    return c.json(dto(row ?? { domain, added_by: null, created_at: null }), 201)
  })

  r.delete('/admin/blocked-email-domains/:domain', async (c) => {
    await repo.remove(c.env.DB, c.req.param('domain').trim().toLowerCase())
    return c.json({ ok: true })
  })

  return r
}
