// Pariti marc_go middleware/auth.go, kecuali semakan sesi & ban dibaca dari
// senarai tolak KV (bukan D1) - docs/modules/00-shared.md.
import type { Context, MiddlewareHandler } from 'hono'
import { getConfig } from '../config'
import { verifyAccess } from '../jwt'
import { rejection } from '../revocation'
import type { AppEnv } from '../types'

const bearer = (c: Context) => {
  const header = c.req.header('Authorization') ?? ''
  return header.startsWith('Bearer ') ? header.slice(7) : ''
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = bearer(c)
  if (!token) return c.json({ error: 'token tidak dijumpai' }, 401)

  const claims = await verifyAccess(getConfig(c.env).JWT_SECRET, token)
  if (!claims) return c.json({ error: 'token tidak sah' }, 401)

  let state
  try {
    state = await rejection(c.env.KV, claims)
  } catch (err) {
    // 500 (bukan 401): klien mudah alih memadam sesi pada 401 - gangguan KV
    // tidak boleh log keluar semua orang. Pariti marc_go (ralat DB → 500).
    console.error(JSON.stringify({ level: 'error', msg: 'semakan sesi KV gagal', error: String(err) }))
    return c.json({ error: 'gagal sahkan sesi' }, 500)
  }
  if (state === 'revoked') return c.json({ error: 'token tidak sah' }, 401)
  if (state === 'banned') return c.json({ error: 'akaun anda sedang digantung' }, 403)

  c.set('userId', claims.userId)
  c.set('sessionId', claims.sessionId)
  await next()
}

// Laluan awam yang mahu "tahu siapa kalau log masuk" (cth derma). Token
// rosak/dibatalkan/ban = tanpa pengguna, tidak pernah ralat.
export const optionalAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = bearer(c)
  if (token) {
    const claims = await verifyAccess(getConfig(c.env).JWT_SECRET, token)
    if (claims && (await rejection(c.env.KV, claims).catch(() => 'revoked')) === null) {
      c.set('userId', claims.userId)
      c.set('sessionId', claims.sessionId)
    }
  }
  await next()
}

// Hanya selamat selepas requireAuth.
export function userId(c: Context<AppEnv>): string {
  const id = c.get('userId')
  if (!id) throw new Error('userId tiada - laluan tanpa requireAuth')
  return id
}

export const sessionId = (c: Context<AppEnv>): string | null => c.get('sessionId') ?? null
