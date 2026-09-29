// Tiga modul bayaran di atas satu kontrak Gateway - pariti marc_go handlers/
// {donations,registration_payment,activity_registration_payment,payments,
// payment_status,payment_reconcile}.go + ProfileHandler.CancelMemberRegistrationPayment.
import { atLeastRole, isManagement, setPhone } from '../profile'
import { activeRegistration, markPaidByRef, setPaymentRefStmt } from '../registrations'
import { auditStmt, type Actor } from '../../shared/audit'
import type { Config } from '../../shared/config'
import { uuid } from '../../shared/db'
import type { SendEmail } from '../../shared/email'
import { ApiError } from '../../shared/http'
import { normalizeMY } from '../../shared/phone'
import { toJson } from '../../shared/time'
import { IgnoredEvent, NotConfigured, type Gateway, type Gateways } from './gateways'
import { runReconcile } from './jobs'
import { donationPdf, feePdf, filename, receiptEmail, type ReceiptEmail } from './receipt'
import * as repo from './repo'
import type { Payer } from './repo'

export type PaymentsDeps = { sendEmail: SendEmail; gateways: (config: Config) => Gateways }

export type PaymentsCtx = {
  env: CloudflareBindings
  config: Config
  deps: PaymentsDeps
  gateways: Gateways
  now: number
  actor: Actor
  userId: string | null
  waitUntil(p: Promise<unknown>): void
}

const FAILED_START = 'gagal mulakan pembayaran'
const truncate = (s: string) => (s.length <= 500 ? s : `${s.slice(0, 500)}…(truncated)`)
const err = (e: unknown) => truncate(e instanceof Error ? e.message : String(e))
const logError = (msg: string, extra: Record<string, unknown>) => console.error(JSON.stringify({ level: 'error', msg, ...extra }))

// Resit emel best-effort: kegagalan PDF = emel HTML tanpa lampiran; kegagalan emel = log.
function sendReceipt(ctx: PaymentsCtx, to: string, r: Omit<ReceiptEmail, 'pdf'>, pdf: () => Promise<Uint8Array>) {
  ctx.waitUntil(
    (async () => {
      let bytes: Uint8Array | null = null
      try {
        bytes = await pdf()
      } catch (e) {
        logError('resit: gagal jana PDF', { ref: r.gatewayRef, error: String(e) })
      }
      const mail = receiptEmail({ ...r, pdf: bytes })
      await ctx.deps.sendEmail(ctx.config, { to, ...mail })
    })().catch((e) => logError('gagal hantar resit emel', { kind: r.kind, ref: r.gatewayRef, error: String(e) })),
  )
}

type WebhookOutcome = { kind: 'ok' } | { kind: 'error'; status: 400 | 503; error: string }

// Rangka webhook dikongsi: log mentah DAHULU, sahkan, kemudian `apply`.
async function webhook(ctx: PaymentsCtx, gw: Gateway, module: repo.LogEntry['module'], payload: string, headers: Headers, apply: (e: { gatewayRef: string; status: 'succeeded' | 'failed'; paidAt: number }) => Promise<void>): Promise<WebhookOutcome> {
  const db = ctx.env.DB
  await repo.log(db, { module, event: 'webhook_received', status: 'ok', gateway: gw.name, rawPayload: payload })
  let event
  try {
    event = await gw.verifyWebhook(payload, headers)
  } catch (e) {
    if (e instanceof IgnoredEvent) return { kind: 'ok' }
    // Rahsia belum diisi: gagal-tertutup, bukan terima event tidak disahkan.
    if (e instanceof NotConfigured) return { kind: 'error', status: 503, error: 'webhook belum dikonfigurasi' }
    logError(`webhook ${gw.name}: verify gagal`, { module, error: String(e) })
    await repo.log(db, { module, event: 'webhook_verify_failed', status: 'error', gateway: gw.name, message: err(e) })
    return { kind: 'error', status: 400, error: 'signature tidak sah' }
  }
  // Ralat DB tidak digagalkan: gateway retry berterusan kalau bukan 200.
  await apply(event).catch((e) => logError(`webhook ${gw.name}: kemas kini gagal`, { module, ref: event.gatewayRef, error: String(e) }))
  return { kind: 'ok' }
}

const billTo = (p: Payer) => p.display_name || p.member_id || p.email

