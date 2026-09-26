import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../types'

type RateLimitBinding = { [K in keyof CloudflareBindings]: CloudflareBindings[K] extends RateLimit ? K : never }[keyof CloudflareBindings]

export const clientIp = (req: { header(name: string): string | undefined }): string =>
  req.header('CF-Connecting-IP') ?? ''

// Baldi bernama per IP. Gagal-terbuka: binding yang bermasalah tidak boleh
// mengunci ahli keluar (padan marc_go). Mesej 429 bait-demi-bait marc_go.
export function rateLimit(binding: RateLimitBinding): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    let success = true
    try {
      ;({ success } = await c.env[binding].limit({ key: clientIp(c.req) }))
    } catch (err) {
      console.error(JSON.stringify({ level: 'warn', msg: 'rate limit gagal-terbuka', binding, error: String(err) }))
    }
    if (!success) return c.json({ error: 'terlalu banyak percubaan, cuba lagi sebentar' }, 429)
    await next()
  }
}
