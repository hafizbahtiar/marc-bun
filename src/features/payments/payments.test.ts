// "Ujian wajib" docs/modules/18-payments.md, melalui HTTP + D1 sebenar + gateway palsu.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { ROLE, seedMember, testApp, tokenFor, type Harness } from '../../test/app'
import { activitySweep, runReconcile, runRegistrationSweep } from './jobs'

let h: Harness
const quiet = { log: console.log, error: console.error }
beforeAll(async () => {
  console.log = () => {}
  console.error = () => {}
  h = await testApp({ REGISTRATION_PAYMENT_RETURN_URL: 'https://marc.test/bayar', ACTIVITY_PAYMENT_RETURN_URL: '' })
}, 60_000)
afterAll(async () => {
  Object.assign(console, quiet)
  await h.dispose()
})
beforeEach(() => {
  h.sent.emails.length = 0
  for (const g of Object.values(h.gateways)) {
    g.enabled = true
    g.failCreate = false
  }
})

const MIN = 60_000

async function member(o: { role?: number; status?: string; phone?: string | null } = {}) {
  const u = await seedMember(h, { role: o.role, status: o.status })
  // staff_id = user_id → tidak dikecualikan yuran (ahli bukan staf).
  await h.db.prepare('UPDATE profiles SET email_verified = 1, phone = ?, staff_id = user_id WHERE user_id = ?').bind(o.phone === undefined ? '0123456789' : o.phone, u.id).run()
  return { ...u, token: await tokenFor(u.id) }
}

const post = (path: string, token?: string, json?: unknown) => h.request(path, { method: 'POST', token, json })
const hook = (path: string, ref: string, status: string) => h.request(path, { method: 'POST', body: JSON.stringify({ ref, status }), headers: { 'Content-Type': 'application/json' } })

describe('gate', () => {
  test('akaun tester → 403 pada ketiga-tiga checkout', async () => {
    const t = await member({ role: ROLE.tester })
    const act = crypto.randomUUID()
    for (const [path, json] of [
      ['/donations/checkout', { amount_cents: 500 }],
      ['/registration-payments/checkout', undefined],
      [`/activities/${act}/registration/checkout`, undefined],
    ] as const) {
      expect(await h.body(await post(path, t.token, json))).toEqual({ error: 'akaun tester tidak boleh membuat bayaran sebenar' })
    }
  })
})

describe('derma', () => {
  test('anonim wajib emel; amaun berpagar; gateway mati = 503', async () => {
    expect(await h.body(await post('/donations/checkout', undefined, { amount_cents: 500 }))).toEqual({ error: 'email diperlukan untuk donation tanpa log masuk' })
    expect(await h.body(await post('/donations/checkout', undefined, { amount_cents: 99, donor_email: 'a@b.my' }))).toEqual({ error: 'amount tidak sah' })
    expect(await h.body(await post('/donations/checkout', undefined, { amount_cents: 500, donor_email: 'bukan-emel' }))).toEqual({ error: 'Data tidak sah' })
    h.gateways.stripe.enabled = false
    expect(await h.body(await post('/donations/checkout', undefined, { amount_cents: 500, donor_email: 'a@b.my' }))).toEqual({ error: 'donation belum tersedia' })
  })

  test('webhook dua kali → satu peralihan, satu emel resit (dengan PDF)', async () => {
    const res = await h.body(await post('/donations/checkout', undefined, { amount_cents: 1500, donor_name: ' Ali ', donor_email: 'ALI@Mail.my' }))
    expect(res).toMatchObject({ gateway: 'stripe', redirect_url: '' })
    const ref = (res.client_secret as string).replace('_secret', '')
    expect(await h.row('SELECT donor_name, donor_email, status, user_id FROM donations WHERE gateway_ref = ?', ref)).toEqual({ donor_name: 'Ali', donor_email: 'ali@mail.my', status: 'pending', user_id: null })

    for (let i = 0; i < 2; i++) expect(await h.body(await hook('/webhooks/stripe', ref, 'succeeded'))).toEqual({ ok: true })
    expect(await h.row('SELECT status FROM donations WHERE gateway_ref = ?', ref)).toEqual({ status: 'succeeded' })
    expect(h.sent.emails.map((e) => [e.to, e.subject, e.attachments?.[0]?.filename])).toEqual([['ali@mail.my', 'Terima kasih kerana menyokong MARC', `Resit-Sokongan-MARC-${ref}.pdf`]])
    // raw_payload direkod sebelum parse.
    expect((await h.row("SELECT COUNT(*) AS n FROM payment_logs WHERE event = 'webhook_received' AND raw_payload LIKE ?", `%${ref}%`))!.n).toBe(2)

    expect([(await hook('/webhooks/stripe', ref, 'bad')).status, (await hook('/webhooks/stripe', ref, 'ignored')).status, (await hook('/webhooks/tiada', ref, 'x')).status]).toEqual([400, 200, 503])
  })
})

