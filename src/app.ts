import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { requestId } from 'hono/request-id'
import { accountLifecycleRoutes } from './features/account-lifecycle'
import { authRoutes, type AuthDeps } from './features/auth'
import { bansRoutes } from './features/bans'
import { blockedEmailDomainsRoutes } from './features/blocked-email-domains'
import { departmentsRoutes } from './features/departments'
import { membersRoutes, type MembersDeps } from './features/members'
import { profileRoutes } from './features/profile'
import { telegramRoutes, telegramSend, type TelegramDeps } from './features/telegram'
import { resendEmail } from './shared/email'
import { INVALID_DATA, notFound, onError } from './shared/http'
import { enqueue } from './shared/jobs'
import { logger } from './shared/middleware/logger'
import type { AppEnv } from './shared/types'

// Kebergantungan luaran semua feature (D dalam SOLID): produksi guna
// pelaksanaan sebenar; ujian menghantar yang palsu melalui createApp(deps).
export type AppDeps = AuthDeps & TelegramDeps & MembersDeps

export const defaultDeps: AppDeps = { sendEmail: resendEmail, enqueue, sendTelegram: telegramSend }

export function createApp(deps: AppDeps = defaultDeps) {
  const app = new Hono<AppEnv>()

  app.use(requestId({ headerName: 'X-Request-ID' }))
  app.use(logger)
  // 1 MB seperti marc_go. Gin melaporkan body terlalu besar sebagai ralat bind,
  // jadi pariti = 400 `Data tidak sah`, bukan 413.
  app.use(bodyLimit({ maxSize: 1 << 20, onError: (c) => c.json({ error: INVALID_DATA }, 400) }))

  app.get('/healthz', (c) => c.json({ status: 'ok' }))

  // Satu baris setiap feature.
  app.route('/', authRoutes(deps))
  app.route('/', telegramRoutes(deps))
  app.route('/', profileRoutes())
  app.route('/', membersRoutes(deps))
  app.route('/', departmentsRoutes())
  app.route('/', blockedEmailDomainsRoutes())
  app.route('/', bansRoutes())
  app.route('/', accountLifecycleRoutes())

  app.onError(onError)
  app.notFound(notFound)
  return app
}

export const app = createApp()