// ToyyibPay wajibkan billPhone. Telefon tersimpan yang cacat = seperti kosong;
// nombor baharu disimpan ke profil supaya tidak ditanya lagi.
async function billPhone(ctx: PaymentsCtx, p: Payer, bodyPhone: string, onRequired: () => Promise<void>): Promise<string> {
  const stored = p.phone ? normalizeMY(p.phone) : null
  if (stored) return stored
  const trimmed = bodyPhone.trim()
  if (!trimmed) {
    await onRequired()
    throw new ApiError(400, 'sila isi nombor telefon dahulu', { code: 'phone_required' })
  }
  const normalized = normalizeMY(trimmed)
  if (!normalized) throw new ApiError(400, 'format nombor telefon tidak sah')
  try {
    await setPhone(ctx.env.DB, ctx.userId!, normalized, ctx.now)
  } catch (e) {
    logError('simpan phone semasa checkout', { error: String(e) })
    throw new ApiError(500, FAILED_START)
  }
  return normalized
}

// ---- derma (Stripe) ----

export async function donationCheckout(ctx: PaymentsCtx, input: { amount_cents: number; donor_name: string; donor_email: string }) {
  if (input.amount_cents < 100 || input.amount_cents > 5_000_000) throw new ApiError(400, 'amount tidak sah')
  const gw = ctx.gateways.stripe
  if (!gw.enabled) throw new ApiError(503, 'donation belum tersedia')
  const email = input.donor_email.trim().toLowerCase()
  const name = input.donor_name.trim()
  // Anonim WAJIB emel - setiap derma mesti boleh dijejak.
  if (!ctx.userId && !email) throw new ApiError(400, 'email diperlukan untuk donation tanpa log masuk')

  const db = ctx.env.DB
  let result
  try {
    result = await gw.createPayment({ amountCents: input.amount_cents, currency: 'myr', metadata: { donor_name: name, donor_email: email } })
  } catch (e) {
    await repo.log(db, { module: 'donation', event: 'checkout_failed', status: 'error', gateway: gw.name, message: err(e) })
    throw new ApiError(500, FAILED_START)
  }
  const id = uuid()
  try {
    await repo.createDonation(db, { id, user_id: ctx.userId, donor_name: name || null, donor_email: email || null, amount_cents: input.amount_cents, currency: 'myr', gateway: gw.name, gateway_ref: result.gatewayRef }, ctx.now)
  } catch (e) {
    logError('create donation row', { error: String(e) })
    throw new ApiError(500, FAILED_START)
  }
  await repo.log(db, { module: 'donation', event: 'checkout_created', status: 'ok', gateway: gw.name, gatewayRef: result.gatewayRef, amountCents: input.amount_cents, userId: ctx.userId, relatedId: id, message: gw.name, rawPayload: result.rawResponse })
  return { gateway: gw.name, client_secret: result.clientSecret ?? '', redirect_url: result.redirectUrl ?? '' }
}

export async function donationWebhook(ctx: PaymentsCtx, gatewayName: string, payload: string, headers: Headers): Promise<WebhookOutcome> {
  const gw = (ctx.gateways as Record<string, Gateway | undefined>)[gatewayName]
  if (!gw?.enabled) return { kind: 'error', status: 503, error: 'donation belum tersedia' }
  const db = ctx.env.DB
  return webhook(ctx, gw, 'donation', payload, headers, async (event) => {
    const d = await repo.updateDonationStatus(db, gw.name, event.gatewayRef, event.status)
    if (!d) return // replay / bukan milik kita
    await repo.log(db, { module: 'donation', event: 'status_updated', status: event.status, gateway: gw.name, gatewayRef: event.gatewayRef, amountCents: d.amount_cents, relatedId: d.id })
    if (event.status !== 'succeeded') return
    // Tepat sekali: hanya peralihan sebenar sampai ke sini.
    const p = d.user_id ? await repo.payer(db, d.user_id).catch(() => null) : null
    const to = d.donor_email ?? p?.email
    if (!to) return logError('resit donation: tiada emel', { ref: d.gateway_ref })
    const r = { memberId: p?.member_id ?? '', donorName: d.donor_name ?? '', donorEmail: d.donor_email ?? to, amountCents: d.amount_cents, currency: d.currency, gatewayRef: d.gateway_ref, paidAt: event.paidAt }
    sendReceipt(ctx, to, { kind: 'donation', payerName: r.donorName, purpose: '', amountCents: d.amount_cents, currency: d.currency, gatewayRef: d.gateway_ref, fallbackId: d.id, paidAt: event.paidAt }, () => donationPdf(r))
  })
}

