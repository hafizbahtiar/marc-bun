// Pariti marc_go toyyibpay_test.go + semakan tandatangan Stripe. fetch disimulasi.
import { afterEach, describe, expect, test } from 'bun:test'
import { extractBillCode, IgnoredEvent, NotConfigured, stripeGateway, toyyibpayGateway } from './gateways'

const realFetch = globalThis.fetch
afterEach(() => void (globalThis.fetch = realFetch))
function stubFetch(respond: (url: string, body: string) => string) {
  const calls: { url: string; body: string }[] = []
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const body = String(init.body ?? '')
    calls.push({ url, body })
    return new Response(respond(url, body))
  }) as typeof fetch
  return calls
}

async function sign(secret: string, t: number, payload: string) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`${t}.${payload}`)))
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('')
}

describe('stripe', () => {
  const now = 1_800_000_000_000
  const gw = stripeGateway('sk_test', 'whsec_x', () => now)
  const payload = JSON.stringify({ type: 'payment_intent.succeeded', data: { object: { id: 'pi_1', created: 1_799_999_000 } } })
  const headers = async (secret = 'whsec_x', t = now / 1000) => new Headers({ 'Stripe-Signature': `t=${t},v1=deadbeef,v1=${await sign(secret, t, payload)}` })

  test('tandatangan sah → event; salah / lapuk / rahsia kosong → ditolak', async () => {
    expect(await gw.verifyWebhook(payload, await headers())).toEqual({ gatewayRef: 'pi_1', status: 'succeeded', paidAt: 1_799_999_000_000 })
    await expect(gw.verifyWebhook(payload, await headers('whsec_lain'))).rejects.toThrow('tidak padan')
    await expect(gw.verifyWebhook(payload, await headers('whsec_x', now / 1000 - 301))).rejects.toThrow('toleransi')
    await expect(stripeGateway('sk_test', '').verifyWebhook(payload, await headers())).rejects.toBeInstanceOf(NotConfigured)
    const other = JSON.stringify({ type: 'charge.refunded', data: { object: { id: 'ch', created: 1 } } })
    const t = now / 1000
    await expect(gw.verifyWebhook(other, new Headers({ 'Stripe-Signature': `t=${t},v1=${await sign('whsec_x', t, other)}` }))).rejects.toBeInstanceOf(IgnoredEvent)
  })

  test('create: client_secret dibuang daripada rawResponse; status dipeta', async () => {
    stubFetch((url) => (url.endsWith('/payment_intents') ? JSON.stringify({ id: 'pi_2', client_secret: 'rahsia', status: 'requires_payment_method' }) : JSON.stringify({ status: 'canceled' })))
    const r = await gw.createPayment({ amountCents: 500, currency: 'myr', metadata: { donor_email: 'a@b.my' } })
    expect([r.gatewayRef, r.clientSecret, r.rawResponse!.includes('rahsia')]).toEqual(['pi_2', 'rahsia', false])
    expect(await gw.checkStatus('pi_2')).toBe('failed')
  })
})

describe('toyyibpay', () => {
  const gw = toyyibpayGateway({ baseUrl: 'https://dev.toyyibpay.com/', secretKey: 's', categoryCode: 'c', callbackUrl: 'https://api/cb', returnUrl: 'https://api/ret' }, () => Date.UTC(2026, 0, 1, 16, 30))

  test('extractBillCode: form (dengan ; dan % cacat), multipart, JSON, kunci tidak peka huruf', async () => {
    expect(await extractBillCode('refno=1&reason=100% off;x&billcode=abc', 'application/x-www-form-urlencoded')).toBe('abc')
    const fd = new FormData()
    fd.set('BillCode', 'mp1')
    const req = new Request('http://x', { method: 'POST', body: fd })
    const ct = req.headers.get('Content-Type')!
    expect(await extractBillCode(await req.text(), ct)).toBe('mp1')
    expect(await extractBillCode('{"BILLCODE":"j1"}', 'application/json')).toBe('j1')
    expect(await extractBillCode('tiada', 'text/plain')).toBe('')
  })

  test('webhook: status_id=1 palsu dalam body tetapi poll berkata belum bayar → diabaikan', async () => {
    stubFetch(() => JSON.stringify([{ billpaymentStatus: '4' }]))
    await expect(gw.verifyWebhook('billcode=b1&status_id=1', new Headers({ 'Content-Type': 'application/x-www-form-urlencoded' }))).rejects.toBeInstanceOf(IgnoredEvent)
  })

  test('poll: mana-mana "1" menang; "3" gagal; "No data found!" = pending', async () => {
    let reply = JSON.stringify([{ billpaymentStatus: '1' }, { billpaymentStatus: '4' }])
    const calls = stubFetch(() => reply)
    expect(await gw.checkStatus('b1')).toBe('succeeded')
    expect(calls[0]!.url).toBe('https://dev.toyyibpay.com/index.php/api/getBillTransactions')
    reply = JSON.stringify([{ billpaymentStatus: '3' }])
    expect(await gw.checkStatus('b1')).toBe('failed')
    reply = 'No data found!'
    expect(await gw.checkStatus('b1')).toBe('pending')
    reply = '<html>WAF</html>'
    await expect(gw.checkStatus('b1')).rejects.toThrow('respons tak dijangka')
  })

  test('createBill: medan wajib, tamat tempoh MYT, URL redirect', async () => {
    const calls = stubFetch(() => JSON.stringify([{ BillCode: 'xyz' }]))
    const r = await gw.createPayment({ amountCents: 6000, currency: 'myr', metadata: { description: 'Yuran', billExpiryMinutes: '30', billPhone: '60123' } })
    const sent = new URLSearchParams(calls[0]!.body)
    expect([sent.get('billAmount'), sent.get('billTo'), sent.get('billExpiryDate'), sent.get('billCallbackUrl')]).toEqual(['6000', 'Ahli MARC', '02-01-2026 01:00:00', 'https://api/cb'])
    expect(r).toMatchObject({ gatewayRef: 'xyz', redirectUrl: 'https://dev.toyyibpay.com/xyz' })
    stubFetch(() => '{"status":"error","msg":"billTo parameter is empty"}')
    await expect(gw.createPayment({ amountCents: 1, currency: 'myr', metadata: {} })).rejects.toThrow('respons tak dijangka')
  })
})
