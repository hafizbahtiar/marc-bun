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

// Siling peranan: rank(pemanggil) >= rank(peranan `roleKey`). Pariti
// authz.IsAtLeastRole marc_go (dikira dari jadual roles, bukan hardcode).
export function requireMinRole(roleKey: string, forbidden: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    let ok: boolean
    try {
      const row = await c.env.DB.prepare(
        // cross-read: roles
        `SELECT r.rank >= (SELECT rank FROM roles WHERE key = ?) AS ok FROM profiles p JOIN roles r ON r.id = p.role_id WHERE p.user_id = ?`,
      )
        .bind(roleKey, userId(c))
        .first<{ ok: number }>()
      ok = row?.ok === 1
    } catch {
      return c.json({ error: 'gagal semak kebenaran' }, 500)
    }
    if (!ok) return c.json({ error: forbidden }, 403)
    await next()
  }
}