// ---- yuran pendaftaran (ToyyibPay, sekali bayar) ----

export async function registrationCheckout(ctx: PaymentsCtx, bodyPhone: string) {
  const gw = ctx.gateways.toyyibpay
  if (!gw.enabled) throw new ApiError(503, 'pembayaran yuran pendaftaran belum tersedia')
  const db = ctx.env.DB
  const userId = ctx.userId!
  const p = await repo.payer(db, userId)
  if (!p) throw new ApiError(500, FAILED_START)
  const failed = (message: string) => repo.log(db, { module: 'registration_fee', event: 'checkout_failed', status: 'error', gateway: gw.name, userId, message })
  if (p.status === 'approved') {
    await failed('sudah diluluskan')
    throw new ApiError(400, 'akaun anda sudah diluluskan, tiada yuran pendaftaran perlu dibayar')
  }
  if (await repo.hasSucceededRegPayment(db, userId)) {
    await failed('sudah dibayar')
    throw new ApiError(400, 'yuran pendaftaran anda sudah dibayar')
  }
  const phone = await billPhone(ctx, p, bodyPhone, () => failed('phone_required'))

  const fee = ctx.config.REGISTRATION_FEE_CENTS
  const id = uuid()
  // L29: baris DAHULU, bil KEMUDIAN.
  try {
    await repo.createRegPayment(db, { id, userId, amountCents: fee, gateway: gw.name, now: ctx.now })
  } catch (e) {
    await repo.log(db, { module: 'registration_fee', event: 'checkout_failed', status: 'error', gateway: gw.name, amountCents: fee, userId, message: truncate(`baris DB gagal ditulis sebelum createBill: ${err(e)}`) })
    throw new ApiError(500, FAILED_START)
  }
  let result
  try {
    result = await gw.createPayment({
      amountCents: fee,
      currency: 'myr',
      metadata: { description: 'Yuran pendaftaran ahli MARC', reference: p.member_id ?? '', billTo: billTo(p), billEmail: p.email, billPhone: phone, billExpiryMinutes: String(ctx.config.REGISTRATION_BILL_EXPIRY_MINUTES) },
    })
  } catch (e) {
    // Tiada bil → baris tidak akan selesai; tanda gagal supaya /me jujur.
    await repo.markRegPaymentFailedNoRef(db, id).run().catch(() => {})
    await repo.log(db, { module: 'registration_fee', event: 'checkout_failed', status: 'error', gateway: gw.name, amountCents: fee, userId, relatedId: id, message: err(e) })
    throw new ApiError(500, FAILED_START)
  }
  const linked = await repo.setRegPaymentRef(db, id, result.gatewayRef).catch(() => null)
  if (!linked) {
    // Bil wujud tetapi tidak dipaut: kedua-dua belah pautan direkod untuk pautan manual.
    logError('registration_payment: bil dicipta tapi gagal dipautkan - perlukan pautan manual', { ref: result.gatewayRef, payment: id })
    await repo.log(db, { module: 'registration_fee', event: 'checkout_failed', status: 'mismatch', gateway: gw.name, gatewayRef: result.gatewayRef, amountCents: fee, userId, relatedId: id, message: 'bil dicipta tapi gagal dipautkan ke baris bayaran', rawPayload: result.rawResponse })
    throw new ApiError(500, FAILED_START)
  }
  await repo.log(db, { module: 'registration_fee', event: 'checkout_created', status: 'ok', gateway: gw.name, gatewayRef: result.gatewayRef, amountCents: fee, userId, relatedId: id, rawPayload: result.rawResponse })
  return { redirect_url: result.redirectUrl }
}

