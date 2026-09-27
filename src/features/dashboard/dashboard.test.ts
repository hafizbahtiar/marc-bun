// "Ujian wajib" docs/modules/14-dashboard.md.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ROLE, seedMember, testApp, tokenFor, type Harness } from '../../test/app'

let h: Harness
const quiet = { log: console.log, error: console.error }
beforeAll(async () => {
  console.log = () => {}
  console.error = () => {}
  h = await testApp()
}, 60_000)
afterAll(async () => {
  Object.assign(console, quiet)
  await h.dispose()
})

const dash = async (userId: string) => h.body(await h.request('/dashboard', { token: await tokenFor(userId) }))

describe('GET /dashboard', () => {
  test('ahli biasa: admin = null; yuran tertunggak = bil pending terbaru, fi semasa bila tiada', async () => {
    const u = await seedMember(h, { staffVerified: false })
    await h.db.prepare("UPDATE profiles SET staff_id = user_id WHERE user_id = ?").bind(u.id).run()
    let d = await dash(u.id)
    expect(d.admin).toBeNull()
    expect(d.member).toMatchObject({ membership: { status: 'approved', member_id: null, staff_id_verified: false, outstanding_registration_fee_cents: 1000 }, certificates_total: 0, open_activities: [] })

    await h.db.prepare("INSERT INTO registration_payments (id, user_id, amount_cents, gateway, status, created_at) VALUES (?, ?, 800, 'toyyibpay', 'pending', 1)").bind(crypto.randomUUID(), u.id).run()
    d = await dash(u.id)
    expect((d.member as { membership: Record<string, unknown> }).membership.outstanding_registration_fee_cents).toBe(800)

    // Staf (staff_id sebenar) dikecualikan.
    const staff = await seedMember(h)
    expect(((await dash(staff.id)).member as { membership: Record<string, unknown> }).membership.outstanding_registration_fee_cents).toBeNull()
  })

  test('admin: derma null; superadmin: derma dikira dalam total', async () => {
    const admin = await seedMember(h, { role: ROLE.admin })
    const sa = await seedMember(h, { role: ROLE.superadmin })
    const now = Date.now()
    await h.db.batch([
      h.db.prepare("INSERT INTO registration_payments (id, user_id, amount_cents, gateway, status, created_at) VALUES (?, ?, 1000, 'toyyibpay', 'succeeded', ?)").bind(crypto.randomUUID(), admin.id, now),
      h.db.prepare("INSERT INTO donations (id, user_id, amount_cents, gateway, gateway_ref, status, created_at) VALUES (?, ?, 500, 'stripe', 'd1', 'succeeded', ?)").bind(crypto.randomUUID(), sa.id, now),
    ])
    const a = (await dash(admin.id)).admin as Record<string, Record<string, unknown>>
    expect(a.revenue_this_month).toEqual({ currency: 'MYR', registration_cents: 1000, activity_cents: 0, donation_cents: null, total_cents: 1000 })
    expect(a.activity_stats).toEqual({ upcoming: 0, registrations_this_month: 0, attendance_rate: null })
    expect(a.member_stats!.by_department).toBeArray()
    const s = (await dash(sa.id)).admin as Record<string, Record<string, unknown>>
    expect(s.revenue_this_month).toMatchObject({ donation_cents: 500, total_cents: 1500 })
    // manager (bawah admin) tiada blok admin.
    expect((await dash((await seedMember(h, { role: ROLE.manager })).id)).admin).toBeNull()
  })
})
