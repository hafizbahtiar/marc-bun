// Laluan webhook & return TIDAK BOLEH berubah - URL dibakar ke dalam bil ToyyibPay hidup.
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { blockTesterWrites, requireApproved, requireVerified } from '../profile'
import { actorOf } from '../../shared/audit'
import { getConfig } from '../../shared/config'
import { ApiError, INVALID_DATA, parseBody, uuidParam } from '../../shared/http'
import { optionalAuth, requireAuth } from '../../shared/middleware/auth'
import { cors } from '../../shared/middleware/cors'
import { rateLimit } from '../../shared/middleware/rate-limit'
import type { AppEnv } from '../../shared/types'
import * as service from './service'
import type { PaymentsCtx, PaymentsDeps } from './service'

const runes = (max: number) => z.string().refine((s) => [...s].length <= max)
const donation = z.object({
  amount_cents: z.number().int().refine((n) => n !== 0), // `required` Go: sifar ditolak
  donor_name: runes(200).default(''),
  donor_email: z.union([z.literal(''), z.email().max(254)]).default(''),
})

// Body kosong sah (ahli yang sudah ada telefon); JSON cacat → 400.
async function optionalPhone(c: Context<AppEnv>): Promise<string> {
  const text = await c.req.text()
  if (!text) return ''
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new ApiError(400, INVALID_DATA)
  }
  const parsed = z.object({ phone: z.string().default('') }).safeParse(body)
  if (!parsed.success) throw new ApiError(400, INVALID_DATA)
  return parsed.data.phone
}

const returnPage = (title: string, text: string) => `<!doctype html>
<html lang="ms"><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family: sans-serif; padding: 40px; text-align: center;">
<h2>MARC</h2>
<p>${text}</p>
</body></html>`

const REG_RETURN = returnPage('Yuran Pendaftaran MARC', 'Terima kasih. Pembayaran anda sedang diproses. Boleh kembali ke app MARC - status akan dikemas kini automatik sebaik pembayaran disahkan.')
const ACT_RETURN = returnPage('Yuran Aktiviti MARC', 'Terima kasih. Pembayaran yuran aktiviti anda sedang diproses. Boleh kembali ke app MARC - status akan dikemas kini automatik sebaik pembayaran disahkan.')

export function paymentsRoutes(deps: PaymentsDeps) {
  const r = new Hono<AppEnv>()
  const ctx = (c: Context<AppEnv>): PaymentsCtx => {
    const config = getConfig(c.env)
    return { env: c.env, config, deps, gateways: deps.gateways(config), now: Date.now(), actor: actorOf(c), userId: c.get('userId') ?? null, waitUntil: (p) => c.executionCtx.waitUntil(p) }
  }
  const webhookResponse = (c: Context<AppEnv>, o: Awaited<ReturnType<typeof service.donationWebhook>>) => (o.kind === 'ok' ? c.json({ ok: true }) : c.json({ error: o.error }, o.status))
  const pdf = (c: Context<AppEnv>, f: service.PdfFile) =>
    c.body(f.pdf as Uint8Array<ArrayBuffer>, 200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${f.filename}"` })
  // Halaman makluman; bukan sumber status. URL diset → 302 dengan query ToyyibPay dikekalkan.
  const returnRoute = (target: (c: Context<AppEnv>) => string, html: string) => (c: Context<AppEnv>) => {
    const url = target(c)
    if (!url) return c.html(html)
    const q = new URL(c.req.url).search
    return c.redirect(url + q, 302)
  }

  // Derma: awam + optionalAuth (ahli log masuk dikaitkan user_id).
  r.post('/donations/checkout', rateLimit('RL_DONATION'), optionalAuth, blockTesterWrites, async (c) => c.json(await service.donationCheckout(ctx(c), await parseBody(c, donation))))
  r.post('/webhooks/:gateway', rateLimit('RL_PAYMENT_WEBHOOK'), async (c) => webhookResponse(c, await service.donationWebhook(ctx(c), c.req.param('gateway'), await c.req.text(), c.req.raw.headers)))
  r.get('/payment-status/:gateway/:reference', cors('GET, OPTIONS'), rateLimit('RL_PAYMENT_STATUS'), async (c) =>
    c.json(await service.paymentStatus(ctx(c), c.req.param('gateway'), c.req.param('reference'))),
  )

  // Yuran pendaftaran: `protected` - ahli pending mesti boleh bayar semasa menunggu.
  r.post('/registration-payments/checkout', requireAuth, rateLimit('RL_REGISTRATION_PAYMENT_CHECKOUT'), blockTesterWrites, async (c) =>
    c.json(await service.registrationCheckout(ctx(c), await optionalPhone(c))),
  )
  r.post('/registration-payments/webhook/toyyibpay', rateLimit('RL_PAYMENT_WEBHOOK'), async (c) => webhookResponse(c, await service.registrationWebhook(ctx(c), await c.req.text(), c.req.raw.headers)))
  r.get('/registration-payments/return/toyyibpay', returnRoute((c) => getConfig(c.env).REGISTRATION_PAYMENT_RETURN_URL, REG_RETURN))
  r.get('/payment-config', requireAuth, (c) => c.json({ gateway_charge_cents: getConfig(c.env).GATEWAY_CHARGE_CENTS }))

  // Yuran aktiviti
  r.post('/activities/:id/registration/checkout', requireAuth, requireApproved, requireVerified, rateLimit('RL_ACTIVITY_PAYMENT_CHECKOUT'), blockTesterWrites, async (c) => {
    const id = uuidParam(c, 'id')
    return c.json(await service.activityCheckout(ctx(c), id, await optionalPhone(c)))
  })
  r.post('/activity-registrations/webhook/toyyibpay', rateLimit('RL_PAYMENT_WEBHOOK'), async (c) => webhookResponse(c, await service.activityWebhook(ctx(c), await c.req.text(), c.req.raw.headers)))
  r.get('/activity-registrations/return/toyyibpay', returnRoute((c) => getConfig(c.env).ACTIVITY_PAYMENT_RETURN_URL, ACT_RETURN))

  // Sejarah & resit (sendiri sahaja)
  r.get('/me/payments', requireAuth, async (c) => c.json(await service.mine(ctx(c))))
  r.get('/me/payments/registration/:id/receipt', requireAuth, rateLimit('RL_PAYMENT_RECEIPT'), async (c) => pdf(c, await service.registrationReceipt(ctx(c), uuidParam(c, 'id'))))
  r.get('/me/payments/activity/:id/receipt', requireAuth, rateLimit('RL_PAYMENT_RECEIPT'), async (c) => pdf(c, await service.activityReceipt(ctx(c), uuidParam(c, 'id'))))
  r.get('/me/payments/donation/:id/receipt', requireAuth, rateLimit('RL_PAYMENT_RECEIPT'), async (c) => pdf(c, await service.donationReceipt(ctx(c), uuidParam(c, 'id'))))

  // Pengurusan
  r.get('/admin/payments', requireAuth, requireApproved, async (c) => c.json(await service.adminLogs(ctx(c), c.req.query())))
  r.post('/admin/payments/reconcile', requireAuth, requireApproved, async (c) => c.json(await service.manualReconcile(ctx(c))))
  r.post('/members/:id/cancel-registration-payment', requireAuth, requireApproved, async (c) => c.json(await service.cancelRegistrationPayment(ctx(c), uuidParam(c, 'id'))))

  return r
}