export async function registrationWebhook(ctx: PaymentsCtx, payload: string, headers: Headers): Promise<WebhookOutcome> {
  const gw = ctx.gateways.toyyibpay
  if (!gw.enabled) return { kind: 'error', status: 503, error: 'pembayaran yuran pendaftaran belum tersedia' }
  const db = ctx.env.DB
  return webhook(ctx, gw, 'registration_fee', payload, headers, async (event) => {
    const row = await repo.updateRegPaymentStatus(db, gw.name, event.gatewayRef, event.status)
    if (!row) return
    await repo.log(db, { module: 'registration_fee', event: 'status_updated', status: event.status, gateway: gw.name, gatewayRef: event.gatewayRef, amountCents: row.amount_cents, relatedId: row.id })
    if (event.status !== 'succeeded') return
    const p = await repo.payer(db, row.user_id)
    if (!p) return logError('resit yuran pendaftaran: profil tiada', { user: row.user_id })
    const purpose = 'Yuran Pendaftaran Ahli'
    const fee = { memberId: p.member_id ?? '', payerName: p.display_name ?? '', payerEmail: p.email, amountCents: row.amount_cents, currency: row.currency, gatewayRef: event.gatewayRef, paidAt: ctx.now, purpose, gatewayChargeCents: ctx.config.GATEWAY_CHARGE_CENTS }
    sendReceipt(ctx, p.email, { kind: 'registration_fee', payerName: fee.payerName, purpose, amountCents: row.amount_cents, currency: row.currency, gatewayRef: event.gatewayRef, fallbackId: '', paidAt: ctx.now }, () => feePdf(fee))
  })
}

// ---- yuran aktiviti (ToyyibPay, instance kedua) ----

export async function activityCheckout(ctx: PaymentsCtx, activityId: string, bodyPhone: string) {
  const gw = ctx.gateways['toyyibpay-activity']
  if (!gw.enabled) throw new ApiError(503, 'pembayaran yuran aktiviti belum tersedia')
  const db = ctx.env.DB
  const userId = ctx.userId!
  const reg = await activeRegistration(db, activityId, userId)
  if (!reg) throw new ApiError(400, 'anda belum berdaftar untuk aktiviti ini, daftar dahulu')
  if (reg.payment_status === 'paid') throw new ApiError(400, 'yuran aktiviti ini sudah dibayar')
  if (reg.payment_status === 'not_required') throw new ApiError(400, 'aktiviti ini percuma, tiada yuran perlu dibayar')
  // Checkout berulang menggantikan payment_ref (bil lama yatim) - disengajakan, dilog sahaja.
  if (reg.payment_ref) console.log(JSON.stringify({ level: 'warn', msg: 'checkout yuran aktiviti: ganti payment_ref sedia ada', registration: reg.id }))
  const activity = await repo.activityForCheckout(db, activityId)
  if (!activity) throw new ApiError(404, 'aktiviti tidak dijumpai')
  const p = await repo.payer(db, userId)
  if (!p) throw new ApiError(500, FAILED_START)
  const phone = await billPhone(ctx, p, bodyPhone, async () => {})

  let result
  try {
    result = await gw.createPayment({
      amountCents: activity.fee_cents,
      currency: 'myr',
      metadata: { description: `Yuran aktiviti: ${activity.title}`, reference: reg.id, billTo: billTo(p), billEmail: p.email, billPhone: phone },
    })
  } catch (e) {
    await repo.log(db, { module: 'activity_fee', event: 'checkout_failed', status: 'error', gateway: gw.name, userId, message: err(e) })
    throw new ApiError(500, FAILED_START)
  }
  const linked = await setPaymentRefStmt(db, reg.id, result.gatewayRef, activity.fee_cents)
    .first()
    .catch(() => null)
  if (!linked) {
    logError('activity_registration_payment: bil dicipta tapi payment_ref gagal ditulis - bil yatim', { ref: result.gatewayRef, registration: reg.id })
    await repo.log(db, { module: 'activity_fee', event: 'checkout_failed', status: 'mismatch', gateway: gw.name, gatewayRef: result.gatewayRef, amountCents: activity.fee_cents, userId, relatedId: reg.id, message: 'bil dicipta tapi payment_ref gagal ditulis (bil yatim)', rawPayload: result.rawResponse })
    throw new ApiError(500, FAILED_START)
  }
  await repo.log(db, { module: 'activity_fee', event: 'checkout_created', status: 'ok', gateway: gw.name, gatewayRef: result.gatewayRef, amountCents: activity.fee_cents, userId, relatedId: reg.id, rawPayload: result.rawResponse })
  return { redirect_url: result.redirectUrl }
}

