import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../types'
import { clientIp } from './rate-limit'

// Satu baris JSON setiap permintaan (Workers Logs). Tiada token, emel, body.
export const logger: MiddlewareHandler<AppEnv> = async (c, next) => {
  const start = performance.now()
  await next()
  console.log(
    JSON.stringify({
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      latency_ms: Math.round(performance.now() - start),
      request_id: c.get('requestId'),
      client_ip: clientIp(c.req),
    }),
  )
}