describe('yuran pendaftaran', () => {
  test('telefon wajib → phone_required, disimpan bila diberi; sudah diluluskan / dibayar → 400', async () => {
    const u = await member({ status: 'pending', phone: null })
    const res = await post('/registration-payments/checkout', u.token)
    expect(await h.body(res)).toEqual({ error: 'sila isi nombor telefon dahulu', code: 'phone_required' })
    expect(await h.body(await post('/registration-payments/checkout', u.token, { phone: 'abc' }))).toEqual({ error: 'format nombor telefon tidak sah' })
    const ok = await h.body(await post('/registration-payments/checkout', u.token, { phone: '+60 12-345 6789' }))
    expect(ok.redirect_url).toStartWith('https://pay.test/toyyibpay-')
    expect(await h.row('SELECT phone FROM profiles WHERE user_id = ?', u.id)).toEqual({ phone: '0123456789' })
    const sent = h.gateways.toyyibpay.created.at(-1)!
    expect([sent.amountCents, sent.metadata.billPhone, sent.metadata.billExpiryMinutes]).toEqual([1000, '0123456789', '30'])

    const approved = await member()
    expect(await h.body(await post('/registration-payments/checkout', approved.token))).toEqual({ error: 'akaun anda sudah diluluskan, tiada yuran pendaftaran perlu dibayar' })
  })

  test('gateway gagal selepas baris ditulis → baris ditanda gagal (tiada bil); webhook → succeeded + satu resit', async () => {
    const u = await member({ status: 'pending' })
    h.gateways.toyyibpay.failCreate = true
    expect(await h.body(await post('/registration-payments/checkout', u.token))).toEqual({ error: 'gagal mulakan pembayaran' })
    expect(await h.row('SELECT status, gateway_ref FROM registration_payments WHERE user_id = ?', u.id)).toEqual({ status: 'failed', gateway_ref: null })

    h.gateways.toyyibpay.failCreate = false
    const url = (await h.body(await post('/registration-payments/checkout', u.token))).redirect_url as string
    const ref = url.split('/').pop()!
    for (let i = 0; i < 2; i++) await hook('/registration-payments/webhook/toyyibpay', ref, 'succeeded')
    expect(await h.row('SELECT status FROM registration_payments WHERE gateway_ref = ?', ref)).toEqual({ status: 'succeeded' })
    expect(h.sent.emails.map((e) => e.subject)).toEqual(['Resit Yuran Pendaftaran MARC'])
    expect(await h.body(await post('/registration-payments/checkout', u.token))).toEqual({ error: 'yuran pendaftaran anda sudah dibayar' })

    // /me/payments: tiga senarai; tertunggak = sama dengan /dashboard.
    const mine = await h.body(await h.request('/me/payments', { token: u.token }))
    expect((mine.registration_fee as { status: string }[]).map((r) => r.status)).toEqual(['succeeded', 'failed'])
    expect([mine.outstanding_registration_fee, mine.activity_fees, mine.donations]).toEqual([false, [], []])

    const id = (mine.registration_fee as { id: string }[])[0]!.id
    const receipt = await h.request(`/me/payments/registration/${id}/receipt`, { token: u.token })
    expect([receipt.status, receipt.headers.get('Content-Disposition')]).toEqual([200, `attachment; filename="Resit-Pendaftaran-MARC-${ref}.pdf"`])
    const failedId = (mine.registration_fee as { id: string }[])[1]!.id
    expect(await h.body(await h.request(`/me/payments/registration/${failedId}/receipt`, { token: u.token }))).toEqual({ error: 'bayaran belum berjaya, resit belum tersedia' })
    expect((await h.request(`/me/payments/registration/${id}/receipt`, { token: (await member()).token })).status).toBe(404)
  })

  test('/me/payments tertunggak = /dashboard', async () => {
    const u = await member()
    const mine = await h.body(await h.request('/me/payments', { token: u.token }))
    const dash = await h.body(await h.request('/dashboard', { token: u.token }))
    expect(mine.outstanding_registration_fee).toBe(true)
    expect((dash.member as { membership: { outstanding_registration_fee_cents: number } }).membership.outstanding_registration_fee_cents).toBe(1000)
  })

  test('return: URL diset → 302 dengan query dikekalkan', async () => {
    const res = await h.request('/registration-payments/return/toyyibpay?status_id=1&billcode=x')
    expect([res.status, res.headers.get('Location')]).toEqual([302, 'https://marc.test/bayar?status_id=1&billcode=x'])
    expect(await (await h.request('/activity-registrations/return/toyyibpay')).text()).toContain('yuran aktiviti anda sedang diproses')
  })
})