export async function activityWebhook(ctx: PaymentsCtx, payload: string, headers: Headers): Promise<WebhookOutcome> {
  const gw = ctx.gateways['toyyibpay-activity']
  if (!gw.enabled) return { kind: 'error', status: 503, error: 'pembayaran yuran aktiviti belum tersedia' }
  const db = ctx.env.DB
  return webhook(ctx, gw, 'activity_fee', payload, headers, async (event) => {
    // payment_status tiada 'failed' (CHECK): gagal = dilog sahaja, sweep membersihkan.
    if (event.status !== 'succeeded') {
      await repo.log(db, { module: 'activity_fee', event: 'status_updated', status: 'failed', gateway: gw.name, gatewayRef: event.gatewayRef })
      return
    }
    const reg = await markPaidByRef(db, event.gatewayRef)
    if (!reg) return
    if (reg.status === 'cancelled') {
      // Bayar selepas sweep membatal: perlukan semakan manual (slot mungkin sudah diambil).
      logError('activity_registration_payment: ahli BAYAR tapi pendaftaran SUDAH DIBATAL oleh sapuan', { ref: event.gatewayRef, registration: reg.id })
      await repo.log(db, { module: 'activity_fee', event: 'status_updated', status: 'mismatch', gateway: gw.name, gatewayRef: event.gatewayRef, relatedId: reg.id, message: 'ahli bayar tapi pendaftaran sudah dibatal oleh sapuan' })
      return
    }
    await repo.log(db, { module: 'activity_fee', event: 'status_updated', status: 'succeeded', gateway: gw.name, gatewayRef: event.gatewayRef, relatedId: reg.id })
    const [p, a] = await Promise.all([repo.payer(db, reg.user_id), repo.activityForCheckout(db, reg.activity_id)])
    if (!p || !a) return logError('resit yuran aktiviti: profil/aktiviti tiada', { registration: reg.id })
    const amount = reg.fee_cents_paid ?? a.fee_cents
    const fee = { memberId: p.member_id ?? '', payerName: p.display_name ?? '', payerEmail: p.email, amountCents: amount, currency: a.currency, gatewayRef: event.gatewayRef, paidAt: ctx.now, purpose: a.title, gatewayChargeCents: ctx.config.GATEWAY_CHARGE_CENTS }
    sendReceipt(ctx, p.email, { kind: 'activity_fee', payerName: fee.payerName, purpose: a.title, amountCents: amount, currency: a.currency, gatewayRef: event.gatewayRef, fallbackId: '', paidAt: ctx.now }, () => feePdf(fee))
  })
}

// ---- status (awam) ----

export async function paymentStatus(ctx: PaymentsCtx, gatewayName: string, rawRef: string) {
  const ref = rawRef.trim()
  if (ref.length < 3 || ref.length > 128 || !/^[A-Za-z0-9_-]+$/.test(ref)) throw new ApiError(400, 'rujukan bayaran tidak sah')
  const gw = (ctx.gateways as Record<string, Gateway | undefined>)[gatewayName]
  if (!gw?.enabled) throw new ApiError(503, 'gateway bayaran belum tersedia')
  try {
    return { status: await gw.checkStatus(ref) }
  } catch {
    throw new ApiError(502, 'status bayaran belum dapat disemak')
  }
}

// ---- sejarah & resit ----

export async function mine(ctx: PaymentsCtx) {
  const db = ctx.env.DB
  const userId = ctx.userId!
  try {
    const [reg, act, don, outstanding] = await Promise.all([
      repo.myRegPayments(db, userId),
      repo.myActivityPayments(db, userId),
      repo.myDonations(db, userId),
      repo.outstandingFeeStmt(db, userId, ctx.config.REGISTRATION_FEE_CENTS).first<{ cents: number | null }>(),
    ])
    if (!outstanding) throw new Error('profil tiada')
    return {
      registration_fee: reg.map((r) => ({ id: r.id, amount_cents: r.amount_cents, currency: r.currency, gateway: r.gateway, status: r.status, created_at: toJson(r.created_at) })),
      activity_fees: act.map((r) => ({
        registration_id: r.id,
        activity_id: r.activity_id,
        title: r.title,
        fee_cents: r.fee_cents,
        currency: r.currency,
        starts_at: toJson(r.starts_at),
        registration_status: r.status,
        payment_status: r.payment_status,
        registered_at: toJson(r.registered_at),
      })),
      donations: don.map((d) => ({ id: d.id, amount_cents: d.amount_cents, currency: d.currency, gateway: d.gateway, status: d.status, created_at: toJson(d.created_at) })),
      // SATU pengiraan dengan /dashboard (outstandingFeeStmt).
      outstanding_registration_fee: outstanding.cents !== null,
    }
  } catch {
    throw new ApiError(500, 'gagal muat sejarah bayaran')
  }
}

export type PdfFile = { filename: string; pdf: Uint8Array }

