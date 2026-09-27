// "Ujian wajib" docs/modules/06-blocked-email-domains.md, melalui HTTP + D1 sebenar.
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

const as = (id: string) => tokenFor(id)
const path = '/admin/blocked-email-domains'
const get = (token: string) => h.request(path, { token })
const add = (token: string, json: unknown) => h.request(path, { method: 'POST', token, json })
const del = (token: string, domain: string) => h.request(`${path}/${domain}`, { method: 'DELETE', token })
const domains = async (token: string) => ((await (await get(token)).json()) as { domains: { domain: string }[] }).domains.map((d) => d.domain)

let n = 0
const register = (email: string) => {
  n++
  return h.request('/auth/register', { method: 'POST', json: { email, password: 'rahsia123', phone: `012${String(2_000_000 + n)}`, staff_id: `B-${n}` } })
}
const DISPOSABLE = 'sila guna alamat emel kekal, bukan emel pelupusan/sekali-guna'

describe('siling', () => {
  test('superadmin sahaja (baca dan tulis)', async () => {
    const ahli = await seedMember(h)
    const manager = await seedMember(h, { role: ROLE.manager })
    for (const token of [await as(ahli.id), await as(manager.id)]) {
      expect(await h.body(await get(token))).toEqual({ error: 'tindakan ini untuk superadmin sahaja' })
      expect(await h.body(await add(token, { domain: 'x.com' }))).toEqual({ error: 'tindakan ini untuk superadmin sahaja' })
      expect(await h.body(await del(token, 'x.com'))).toEqual({ error: 'tindakan ini untuk superadmin sahaja' })
    }
  })
})

describe('normalisasi & kesan pada pendaftaran', () => {
  test('huruf besar dinormalkan; domain tersekat menolak daftar; pendua = 201; buang → boleh daftar', async () => {
    const root = await seedMember(h, { role: ROLE.superadmin })
    const token = await as(root.id)

    const created = await add(token, { domain: '  Spam.COM ' })
    expect([created.status, await h.body(created)]).toMatchObject([201, { domain: 'spam.com', added_by: root.id }])
    expect(await domains(token)).toContain('spam.com')

    const blocked = await register('calon@spam.com')
    expect([blocked.status, await h.body(blocked)]).toEqual([400, { error: DISPOSABLE }])

    const dup = await add(token, { domain: 'spam.com' })
    expect([dup.status, await h.body(dup)]).toMatchObject([201, { domain: 'spam.com' }])

    expect(await h.body(await add(token, { domain: '   ' }))).toEqual({ error: 'domain diperlukan' })
    expect(await h.body(await add(token, { domain: 'x'.repeat(254) }))).toEqual({ error: 'Data tidak sah' })
    expect(await h.body(await add(token, {}))).toEqual({ error: 'Data tidak sah' })

    const removed = await del(token, 'SPAM.COM')
    expect([removed.status, await h.body(removed)]).toEqual([200, { ok: true }])
    expect(await domains(token)).not.toContain('spam.com')
    expect((await register('calon@spam.com')).status).toBe(201)

    const missing = await del(token, 'tiada.com')
    expect([missing.status, await h.body(missing)]).toEqual([200, { ok: true }]) // pariti: tiada 404
  })

  test('membuang domain daripada jadual TIDAK membuka senarai terbenam terbina', async () => {
    const root = await seedMember(h, { role: ROLE.superadmin })
    const token = await as(root.id)
    expect((await add(token, { domain: 'yopmail.com' })).status).toBe(201)
    expect((await del(token, 'yopmail.com')).status).toBe(200)
    expect(await h.row("SELECT COUNT(*) n FROM blocked_email_domains WHERE domain = 'yopmail.com'")).toEqual({ n: 0 })

    const res = await register('seseorang@yopmail.com')
    expect([res.status, await h.body(res)]).toEqual([400, { error: DISPOSABLE }])
  })
})
