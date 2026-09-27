// "Ujian wajib" docs/modules/05-departments.md, melalui HTTP + D1 sebenar.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ROLE, seedMember, testApp, tokenFor, updatedAtOf, type Harness } from '../../test/app'

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
const get = (path: string, token: string) => h.request(path, { token })
const post = (path: string, token: string, json: unknown) => h.request(path, { method: 'POST', token, json })
const patch = (path: string, token: string, json: unknown) => h.request(path, { method: 'PATCH', token, json })
const del = (path: string, token: string) => h.request(path, { method: 'DELETE', token })
const codes = async (token: string) => ((await (await get('/departments', token)).json()) as { departments: { code: string }[] }).departments.map((d) => d.code)

describe('lapisan & siling', () => {
  test('GET /departments: manager ke atas; /admin/* superadmin sahaja', async () => {
    const ahli = await seedMember(h)
    const supervisor = await seedMember(h, { role: ROLE.supervisor })
    const manager = await seedMember(h, { role: ROLE.manager })
    const root = await seedMember(h, { role: ROLE.superadmin })

    expect(await h.body(await get('/departments', await as(ahli.id)))).toEqual({ error: 'tindakan ini untuk manager ke atas sahaja' })
    expect(await h.body(await get('/departments', await as(supervisor.id)))).toEqual({ error: 'tindakan ini untuk manager ke atas sahaja' })

    const seen = await codes(await as(manager.id))
    expect(seen).toHaveLength(17)
    expect(seen).toContain('BKP')

    for (const [method, path, body] of [
      ['GET', '/admin/departments', undefined],
      ['POST', '/admin/departments', { code: 'X', name: 'X' }],
      ['PATCH', '/admin/departments/BKP', { name: 'X' }],
      ['DELETE', '/admin/departments/BKP', undefined],
    ] as const) {
      const res = await h.request(path, { method, token: await as(manager.id), ...(body ? { json: body } : {}) })
      expect([method, path, res.status, await h.body(res)]).toEqual([method, path, 403, { error: 'tindakan ini untuk superadmin sahaja' }])
    }
    expect((await get('/admin/departments', await as(root.id))).status).toBe(200)
  })
})

describe('CRUD', () => {
  test('cipta/ubah/padam + mesej ralat marc_go', async () => {
    const root = await seedMember(h, { role: ROLE.superadmin })
    const token = await as(root.id)
    const path = '/admin/departments'

    const created = await post(path, token, { code: 'BARU', name: 'Bahagian Baru', sort_order: 5 })
    expect([created.status, await h.body(created)]).toMatchObject([201, { code: 'BARU', name: 'Bahagian Baru', sort_order: 5, added_by: root.id }])

    const dup = await post(path, token, { code: 'BARU', name: 'Pendua' })
    expect([dup.status, await h.body(dup)]).toEqual([409, { error: 'kod bahagian sudah wujud' }])
    expect(await h.body(await post(path, token, { code: 'A/B', name: 'X' }))).toEqual({ error: "kod bahagian tidak boleh mengandungi '/'" })
    expect(await h.body(await post(path, token, { code: '  ', name: 'X' }))).toEqual({ error: 'kod dan nama bahagian diperlukan' })
    expect(await h.body(await post(path, token, { name: 'Tanpa kod' }))).toEqual({ error: 'Data tidak sah' })
    expect(await h.body(await post(path, token, { code: 'X'.repeat(51), name: 'X' }))).toEqual({ error: 'Data tidak sah' })

    const updated = await patch(`${path}/BARU`, token, { name: 'Nama Baharu', sort_order: 9 })
    expect([updated.status, await h.body(updated)]).toMatchObject([200, { name: 'Nama Baharu', sort_order: 9 }])
    expect(await h.body(await patch(`${path}/BARU`, token, { name: '   ' }))).toEqual({ error: 'nama bahagian tidak boleh kosong' })
    expect(await h.body(await patch(`${path}/TIADA`, token, { name: 'X' }))).toEqual({ error: 'bahagian tidak dijumpai' })

    const removed = await del(`${path}/BARU`, token)
    expect([removed.status, await h.body(removed)]).toEqual([200, { ok: true }])
    const gone = await del(`${path}/BARU`, token)
    expect([gone.status, await h.body(gone)]).toEqual([404, { error: 'bahagian tidak dijumpai' }])
  })

  test('padam bahagian yang dirujuk → department_code NULL, ahli kekal', async () => {
    const root = await seedMember(h, { role: ROLE.superadmin })
    const manager = await seedMember(h, { role: ROLE.manager })
    const ahli = await seedMember(h)
    const rootToken = await as(root.id)

    expect((await post('/admin/departments', rootToken, { code: 'TMP', name: 'Sementara' })).status).toBe(201)
    const set = await patch(`/members/${ahli.id}/department`, await as(manager.id), { department_code: 'TMP', position: 'Pegawai', updated_at: new Date(await updatedAtOf(h, ahli.id)).toISOString() })
    expect(set.status).toBe(200)
    expect(await h.row('SELECT department_code FROM profiles WHERE user_id = ?', ahli.id)).toEqual({ department_code: 'TMP' })

    expect((await del('/admin/departments/TMP', rootToken)).status).toBe(200)
    expect(await h.row('SELECT department_code, position FROM profiles WHERE user_id = ?', ahli.id)).toEqual({ department_code: null, position: 'Pegawai' })
    expect(await h.row('SELECT COUNT(*) n FROM users WHERE id = ?', ahli.id)).toEqual({ n: 1 })
    expect((await h.body(await get('/me', await as(ahli.id)))).department_code).toBeNull()
  })
})