async function paidActivity(fee: number) {
  const id = crypto.randomUUID()
  const t = Date.now() + 86_400_000
  await h.db
    .prepare(
      `INSERT INTO activities (id, category_id, title, location_name, starts_at, ends_at, registration_closes_at, fee_cents, status)
       VALUES (?, '00000000-0000-4000-8000-000000000001', 'Kem', 'L', ?, ?, ?, ?, 'published')`,
    )
    .bind(id, t, t + 3600_000, t, fee)
    .run()
  return id
}

describe('yuran aktiviti', () => {
  test('checkout → payment_ref + snapshot; webhook → paid + resit; batal-kemudian-bayar = mismatch', async () => {
    const u = await member()
    const act = await paidActivity(2500)
    expect(await h.body(await post(`/activities/${act}/registration/checkout`, u.token))).toEqual({ error: 'anda belum berdaftar untuk aktiviti ini, daftar dahulu' })
    await post(`/activities/${act}/registration`, u.token)
    const url = (await h.body(await post(`/activities/${act}/registration/checkout`, u.token))).redirect_url as string
    const ref = url.split('/').pop()!
    expect(await h.row('SELECT payment_status, fee_cents_paid FROM activity_registrations WHERE payment_ref = ?', ref)).toEqual({ payment_status: 'pending', fee_cents_paid: 2500 })

    await hook('/activity-registrations/webhook/toyyibpay', ref, 'failed') // tiada 'failed' dalam CHECK: kekal pending
    expect(await h.row('SELECT payment_status FROM activity_registrations WHERE payment_ref = ?', ref)).toEqual({ payment_status: 'pending' })
    await hook('/activity-registrations/webhook/toyyibpay', ref, 'succeeded')
    expect(await h.row('SELECT payment_status FROM activity_registrations WHERE payment_ref = ?', ref)).toEqual({ payment_status: 'paid' })
    expect(h.sent.emails.map((e) => e.subject)).toEqual(['Resit Yuran Aktiviti MARC'])
    expect(await h.body(await post(`/activities/${act}/registration/checkout`, u.token))).toEqual({ error: 'yuran aktiviti ini sudah dibayar' })
    const [fee] = (await h.body(await h.request('/me/payments', { token: u.token }))).activity_fees as { registration_id: string; payment_status: string; fee_cents: number }[]
    expect([fee!.payment_status, fee!.fee_cents]).toEqual(['paid', 2500])
    expect((await h.request(`/me/payments/activity/${fee!.registration_id}/receipt`, { token: u.token })).status).toBe(200)

    // Batal oleh sweep, kemudian bayar → cancelled+paid kelihatan, log mismatch.
    const v = await member()
    const act2 = await paidActivity(1000)
    await post(`/activities/${act2}/registration`, v.token)
    const ref2 = ((await h.body(await post(`/activities/${act2}/registration/checkout`, v.token))).redirect_url as string).split('/').pop()!
    await h.db.prepare("UPDATE activity_registrations SET status = 'cancelled' WHERE payment_ref = ?").bind(ref2).run()
    await hook('/activity-registrations/webhook/toyyibpay', ref2, 'succeeded')
    expect(await h.row('SELECT status, payment_status FROM activity_registrations WHERE payment_ref = ?', ref2)).toEqual({ status: 'cancelled', payment_status: 'paid' })
    expect(await h.row("SELECT status FROM payment_logs WHERE gateway_ref = ? AND event = 'status_updated'", ref2)).toEqual({ status: 'mismatch' })
  })

  test('aktiviti percuma → 400', async () => {
    const u = await member()
    const act = await paidActivity(0)
    await post(`/activities/${act}/registration`, u.token)
    expect(await h.body(await post(`/activities/${act}/registration/checkout`, u.token))).toEqual({ error: 'aktiviti ini percuma, tiada yuran perlu dibayar' })
  })
})

