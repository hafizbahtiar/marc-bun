// Gate lapisan `approved` / `verified` (docs/00000-foundation.md §6). Di sini,
// bukan shared/, kerana ia membaca `profiles`. Pasang selepas requireAuth.
import type { MiddlewareHandler } from 'hono'
import { userId } from '../../shared/middleware/auth'
import type { AppEnv } from '../../shared/types'
import { gateState } from './repo'

export const requireApproved: MiddlewareHandler<AppEnv> = async (c, next) => {
  const state = await gateState(c.env.DB, userId(c)).catch(() => null)
  if (state?.status !== 'approved') return c.json({ error: 'akaun anda belum diluluskan pihak pengurusan' }, 403)
  await next()
}

export const requireVerified: MiddlewareHandler<AppEnv> = async (c, next) => {
  const state = await gateState(c.env.DB, userId(c)).catch(() => null)
  if (state?.email_verified !== 1) return c.json({ error: 'sila sahkan email anda dahulu' }, 403)
  await next()
}
