// HTTP sahaja: parse → service → respons. Susunan middleware setiap laluan
// sama dengan marc_go router.go (ia menentukan ralat mana yang menang).
import { Hono, type Context } from 'hono'
import { requireApproved } from '../profile'
import { getConfig } from '../../shared/config'
import { ApiError, parseBody, uuidParam } from '../../shared/http'
import { requireAuth, sessionId, userId } from '../../shared/middleware/auth'
import { cors } from '../../shared/middleware/cors'
import { clientIp, rateLimit } from '../../shared/middleware/rate-limit'
import type { AppEnv } from '../../shared/types'
import { sessionsDto } from './dto'
import { verificationPage } from './html'
import * as schema from './schema'
import * as service from './service'
import type { AuthCtx, AuthDeps } from './service'

const ctxOf = (c: Context<AppEnv>, deps: AuthDeps): AuthCtx => ({
  env: c.env,
  config: getConfig(c.env),
  deps,
  now: Date.now(),
  ip: clientIp(c.req),
  // Label mesra dari app Flutter; fallback User-Agent pelayar.
  deviceLabel: c.req.header('X-MARC-Device-Label')?.trim() || c.req.header('User-Agent') || '',
  waitUntil: (p) => c.executionCtx.waitUntil(p),
})

export function authRoutes(deps: AuthDeps) {
  const r = new Hono<AppEnv>()
  const ctx = (c: Context<AppEnv>) => ctxOf(c, deps)
  const html = (c: Context<AppEnv>, status: 200 | 400, message: string) => c.html(verificationPage(message), status)

  r.post('/auth/register', rateLimit('RL_AUTH'), async (c) => c.json(await service.register(ctx(c), await parseBody(c, schema.registerSchema)), 201))
  r.post('/auth/login', rateLimit('RL_AUTH'), async (c) => c.json(await service.login(ctx(c), await parseBody(c, schema.loginSchema))))
  r.post('/auth/refresh', rateLimit('RL_AUTH_SESSION'), async (c) => c.json(await service.refresh(ctx(c), (await parseBody(c, schema.refreshSchema)).refresh_token)))
  r.post('/auth/logout', rateLimit('RL_AUTH_SESSION'), async (c) => {
    await service.logout(ctx(c), (await parseBody(c, schema.refreshSchema)).refresh_token)
    return c.body(null, 204)
  })
  r.post('/auth/logout-all', requireAuth, async (c) => {
    await service.logoutAll(ctx(c), userId(c))
    return c.body(null, 204)
  })

  // Pengesahan emel. CORS: dipanggil oleh halaman Astro melalui fetch().
  r.post('/auth/verify-email/request', requireAuth, requireApproved, rateLimit('RL_VERIFY_EMAIL_REQUEST'), async (c) => {
    await service.requestEmailVerification(ctx(c), userId(c))
    return c.body(null, 204)
  })
  const verifyCors = cors('POST, OPTIONS')
  r.options('/auth/verify-email/confirm', verifyCors)
  r.post('/auth/verify-email/confirm', verifyCors, rateLimit('RL_AUTH'), async (c) => {
    await service.confirmEmailVerification(ctx(c), (await parseBody(c, schema.tokenSchema)).token)
    return c.body(null, 204)
  })
  // Dibuka terus dari pautan emel dalam pelayar - HTML, bukan JSON.
  r.get('/auth/verify-email/confirm', rateLimit('RL_AUTH'), async (c) => {
    const token = c.req.query('token') ?? ''
    if (!token) return html(c, 400, 'Pautan tidak sah.')
    try {
      await service.confirmEmailVerification(ctx(c), token)
    } catch (err) {
      return html(c, 400, `${err instanceof ApiError && err.status === 400 ? err.message : 'gagal sahkan email'}.`)
    }
    return html(c, 200, 'Email anda berjaya disahkan. Boleh kembali ke app MARC.')
  })

  // Reset kata laluan. Ciri mati (URL kosong) disemak SEBELUM parse body.
  r.post('/auth/password-reset/request', rateLimit('RL_PASSWORD_RESET'), async (c) => {
    if (!getConfig(c.env).PASSWORD_RESET_URL) return c.json({ error: 'reset kata laluan belum tersedia' }, 503)
    await service.requestPasswordReset(ctx(c), (await parseBody(c, schema.passwordResetRequestSchema)).email)
    return c.body(null, 204)
  })
  const resetCors = cors('POST, OPTIONS')
  r.options('/auth/password-reset/confirm', resetCors)
  r.post('/auth/password-reset/confirm', resetCors, rateLimit('RL_PASSWORD_RESET'), async (c) => {
    await service.confirmPasswordReset(ctx(c), await parseBody(c, schema.passwordResetConfirmSchema))
    return c.body(null, 204)
  })

  // Sesi peranti (self-service) - lapisan `protected`.
  r.get('/me/sessions', requireAuth, async (c) => c.json(sessionsDto(await service.sessions(ctx(c), userId(c)), sessionId(c))))
  r.post('/me/sessions/revoke', requireAuth, rateLimit('RL_PROFILE_UPDATE'), async (c) => {
    const { ids } = await parseBody(c, schema.revokeSessionsSchema)
    return c.json({ deleted: await service.revokeFamilies(ctx(c), userId(c), ids.map((i) => i.toLowerCase())) })
  })
  r.delete('/me/sessions/:id', requireAuth, rateLimit('RL_PROFILE_UPDATE'), async (c) => {
    await service.revokeFamilies(ctx(c), userId(c), [uuidParam(c, 'id')])
    return c.body(null, 204)
  })

  return r
}