describe('job & pengurusan', () => {
  test('reconcile: webhook tidak pernah tiba → DB dibetulkan ikut gateway', async () => {
    const u = await member({ status: 'pending' })
    const ref = ((await h.body(await post('/registration-payments/checkout', u.token))).redirect_url as string).split('/').pop()!
    await h.db.prepare('UPDATE registration_payments SET created_at = ? WHERE gateway_ref = ?').bind(Date.now() - 20 * MIN, ref).run()
    h.gateways.toyyibpay.statuses.set(ref, 'succeeded')
    const s = await runReconcile(h.db, h.gateways, Date.now())
    expect(s.mismatches_fixed).toBeGreaterThanOrEqual(1)
    expect(await h.row('SELECT status FROM registration_payments WHERE gateway_ref = ?', ref)).toEqual({ status: 'succeeded' })
    // Larian kedua: tiada apa lagi untuk dibetulkan bagi baris ini.
    expect(await h.row("SELECT COUNT(*) AS n FROM payment_logs WHERE gateway_ref = ? AND event = 'reconcile_mismatch_fixed'", ref)).toEqual({ n: 1 })
  })

  test('registrationsweep: gateway disemak dahulu; activitysweep melepaskan slot', async () => {
    const [a, b] = [await member({ status: 'pending' }), await member({ status: 'pending' })]
    const refA = ((await h.body(await post('/registration-payments/checkout', a.token))).redirect_url as string).split('/').pop()!
    const refB = ((await h.body(await post('/registration-payments/checkout', b.token))).redirect_url as string).split('/').pop()!
    h.gateways.toyyibpay.statuses.set(refA, 'succeeded') // bayar lewat - tidak boleh hilang
    const later = Date.now() + 31 * MIN
    await runRegistrationSweep(h.db, h.gateways, later, 30)
    expect([await h.row('SELECT status FROM registration_payments WHERE gateway_ref = ?', refA), await h.row('SELECT status FROM registration_payments WHERE gateway_ref = ?', refB)]).toEqual([
      { status: 'succeeded' },
      { status: 'failed' },
    ])

    const u = await member()
    const act = await paidActivity(500)
    await post(`/activities/${act}/registration`, u.token)
    await activitySweep(h.env, Date.now() + 46 * MIN)
    expect(await h.row('SELECT status FROM activity_registrations WHERE activity_id = ? AND user_id = ?', act, u.id)).toEqual({ status: 'cancelled' })
  })

  test('/admin/payments: derma superadmin sahaja; tiada raw_payload', async () => {
    const mgr = await member({ role: ROLE.manager })
    const sa = await member({ role: ROLE.superadmin })
    await post('/donations/checkout', undefined, { amount_cents: 500, donor_email: 'a@b.my' })
    await post('/donations/checkout', undefined, { amount_cents: 600, donor_email: 'a@b.my' })
    expect(await h.body(await h.request('/admin/payments', { token: (await member()).token }))).toEqual({ error: 'akses ditolak' })
    expect(await h.body(await h.request('/admin/payments?module=donation', { token: mgr.token }))).toEqual({ error: 'modul derma untuk superadmin sahaja' })
    const mine = (await h.body(await h.request('/admin/payments?limit=5', { token: mgr.token }))).logs as Record<string, unknown>[]
    expect(mine.every((l) => l.module !== 'donation' && !('raw_payload' in l))).toBe(true)
    const all = (await h.body(await h.request('/admin/payments?module=donation&limit=1', { token: sa.token }))).logs as { id: number }[]
    const next = (await h.body(await h.request(`/admin/payments?module=donation&before_id=${all[0]!.id}`, { token: sa.token }))).logs as { id: number }[]
    expect(next.every((l) => l.id < all[0]!.id)).toBe(true)
    expect(await h.body(await h.request('/admin/payments?limit=0', { token: sa.token }))).toEqual({ error: 'limit tidak sah' })
  })

  test('batal bil pendaftaran: admin sahaja; sudah bayar di gateway → 409; pending → failed + audit', async () => {
    const admin = await member({ role: ROLE.admin })
    const u = await member({ status: 'pending' })
    const ref = ((await h.body(await post('/registration-payments/checkout', u.token))).redirect_url as string).split('/').pop()!
    const cancel = (token: string) => post(`/members/${u.id}/cancel-registration-payment`, token)
    expect(await h.body(await cancel((await member({ role: ROLE.manager })).token))).toEqual({ error: 'cuma admin/superadmin boleh batalkan bil pendaftaran' })
    h.gateways.toyyibpay.statuses.set(ref, 'succeeded')
    expect(await h.body(await cancel(admin.token))).toEqual({ error: 'ahli sudah bayar yuran pendaftaran - luluskan tanpa langkau bayaran' })

    const v = await member({ status: 'pending' })
    await post('/registration-payments/checkout', v.token)
    const res = await h.body(await post(`/members/${v.id}/cancel-registration-payment`, admin.token))
    expect(res.status).toBe('failed')
    expect(await h.row("SELECT action FROM audit_logs WHERE entity_type = 'profile' AND entity_id = ? AND new_values LIKE '%cancelled_by_admin%'", v.id)).toEqual({ action: 'update' })
    expect(await h.body(await post(`/members/${v.id}/cancel-registration-payment`, admin.token))).toEqual({ error: 'tiada bil pendaftaran pending untuk ahli ini' })
  })

  test('payment-status: rujukan disemak; payment-config', async () => {
    expect(await h.body(await h.request('/payment-status/stripe/a;b'))).toEqual({ error: 'rujukan bayaran tidak sah' })
    expect(await h.body(await h.request('/payment-status/stripe/pi_123'))).toEqual({ status: 'pending' })
    expect(await h.body(await h.request('/payment-status/paypal/pi_123'))).toEqual({ error: 'gateway bayaran belum tersedia' })
    expect(await h.body(await h.request('/payment-config', { token: (await member()).token }))).toEqual({ gateway_charge_cents: 100 })
  })
})