async function render(make: () => Promise<Uint8Array>): Promise<Uint8Array> {
  try {
    return await make()
  } catch (e) {
    logError('resit: gagal jana PDF', { error: String(e) })
    throw new ApiError(500, 'gagal jana resit')
  }
}

const NOT_YET = 'bayaran belum berjaya, resit belum tersedia'

export async function registrationReceipt(ctx: PaymentsCtx, id: string): Promise<PdfFile> {
  const r = await repo.myRegPaymentForReceipt(ctx.env.DB, id, ctx.userId!)
  if (!r) throw new ApiError(404, 'resit tidak dijumpai')
  if (r.status !== 'succeeded') throw new ApiError(409, NOT_YET)
  const ref = r.gateway_ref ?? ''
  const pdf = await render(() =>
    feePdf({ memberId: r.member_id ?? '', payerName: r.display_name ?? '', payerEmail: r.email, amountCents: r.amount_cents, currency: r.currency, gatewayRef: ref, paidAt: r.created_at, purpose: 'Yuran Pendaftaran Ahli', gatewayChargeCents: ctx.config.GATEWAY_CHARGE_CENTS }),
  )
  return { filename: filename('Pendaftaran', ref, r.id), pdf }
}

export async function activityReceipt(ctx: PaymentsCtx, id: string): Promise<PdfFile> {
  const r = await repo.myActivityFee(ctx.env.DB, id, ctx.userId!)
  if (!r) throw new ApiError(404, 'resit tidak dijumpai')
  if (r.payment_status === 'refunded') throw new ApiError(409, 'bayaran telah dikembalikan, resit tidak lagi tersedia')
  if (r.payment_status !== 'paid') throw new ApiError(409, NOT_YET)
  const ref = r.payment_ref ?? ''
  // registered_at: tiada lajur "disahkan pada" (pariti marc_go).
  const pdf = await render(() =>
    feePdf({ memberId: r.member_id ?? '', payerName: r.display_name ?? '', payerEmail: r.email, amountCents: r.fee_cents, currency: r.currency, gatewayRef: ref, paidAt: r.registered_at, purpose: r.title, gatewayChargeCents: ctx.config.GATEWAY_CHARGE_CENTS }),
  )
  return { filename: filename('Aktiviti', ref, r.id), pdf }
}

export async function donationReceipt(ctx: PaymentsCtx, id: string): Promise<PdfFile> {
  const db = ctx.env.DB
  const d = await repo.myDonation(db, id, ctx.userId!)
  if (!d) throw new ApiError(404, 'resit tidak dijumpai')
  if (d.status !== 'succeeded') throw new ApiError(409, NOT_YET)
  const p = await repo.payer(db, ctx.userId!).catch(() => null)
  const pdf = await render(() => donationPdf({ memberId: p?.member_id ?? '', donorName: d.donor_name ?? '', donorEmail: d.donor_email ?? '', amountCents: d.amount_cents, currency: d.currency, gatewayRef: d.gateway_ref, paidAt: d.created_at }))
  return { filename: filename('Sokongan', d.gateway_ref, d.id), pdf }
}

// ---- pengurusan ----

const ALL_MODULES = ['donation', 'registration_fee', 'activity_fee']

export async function adminLogs(ctx: PaymentsCtx, q: { limit?: string; module?: string; before_id?: string }) {
  const db = ctx.env.DB
  let management: boolean
  let superadmin: boolean
  try {
    management = await isManagement(db, ctx.userId!)
    if (!management) throw new ApiError(403, 'akses ditolak')
    // Data derma dikunci kepada superadmin.
    superadmin = await atLeastRole(db, ctx.userId!, 'superadmin')
  } catch (e) {
    if (e instanceof ApiError) throw e
    throw new ApiError(500, 'gagal muat senarai bayaran')
  }
  let limit = 50
  if (q.limit) {
    const n = /^[+-]?\d+$/.test(q.limit) ? Number(q.limit) : NaN
    if (!(n > 0)) throw new ApiError(400, 'limit tidak sah')
    limit = Math.min(n, 200)
  }
  let modules: string[]
  if (q.module) {
    if (!ALL_MODULES.includes(q.module)) throw new ApiError(400, 'modul tidak sah')
    if (q.module === 'donation' && !superadmin) throw new ApiError(403, 'modul derma untuk superadmin sahaja')
    modules = [q.module]
  } else modules = superadmin ? ALL_MODULES : ['registration_fee', 'activity_fee']
  let beforeId: number | null = null
  if (q.before_id) {
    if (!/^[+-]?\d+$/.test(q.before_id)) throw new ApiError(400, 'before_id tidak sah')
    beforeId = Number(q.before_id)
  }
  try {
    const rows = await repo.listLogs(db, modules, beforeId, limit)
    return { logs: rows.map((r) => ({ ...r, created_at: toJson(r.created_at) })) }
  } catch {
    throw new ApiError(500, 'gagal muat senarai bayaran')
  }
}

