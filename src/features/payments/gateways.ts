// Kontrak Gateway (satu-satunya interface dengan >1 pelaksanaan) + Stripe +
// ToyyibPay melalui fetch terus. Pariti marc_go internal/payment.
import type { Config } from '../../shared/config'
import { safeEqual } from '../../shared/crypto'

export class NotConfigured extends Error {}
// Event webhook yang tidak berkaitan - pemanggil jawab 200 supaya gateway tidak retry.
export class IgnoredEvent extends Error {}

export type PaymentStatus = 'pending' | 'succeeded' | 'failed'

export type CreateResult = { gatewayRef: string; clientSecret?: string; redirectUrl?: string; rawResponse?: string }

export type WebhookEvent = { gatewayRef: string; status: 'succeeded' | 'failed'; paidAt: number }

export interface Gateway {
  name: string
  enabled: boolean
  createPayment(p: { amountCents: number; currency: string; metadata: Record<string, string> }): Promise<CreateResult>
  // `payload` = bait MENTAH (tandatangan Stripe dikira atasnya).
  verifyWebhook(payload: string, headers: Headers): Promise<WebhookEvent>
  checkStatus(gatewayRef: string): Promise<PaymentStatus>
}

export type Gateways = Record<'stripe' | 'toyyibpay' | 'toyyibpay-activity', Gateway>

const TIMEOUT = 15_000

// ---- Stripe ----

const STRIPE_API = 'https://api.stripe.com/v1'
const STRIPE_TOLERANCE_S = 300 // lalai stripe-go

function form(obj: Record<string, string>) {
  return new URLSearchParams(obj).toString()
}

async function hmacHex(key: string, data: string) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function stripeGateway(secretKey: string, webhookSecret: string, now = () => Date.now()): Gateway {
  const configured = secretKey !== ''
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${STRIPE_API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(TIMEOUT),
    })
    const body = await res.text()
    if (!res.ok) throw new Error(`stripe ${res.status}: ${body.slice(0, 500)}`)
    return JSON.parse(body) as Record<string, unknown>
  }
  return {
    name: 'stripe',
    enabled: configured,
    async createPayment({ amountCents, currency, metadata }) {
      if (!configured) throw new NotConfigured()
      const params: Record<string, string> = { amount: String(amountCents), currency, 'automatic_payment_methods[enabled]': 'true' }
      for (const [k, v] of Object.entries(metadata)) params[`metadata[${k}]`] = v
      const pi = await call('/payment_intents', { method: 'POST', body: form(params) })
      // client_secret ialah KELAYAKAN - dibuang daripada salinan untuk payment_logs.
      const { client_secret, ...logCopy } = pi
      return { gatewayRef: String(pi.id), clientSecret: String(client_secret), rawResponse: JSON.stringify(logCopy) }
    },
    async checkStatus(id) {
      if (!configured) throw new NotConfigured()
      const pi = await call(`/payment_intents/${encodeURIComponent(id)}`)
      if (pi.status === 'succeeded') return 'succeeded'
      if (pi.status === 'canceled' || pi.status === 'requires_payment_method') return 'failed'
      return 'pending'
    },
    async verifyWebhook(payload, headers) {
      if (!configured) throw new NotConfigured()
      // Rahsia kosong = sesiapa boleh menandatangan dengan kunci kosong → tolak.
      if (!webhookSecret) throw new NotConfigured()
      const parts = (headers.get('Stripe-Signature') ?? '').split(',').map((p) => p.split('=') as [string, string])
      const t = parts.find(([k]) => k === 't')?.[1]
      const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v)
      if (!t || !sigs.length) throw new Error('stripe: header tandatangan tiada')
      const expected = await hmacHex(webhookSecret, `${t}.${payload}`)
      if (!sigs.some((s) => safeEqual(s, expected))) throw new Error('stripe: tandatangan tidak padan')
      if (Math.abs(now() / 1000 - Number(t)) > STRIPE_TOLERANCE_S) throw new Error('stripe: cap masa di luar toleransi')
      // Versi API tidak disemak (pariti IgnoreAPIVersionMismatch): hanya type + id dibaca.
      const event = JSON.parse(payload) as { type: string; data: { object: { id: string; created: number } } }
      const status = { 'payment_intent.succeeded': 'succeeded', 'payment_intent.payment_failed': 'failed', 'payment_intent.canceled': 'failed' }[event.type] as
        | 'succeeded'
        | 'failed'
        | undefined
      if (!status) throw new IgnoredEvent()
      const pi = event.data.object
      // L27a: pi.created (masa intent), bukan masa caj - lihat marc_go stripe.go.
      return { gatewayRef: pi.id, status, paidAt: pi.created * 1000 }
    },
  }
}

// ---- ToyyibPay ----
// Callback TIDAK dipercayai: hanya `billcode` diambil, status sebenar disahkan
// dengan poll getBillTransactions (userSecretKey sisi pelayan).

// Pelbagai bentuk body callback (form / multipart / JSON), kunci tidak peka huruf.
export async function extractBillCode(payload: string, contentType: string): Promise<string> {
  const pick = (entries: Iterable<[string, unknown]>) => {
    for (const [k, v] of entries) if (k.toLowerCase() === 'billcode' && typeof v === 'string' && v) return v
    return ''
  }
  // URLSearchParams: `;` bukan pemisah dan `%` cacat tidak menggagalkan parse.
  const fromForm = pick(new URLSearchParams(payload))
  if (fromForm) return fromForm
  if (contentType.toLowerCase().startsWith('multipart/')) {
    try {
      const fd = await new Response(payload, { headers: { 'Content-Type': contentType } }).formData()
      const code = pick(fd.entries())
      if (code) return code
    } catch {
      // bukan multipart sah - cuba JSON
    }
  }
  try {
    const json = JSON.parse(payload) as unknown
    if (json && typeof json === 'object' && !Array.isArray(json)) return pick(Object.entries(json))
  } catch {
    // bukan JSON
  }
  return ''
}

