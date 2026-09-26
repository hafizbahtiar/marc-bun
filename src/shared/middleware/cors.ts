// Pariti tepat marc_go middleware/cors.go: CORS per-laluan (bukan global),
// origin dari CORS_ALLOWED_ORIGINS, preflight OPTIONS → 204 tanpa ke handler.
// Bukan hono/cors: header dan kelakuan origin-tidak-sah mesti sama bait.
import type { MiddlewareHandler } from 'hono'
import { getConfig } from '../config'
import type { AppEnv } from '../types'

export function cors(allowedMethods: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const origin = c.req.header('Origin') ?? ''
    if (origin && getConfig(c.env).CORS_ALLOWED_ORIGINS.includes(origin)) {
      c.header('Access-Control-Allow-Origin', origin)
      c.header('Vary', 'Origin')
      c.header('Access-Control-Allow-Methods', allowedMethods)
      c.header('Access-Control-Allow-Headers', 'Content-Type')
      c.header('Access-Control-Max-Age', '3600')
    }
    if (c.req.method === 'OPTIONS') return c.body(null, 204)
    await next()
  }
}