export async function manualReconcile(ctx: PaymentsCtx) {
  let ok: boolean
  try {
    ok = await isManagement(ctx.env.DB, ctx.userId!)
  } catch {
    throw new ApiError(500, 'gagal jalankan reconcile')
  }
  if (!ok) throw new ApiError(403, 'akses ditolak')
  return runReconcile(ctx.env.DB, ctx.gateways, ctx.now)
}

// POST /members/:id/cancel-registration-payment - admin ke atas. Gateway disemak
// DAHULU: yang sudah dibayar tidak boleh dibatalkan.
export async function cancelRegistrationPayment(ctx: PaymentsCtx, targetId: string) {
  const db = ctx.env.DB
  const FAIL = 'gagal batalkan bil pendaftaran'
  let admin: boolean
  try {
    admin = await atLeastRole(db, ctx.userId!, 'admin')
  } catch {
    throw new ApiError(500, FAIL)
  }
  if (!admin) throw new ApiError(403, 'cuma admin/superadmin boleh batalkan bil pendaftaran')
  if (targetId === ctx.userId) throw new ApiError(400, 'tidak boleh laksanakan tindakan ini pada akaun sendiri')
  if (!(await repo.payer(db, targetId))) throw new ApiError(404, 'ahli tidak dijumpai')
  const pending = await repo.latestPendingRegPayment(db, targetId)
  if (!pending) throw new ApiError(404, 'tiada bil pendaftaran pending untuk ahli ini')

  const audit = auditStmt(
    db,
    {
      entityType: 'profile',
      entityId: targetId,
      action: 'update',
      actor: ctx.actor,
      old: { registration_payment_status: 'pending', ...(pending.gateway_ref && { gateway_ref: pending.gateway_ref }) },
      new: { registration_payment_status: 'failed', cancelled_by_admin: true, payment_id: pending.id },
    },
    { sql: "EXISTS (SELECT 1 FROM registration_payments WHERE id = ? AND status = 'failed')", params: [pending.id] },
  )!
  const done = { status: 'failed', payment_id: pending.id }
  const gw = ctx.gateways.toyyibpay

  if (!pending.gateway_ref) {
    // Tiada bil pernah dicipta - selamat ditanda gagal terus.
    await db.batch([repo.markRegPaymentFailedNoRef(db, pending.id), audit]).catch(() => {
      throw new ApiError(500, FAIL)
    })
    return done
  }
  if (gw.enabled) {
    let status
    try {
      status = await gw.checkStatus(pending.gateway_ref)
    } catch {
      throw new ApiError(502, 'gagal semak status bil di gateway')
    }
    if (status === 'succeeded') {
      await repo.updateRegPaymentStatus(db, pending.gateway, pending.gateway_ref, 'succeeded').catch(() => {
        throw new ApiError(500, FAIL)
      })
      throw new ApiError(409, 'ahli sudah bayar yuran pendaftaran - luluskan tanpa langkau bayaran')
    }
    if (status === 'failed') {
      await db
        .batch([repo.updateRegPaymentStatusStmt(db, pending.gateway, pending.gateway_ref, 'failed'), audit])
        .catch(() => {
          throw new ApiError(500, FAIL)
        })
      return done
    }
  }
  const [expired] = await db.batch([repo.expireRegPaymentStmt(db, pending.id), audit]).catch(() => {
    throw new ApiError(500, FAIL)
  })
  const row = expired!.results[0] as repo.RegPayment | undefined
  if (!row) throw new ApiError(409, 'bil pendaftaran sudah tidak pending')
  await repo.log(db, { module: 'registration_fee', event: 'reconcile_check', status: 'failed', gateway: row.gateway, gatewayRef: row.gateway_ref ?? '', amountCents: row.amount_cents, userId: targetId, relatedId: row.id, message: 'admin batalkan bil pending' })
  return done
}