// dd-mm-yyyy hh:mm:ss waktu Malaysia.
function mytStamp(ms: number) {
  const d = new Date(ms + 8 * 3600_000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCDate())}-${p(d.getUTCMonth() + 1)}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
}

export function toyyibpayGateway(o: { baseUrl: string; secretKey: string; categoryCode: string; callbackUrl: string; returnUrl: string }, now = () => Date.now()): Gateway {
  const configured = o.secretKey !== '' && o.categoryCode !== ''
  const base = (o.baseUrl || 'https://toyyibpay.com').replace(/\/+$/, '')
  const post = async (path: string, body: Record<string, string>) => {
    const res = await fetch(`${base}/index.php/api/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form(body),
      signal: AbortSignal.timeout(TIMEOUT),
    })
    return (await res.text()).slice(0, 1 << 20)
  }

  async function confirmStatus(billCode: string): Promise<WebhookEvent> {
    const body = await post('getBillTransactions', { userSecretKey: o.secretKey, billCode })
    if (body.trim() === 'No data found!') throw new IgnoredEvent()
    let txns: { billpaymentStatus?: string }[]
    try {
      txns = JSON.parse(body)
      if (!Array.isArray(txns)) throw new Error()
    } catch {
      throw new Error(`toyyibpay getBillTransactions: respons tak dijangka: ${body.slice(0, 500)}`)
    }
    // Imbas SEMUA transaksi: mana-mana "1" menang; "3" hanya bila tiada yang berjaya.
    if (txns.some((t) => t.billpaymentStatus === '1')) return { gatewayRef: billCode, status: 'succeeded', paidAt: now() }
    if (txns.some((t) => t.billpaymentStatus === '3')) return { gatewayRef: billCode, status: 'failed', paidAt: now() }
    throw new IgnoredEvent()
  }

  return {
    name: 'toyyibpay',
    enabled: configured,
    async createPayment({ amountCents, metadata }) {
      if (!configured) throw new NotConfigured()
      const body: Record<string, string> = {
        userSecretKey: o.secretKey,
        categoryCode: o.categoryCode,
        billName: 'Yuran MARC',
        billDescription: [...(metadata.description || 'Yuran keahlian MARC')].slice(0, 100).join(''),
        billPriceSetting: '1',
        billPayorInfo: '1',
        billAmount: String(amountCents), // sen
        billPaymentChannel: '2',
        billReturnUrl: o.returnUrl,
        billCallbackUrl: o.callbackUrl,
        billTo: metadata.billTo || 'Ahli MARC', // wajib (disahkan sandbox)
      }
      if (metadata.reference) body.billExternalReferenceNo = metadata.reference
      if (metadata.billEmail) body.billEmail = metadata.billEmail
      if (metadata.billPhone) body.billPhone = metadata.billPhone
      const mins = Number(metadata.billExpiryMinutes)
      if (Number.isInteger(mins) && mins > 0) body.billExpiryDate = mytStamp(now() + mins * 60_000)

      const raw = await post('createBill', body)
      let billCode = ''
      try {
        billCode = (JSON.parse(raw) as { BillCode?: string }[])[0]?.BillCode ?? ''
      } catch {
        // ditangani di bawah
      }
      if (!billCode) throw new Error(`toyyibpay createBill: respons tak dijangka: ${raw.slice(0, 500)}`)
      return { gatewayRef: billCode, redirectUrl: `${base}/${billCode}`, rawResponse: raw }
    },
    async verifyWebhook(payload, headers) {
      if (!configured) throw new NotConfigured()
      const billCode = await extractBillCode(payload, headers.get('Content-Type') ?? '')
      if (!billCode) throw new Error(`toyyibpay callback: billcode tidak dijumpai (content-type=${JSON.stringify(headers.get('Content-Type') ?? '')})`)
      return confirmStatus(billCode)
    },
    async checkStatus(billCode) {
      if (!configured) throw new NotConfigured()
      try {
        return (await confirmStatus(billCode)).status
      } catch (err) {
        if (err instanceof IgnoredEvent) return 'pending'
        throw err
      }
    },
  }
}

// Dua instance ToyyibPay: kredential SAMA, URL callback/return BERBEZA (dibakar
// ke dalam setiap bil - laluan ini tidak boleh berubah).
export function gatewaysFor(config: Config): Gateways {
  const base = config.PUBLIC_BASE_URL.replace(/\/+$/, '')
  const toyyib = (prefix: string) =>
    toyyibpayGateway({
      baseUrl: config.TOYYIBPAY_BASE_URL,
      secretKey: config.TOYYIBPAY_SECRET_KEY,
      categoryCode: config.TOYYIBPAY_CATEGORY_CODE,
      callbackUrl: `${base}/${prefix}/webhook/toyyibpay`,
      returnUrl: `${base}/${prefix}/return/toyyibpay`,
    })
  return {
    stripe: stripeGateway(config.STRIPE_SECRET_KEY, config.STRIPE_WEBHOOK_SECRET),
    toyyibpay: toyyib('registration-payments'),
    'toyyibpay-activity': toyyib('activity-registrations'),
  }
}
