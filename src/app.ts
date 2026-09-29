import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { requestId } from 'hono/request-id'
import { secureHeaders } from 'hono/secure-headers'
import { accountLifecycleRoutes } from './features/account-lifecycle'
import { activitiesRoutes } from './features/activities'
import { auditRoutes } from './features/audit'
import { authRoutes, type AuthDeps } from './features/auth'
import { bansRoutes } from './features/bans'
import { blockedEmailDomainsRoutes } from './features/blocked-email-domains'
import { certificatesRoutes } from './features/certificates'
import { dashboardRoutes } from './features/dashboard'
import { departmentsRoutes } from './features/departments'
import { legacyImportRoutes } from './features/legacy-import'
import { membersRoutes, type MembersDeps } from './features/members'
import { notificationsRoutes } from './features/notifications'
import { gatewaysFor, paymentsRoutes, type PaymentsDeps } from './features/payments'
import { postsRoutes } from './features/posts'
import { profileRoutes, requireApproved, requireVerified } from './features/profile'
import { registrationsRoutes } from './features/registrations'
import { telegramRoutes, telegramSend, type TelegramDeps } from './features/telegram'
import { uploadsRoutes } from './features/uploads'
import { resendEmail } from './shared/email'
import { INVALID_DATA, notFound, onError } from './shared/http'
import { enqueue } from './shared/jobs'
import { logger } from './shared/middleware/logger'
import type { AppEnv } from './shared/types'

// Kebergantungan luaran semua feature (D dalam SOLID): produksi guna
// pelaksanaan sebenar; ujian menghantar yang palsu melalui createApp(deps).
export type AppDeps = AuthDeps & TelegramDeps & MembersDeps & PaymentsDeps

export const defaultDeps: AppDeps = { sendEmail: resendEmail, enqueue, sendTelegram: telegramSend, gateways: gatewaysFor }

export function createApp(deps: AppDeps = defaultDeps) {
  const app = new Hono<AppEnv>()

  app.use(requestId({ headerName: 'X-Request-ID' }))
  app.use(logger)
  // nosniff, X-Frame-Options, HSTS, Referrer-Policy. CORP/COOP dimatikan: klien
  // web (marc_next/astro) memanggil API ini merentas origin.
  app.use(secureHeaders({ crossOriginResourcePolicy: false, crossOriginOpenerPolicy: false }))
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
  app.route('/', uploadsRoutes([requireApproved, requireVerified]))
  app.route('/', postsRoutes(deps))
  app.route('/', notificationsRoutes())
  app.route('/', dashboardRoutes())
  app.route('/', activitiesRoutes(deps))
  app.route('/', registrationsRoutes())
  app.route('/', certificatesRoutes(deps))
  app.route('/', paymentsRoutes(deps))
  app.route('/', auditRoutes())
  app.route('/', legacyImportRoutes(deps))

  app.onError(onError)
  app.notFound(notFound)
  return app
}

export const app = createApp()
