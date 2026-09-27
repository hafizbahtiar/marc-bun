import { Hono, type MiddlewareHandler } from 'hono'
import { z } from 'zod'
import { parseBody } from '../../shared/http'
import { requireAuth, userId } from '../../shared/middleware/auth'
import { rateLimit } from '../../shared/middleware/rate-limit'
import type { AppEnv } from '../../shared/types'
import { presignUpload } from './service'

const schema = z.object({ content_type: z.string({ error: 'Jenis fail diperlukan' }).min(1, 'Jenis fail diperlukan') })

// Lapisan `verified`. Middleware profile disuntik oleh app.ts: profile
// mengimport uploads, jadi uploads tidak boleh mengimport profile (kitaran).
export function uploadsRoutes(verified: MiddlewareHandler<AppEnv>[]) {
  const r = new Hono<AppEnv>()
  // Klien PUT terus ke R2, kemudian lampir r2_key pada post/avatar.
  r.post('/uploads/presign', requireAuth, ...verified, rateLimit('RL_UPLOAD'), async (c) =>
    c.json(await presignUpload(c.env, c.env.DB, userId(c), (await parseBody(c, schema)).content_type, Date.now())),
  )
  return r
}
