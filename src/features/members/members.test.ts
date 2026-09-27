// "Ujian wajib" docs/modules/04-members.md, melalui HTTP + D1 sebenar.
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
const list = async (token: string, query = '') => (await (await h.request(`/members${query}`, { token })).json()) as Record<string, unknown>[]
const detail = (token: string, id: string) => h.request(`/members/${id}`, { token })
const patch = (path: string, token: string, json: unknown) => h.request(path, { method: 'PATCH', token, json })
const post = (path: string, token: string, json?: unknown) => h.request(path, { method: 'POST', token, ...(json === undefined ? {} : { json }) })

const at = (id: string) => updatedAtOf(h, id).then((ms) => new Date(ms).toISOString())
const roleIdsOf = (rows: Record<string, unknown>[]) => [...new Set(rows.map((r) => r.role_key as string))].sort()
const pendingRows = async (token: string) => {
  const res = await h.request('/members?status=pending', { token })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('keterlihatan mengikut rank (siling)', () => {
  test('setiap peranan nampak tepat sehingga silingnya; superadmin tidak bocor', async () => {
    const board = {
      ahli: await seedMember(h, { role: ROLE.ahli }),
      supervisor: await seedMember(h, { role: ROLE.supervisor }),
      manager: await seedMember(h, { role: ROLE.manager }),
      admin: await seedMember(h, { role: ROLE.admin }),
      superadmin: await seedMember(h, { role: ROLE.superadmin }),
      tester: await seedMember(h, { role: ROLE.tester }),
    }
    const expected: [keyof typeof board, string[]][] = [
      // ahli 10 → siling 50 (satu tingkat di atas); tester(5) di bawahnya turut kelihatan
      ['ahli', ['ahli', 'supervisor', 'tester']],
      ['supervisor', ['ahli', 'manager', 'supervisor', 'tester']],
      ['manager', ['admin', 'ahli', 'manager', 'supervisor', 'tester']],
      ['admin', ['admin', 'ahli', 'manager', 'supervisor', 'tester']],
      ['superadmin', ['admin', 'ahli', 'manager', 'superadmin', 'supervisor', 'tester']],
      ['tester', ['ahli', 'tester']],
    ]
    for (const [viewer, roles] of expected) {
      expect([viewer, roleIdsOf(await list(await as(board[viewer].id)))]).toEqual([viewer, roles])
    }
  })

  test('ahli pending: tersembunyi daripada ahli, kelihatan kepada pengurusan', async () => {
    const viewer = await seedMember(h)
    const hidden = await seedMember(h, { status: 'pending' })
    expect((await list(await as(viewer.id))).map((r) => r.user_id)).not.toContain(hidden.id)

    const boss = await seedMember(h, { role: ROLE.manager })
    expect((await list(await as(boss.id))).map((r) => r.user_id)).toContain(hidden.id)
  })

  test('bukan pengurusan tidak boleh tapis status', async () => {
    const viewer = await seedMember(h)
    const { status, body } = await pendingRows(await as(viewer.id))
    expect([status, body]).toEqual([403, { error: 'cuma pengurusan boleh tapis ahli ikut status' }])
  })

  test('lapisan approved: ahli pending tidak boleh baca /members', async () => {
    const pending = await seedMember(h, { status: 'pending' })
    const res = await h.request('/members', { token: await as(pending.id) })
    expect([res.status, await h.body(res)]).toEqual([403, { error: 'akaun anda belum diluluskan pihak pengurusan' }])
  })
})

describe('/members/:id medan bertingkat', () => {
  // telegram_chat_id UNIQUE (binding 1:1) - setiap sasaran perlu id tersendiri.
  let chatId = 5000
  async function target() {
    const u = await seedMember(h, { displayName: 'Sasaran' })
    await h.db.batch([
      h.db.prepare("UPDATE profiles SET emergency_contact_name = 'Ibu', emergency_contact_phone = '0199999999', health_notes = 'asma', telegram_chat_id = ?, telegram_username = 'sasaran' WHERE user_id = ?").bind(++chatId, u.id),
      h.db.prepare("INSERT INTO registration_payments (id, user_id, amount_cents, gateway, gateway_ref, status) VALUES (?, ?, 1000, 'toyyibpay', ?, 'succeeded')").bind(crypto.randomUUID(), u.id, `B-${u.id}`),
      h.db.prepare('INSERT INTO member_addresses (id, user_id, is_default, address_type, city, postcode, state) VALUES (?, ?, 1, \'landed\', \'Klang\', \'41000\', \'Selangor\')').bind(crypto.randomUUID(), u.id),
    ])
    return u
  }

  test('management nampak T2, T3 kekal null; bukan management nampak T1 sahaja', async () => {
    const t = await target()
    const supervisor = await seedMember(h, { role: ROLE.supervisor })
    const peer = await seedMember(h)

    const t2 = await h.body(await detail(await as(supervisor.id), t.id))
    expect(t2).toMatchObject({ email: t.email, phone: null, staff_id: t.staffId, registration_payment_status: 'succeeded', is_active: true })
    expect([t2.emergency_contact_name, t2.emergency_contact_phone, t2.health_notes, t2.telegram_linked, t2.telegram_username, t2.addresses]).toEqual([null, null, null, null, null, null])

    const t1 = await h.body(await detail(await as(peer.id), t.id))
    expect([t1.email, t1.phone, t1.staff_id, t1.registration_payment_status, t1.staff_id_verified_at]).toEqual([null, null, null, null, null])
    expect(t1.display_name).toBe('Sasaran')
  })

  test('superadmin nampak T3 (termasuk alamat dan Telegram)', async () => {
    const t = await target()
    const root = await seedMember(h, { role: ROLE.superadmin })
    const body = await h.body(await detail(await as(root.id), t.id))
    expect(body).toMatchObject({ emergency_contact_name: 'Ibu', health_notes: 'asma', telegram_linked: true, telegram_username: 'sasaran' })
    expect((body.addresses as Record<string, unknown>[]).map((a) => a.city)).toEqual(['Klang'])
  })

  test('di luar siling → 404 (kewujudan tidak bocor); ahli pending milik orang lain → 404', async () => {
    const viewer = await seedMember(h) // ahli, siling 50
    const manager = await seedMember(h, { role: ROLE.manager })
    const hidden = await seedMember(h, { status: 'pending' })
    expect((await detail(await as(viewer.id), manager.id)).status).toBe(404)
    expect((await detail(await as(viewer.id), hidden.id)).status).toBe(404)
    expect((await detail(await as(viewer.id), crypto.randomUUID())).status).toBe(404)
    expect((await h.request('/members/bukan-uuid', { token: await as(viewer.id) })).status).toBe(400)
    // ahli pending: lapisan `approved` menolaknya dahulu, termasuk untuk dirinya
    expect(await h.body(await detail(await as(hidden.id), hidden.id))).toEqual({ error: 'akaun anda belum diluluskan pihak pengurusan' })
  })
})

describe('/roles', () => {
  test('bukan pengurusan → 403; pengurusan hanya peranan yang boleh diassign', async () => {
    const viewer = await seedMember(h)
    expect(await h.body(await h.request('/roles', { token: await as(viewer.id) }))).toEqual({ error: 'cuma pengurusan boleh lihat senarai role' })

    const manager = await seedMember(h, { role: ROLE.manager })
    const rows = (await (await h.request('/roles', { token: await as(manager.id) })).json()) as { key: string; rank: number }[]
    expect(rows.map((r) => r.key).sort()).toEqual(['ahli', 'supervisor', 'tester'])
    expect(rows.every((r) => r.rank < 60)).toBe(true)
  })
})

describe('PATCH /members/:id/role', () => {
  test('manager tidak boleh assign setaraf/lebih tinggi, boleh turunkan pangkat ahli', async () => {
    const manager = await seedMember(h, { role: ROLE.manager })
    const token = await as(manager.id)
    const supervisor = await seedMember(h, { role: ROLE.supervisor })

    for (const role of ['manager', 'admin', 'superadmin']) {
      const res = await patch(`/members/${supervisor.id}/role`, token, { role_key: role, updated_at: await at(supervisor.id) })
      expect([role, res.status, await h.body(res)]).toEqual([role, 403, { error: 'tidak boleh assign role setaraf/lebih tinggi drpd anda' }])
    }
    expect(await h.row('SELECT role_id FROM profiles WHERE user_id = ?', supervisor.id)).toEqual({ role_id: ROLE.supervisor })

    const ok = await patch(`/members/${supervisor.id}/role`, token, { role_key: 'ahli', updated_at: await at(supervisor.id) })
    expect([ok.status, (await h.body(ok)).role_key]).toEqual([200, 'ahli'])
    expect(await h.row('SELECT role_id FROM profiles WHERE user_id = ?', supervisor.id)).toEqual({ role_id: ROLE.ahli })
    const audit = await h.row("SELECT old_values, new_values FROM audit_logs WHERE entity_type = 'profile' AND entity_id = ?", supervisor.id)
    expect(out(audit, 'old_values')).toMatchObject({ role_key: 'supervisor', role_rank: 50 })
    expect(out(audit, 'new_values')).toMatchObject({ role_key: 'ahli', role_rank: 10 })
  })

  test('setaraf/lebih tinggi, diri sendiri, role tak sah, lapuk', async () => {
    const manager = await seedMember(h, { role: ROLE.manager })
    const other = await seedMember(h, { role: ROLE.manager })
    const ahli = await seedMember(h)
    const token = await as(manager.id)

    const sameRank = await patch(`/members/${other.id}/role`, token, { role_key: 'ahli', updated_at: await at(other.id) })
    expect([sameRank.status, await h.body(sameRank)]).toEqual([403, { error: 'tidak boleh edit ahli setaraf/lebih tinggi drpd anda' }])
    expect(await h.body(await patch(`/members/${manager.id}/role`, token, { role_key: 'ahli', updated_at: await at(manager.id) }))).toEqual({ error: 'tidak boleh tukar role akaun sendiri' })
    expect(await h.body(await patch(`/members/${ahli.id}/role`, token, { role_key: 'tiada', updated_at: await at(ahli.id) }))).toEqual({ error: 'role tidak sah' })

    await h.db.prepare('UPDATE profiles SET updated_at = 1 WHERE user_id = ?').bind(ahli.id).run()
    expect((await patch(`/members/${ahli.id}/role`, token, { role_key: 'tester', updated_at: new Date(1).toISOString() })).status).toBe(200)
    // R2: mutasi yang tidak berlaku (CAS gagal) TIDAK boleh meninggalkan baris audit.
    const auditsBefore = ((await h.row('SELECT COUNT(*) n FROM audit_logs WHERE entity_id = ?', ahli.id))!.n as number)
    const stale = await patch(`/members/${ahli.id}/role`, token, { role_key: 'ahli', updated_at: new Date(1).toISOString() })
    expect([stale.status, (await h.body(stale)).code]).toEqual([409, 'stale_write'])
    expect(await h.row('SELECT COUNT(*) n FROM audit_logs WHERE entity_id = ?', ahli.id)).toEqual({ n: auditsBefore })
  })
})

describe('PATCH /members/:id/active', () => {
  test('pengurusan sahaja, bukan diri sendiri, audit', async () => {
    const manager = await seedMember(h, { role: ROLE.manager })
    const ahli = await seedMember(h)
    const peer = await seedMember(h)
    const token = await as(manager.id)

    expect(await h.body(await patch(`/members/${manager.id}/active`, token, { is_active: false, updated_at: await at(manager.id) }))).toEqual({ error: 'tidak boleh tukar status aktif akaun sendiri' })
    expect(await h.body(await patch(`/members/${peer.id}/active`, await as(ahli.id), { is_active: false, updated_at: await at(peer.id) }))).toEqual({ error: 'cuma pengurusan boleh tukar status aktif ahli' })

    const ok = await patch(`/members/${ahli.id}/active`, token, { is_active: false, updated_at: await at(ahli.id) })
    expect(await h.body(ok)).toMatchObject({ user_id: ahli.id, is_active: false })
    expect(await h.row('SELECT is_active FROM profiles WHERE user_id = ?', ahli.id)).toEqual({ is_active: 0 })
    expect(await h.row("SELECT COUNT(*) n FROM audit_logs WHERE entity_id = ? AND action = 'update'", ahli.id)).toEqual({ n: 1 })
  })
})

describe('PATCH /members/:id/department', () => {
  test('manager ke atas; rank setaraf dibenarkan; kod mesti wujud; kosong = buang', async () => {
    const manager = await seedMember(h, { role: ROLE.manager })
    const peerManager = await seedMember(h, { role: ROLE.manager })
    const ahli = await seedMember(h)
    const token = await as(manager.id)

    expect(await h.body(await patch(`/members/${ahli.id}/department`, await as(ahli.id), { department_code: 'BKP', updated_at: await at(ahli.id) }))).toEqual({ error: 'cuma manager ke atas boleh tukar bahagian/jawatan ahli' })
    expect(await h.body(await patch(`/members/${ahli.id}/department`, token, { department_code: 'TIDAK-WUJUD', updated_at: await at(ahli.id) }))).toEqual({ error: 'bahagian tidak sah' })
    expect(await h.body(await patch(`/members/${ahli.id}/department`, token, { department_code: 'BKP', position: 'x'.repeat(151), updated_at: await at(ahli.id) }))).toEqual({ error: 'jawatan terlalu panjang (maksimum 150 aksara)' })

    const ok = await patch(`/members/${ahli.id}/department`, token, { department_code: 'BKP', position: 'Pegawai', updated_at: await at(ahli.id) })
    expect([ok.status, await h.body(ok)]).toMatchObject([200, { department_code: 'BKP', position: 'Pegawai', department_name: 'BAHAGIAN KHIDMAT PENGURUSAN' }])

    expect((await patch(`/members/${peerManager.id}/department`, token, { department_code: 'BKP', updated_at: await at(peerManager.id) })).status).toBe(200)

    const cleared = await patch(`/members/${ahli.id}/department`, token, { department_code: null, position: null, updated_at: await at(ahli.id) })
    expect([cleared.status, (await h.body(cleared)).department_code]).toEqual([200, null])
  })

  test('superadmin tidak boleh diedit oleh manager', async () => {
    const manager = await seedMember(h, { role: ROLE.manager })
    const root = await seedMember(h, { role: ROLE.superadmin })
    expect(await h.body(await patch(`/members/${root.id}/department`, await as(manager.id), { department_code: 'BKP', updated_at: await at(root.id) }))).toEqual({ error: 'tidak boleh edit ahli lebih tinggi drpd anda' })
  })
})

describe('approve / reject', () => {
  async function call(token: string, id: string, action: 'approve' | 'reject', json?: unknown) {
    const res = await post(`/members/${id}/${action}`, token, json)
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  test('approve memerlukan staff disahkan; emel + notifikasi hanya selepas berjaya', async () => {
    const manager = await seedMember(h, { role: ROLE.manager })
    const token = await as(manager.id)
    const unverified = await seedMember(h, { status: 'pending' })

    const emailsBefore = h.sent.emails.length
    expect(await call(token, unverified.id, 'approve')).toEqual({ status: 400, body: { error: 'nombor staff ahli ni belum disahkan - sahkan nombor staff dulu sebelum meluluskan' } })
    expect(h.sent.emails.length).toBe(emailsBefore)

    const verified = await seedMember(h, { status: 'pending', staffVerified: true })
    const first = await call(token, verified.id, 'approve')
    expect(first).toMatchObject({ status: 200, body: { user_id: verified.id, status: 'approved', approved_by: manager.id } })
    expect(h.sent.emails.at(-1)).toMatchObject({ to: verified.email, subject: 'Pendaftaran MARC Diluluskan' })
    expect(h.sent.jobs.at(-1)).toMatchObject({ type: 'notify', kind: 'member_approved', recipientIds: [verified.id] })

    const again = await call(token, verified.id, 'approve')
    expect([again.status, again.body.approved_at]).toEqual([200, first.body.approved_at])
    expect(h.sent.emails.length).toBe(emailsBefore + 1)
  })

  test('reject: sesi dibunuh dalam batch yang sama + KV; pengurusan tidak boleh ditolak', async () => {
    const manager = await seedMember(h, { role: ROLE.manager })
    const token = await as(manager.id)
    const target = await seedMember(h, { status: 'pending' })
    await h.db.prepare('INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at) VALUES (?, ?, ?, ?, ?)').bind(crypto.randomUUID(), target.id, 'hash-1', crypto.randomUUID(), Date.now() + 10_000).run()

    const rejected = await call(token, target.id, 'reject')
    expect([rejected.status, rejected.body.status]).toEqual([200, 'rejected'])
    expect(await h.row('SELECT COUNT(*) n FROM refresh_tokens WHERE user_id = ?', target.id)).toEqual({ n: 0 })
    expect(await h.env.KV.get(`rv:user:${target.id}`)).not.toBeNull()
    expect(h.sent.emails.at(-1)).toMatchObject({ subject: 'Pendaftaran MARC Ditolak' })

    const peerManager = await seedMember(h, { role: ROLE.manager })
    expect(await call(token, peerManager.id, 'reject')).toEqual({ status: 403, body: { error: 'tidak boleh tolak ahli pengurusan' } })
    expect(await call(token, manager.id, 'reject')).toEqual({ status: 400, body: { error: 'tidak boleh laksanakan tindakan ini pada akaun sendiri' } })
    expect(await call(await as(peerManager.id), target.id, 'reject')).toMatchObject({ status: 200 })
  })

  test('bukan pengurusan → 403', async () => {
    const ahli = await seedMember(h)
    const target = await seedMember(h, { status: 'pending', staffVerified: true })
    expect(await call(await as(ahli.id), target.id, 'approve')).toEqual({ status: 403, body: { error: 'cuma pengurusan boleh luluskan/tolak ahli' } })
  })
})

describe('verify-staff-id', () => {
  const verify = (token: string, id: string, json?: unknown) => post(`/members/${id}/verify-staff-id`, token, json).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }))

  test('manager ke atas sahaja; member_id mengikut jujukan ahli', async () => {
    const supervisor = await seedMember(h, { role: ROLE.supervisor })
    const manager = await seedMember(h, { role: ROLE.manager })
    const ahli = await seedMember(h, { status: 'pending' })
    expect(await verify(await as(supervisor.id), ahli.id)).toEqual({ status: 403, body: { error: 'cuma manager ke atas boleh sahkan nombor staff' } })

    const before = ((await h.row("SELECT current_value FROM sequences WHERE key = 'member_seq:ahli'"))?.current_value as number | undefined) ?? 0
    const ok = await verify(await as(manager.id), ahli.id)
    expect(ok.status).toBe(200)
    expect(ok.body.member_id).toMatch(/^MARC-S-\d+\/\d{4}-\d{4}$/)
    expect(ok.body.member_id).toBe(`MARC-${ahli.staffId}/${new Date(Date.now() + 8 * 3600_000).getUTCFullYear()}-${String(before + 1).padStart(4, '0')}`)
    expect(await h.row('SELECT staff_id_verified_by FROM profiles WHERE user_id = ?', ahli.id)).toEqual({ staff_id_verified_by: manager.id })
    expect(await h.row("SELECT entity_type FROM audit_logs WHERE entity_id = ?", ahli.id)).toEqual({ entity_type: 'staff_id_verification' })

    expect((await verify(await as(manager.id), ahli.id)).body.member_id).toBe(ok.body.member_id)
    expect(await verify(await as(manager.id), ahli.id, { staff_id: 'LAIN' })).toEqual({ status: 409, body: { error: 'ahli ni dah disahkan - guna PATCH /members/:id/staff-id untuk betulkan nombor staff' } })
  })

  test('placeholder, duplikat, rank lebih tinggi, sudah ditolak', async () => {
    const manager = await seedMember(h, { role: ROLE.manager })
    const token = await as(manager.id)

    const placeholder = await seedMember(h, { status: 'pending' })
    await h.db.prepare('UPDATE profiles SET staff_id = user_id WHERE user_id = ?').bind(placeholder.id).run()
    expect((await verify(token, placeholder.id)).body.error).toBe('staff_id ahli ni masih placeholder - sila isi nombor staff sebenar semasa sahkan')

    const first = await seedMember(h, { status: 'pending', staffVerified: true })
    const second = await seedMember(h, { status: 'pending' })
    expect((await verify(token, second.id, { staff_id: first.staffId })).status).toBe(409)

    const peer = await seedMember(h, { role: ROLE.manager, status: 'pending' })
    expect(await verify(token, peer.id)).toEqual({ status: 403, body: { error: 'tidak boleh edit ahli setaraf/lebih tinggi drpd anda' } })
    expect(await verify(token, manager.id)).toEqual({ status: 400, body: { error: 'tidak boleh sahkan nombor staff akaun sendiri' } })

    const rejected = await seedMember(h, { status: 'rejected' })
    expect(await verify(token, rejected.id)).toEqual({ status: 409, body: { error: 'ahli ni dah ditolak' } })
  })
})

describe('correct staff_id / member_id', () => {
  test('admin ke atas sahaja; member_id NULL tidak boleh dibetulkan terus', async () => {
    const manager = await seedMember(h, { role: ROLE.manager })
    const admin = await seedMember(h, { role: ROLE.admin })
    const target = await seedMember(h)

    expect(await h.body(await patch(`/members/${target.id}/staff-id`, await as(manager.id), { staff_id: 'X1' }))).toEqual({ error: 'cuma admin ke atas boleh betulkan nombor staff' })
    expect(await h.body(await patch(`/members/${target.id}/member-id`, await as(manager.id), { member_id: 'MARC-1' }))).toEqual({ error: 'cuma admin ke atas boleh betulkan nombor ahli' })

    const adminToken = await as(admin.id)
    expect(await h.body(await patch(`/members/${target.id}/staff-id`, adminToken, { staff_id: 'A/B' }))).toEqual({ error: "nombor staff tidak boleh mengandungi '/'" })
    expect(await h.body(await patch(`/members/${target.id}/staff-id`, adminToken, { staff_id: 'S-BETUL' }))).toEqual({ user_id: target.id, staff_id: 'S-BETUL' })

    expect(await h.body(await patch(`/members/${target.id}/member-id`, adminToken, { member_id: 'MARC-PALSU' }))).toEqual({ error: 'ahli ni belum ada nombor ahli - sahkan nombor staff dulu (`POST /members/:id/verify-staff-id`)' })

    const verified = await seedMember(h, { staffVerified: true, memberId: 'MARC-LAMA/2026-0009' })
    expect(await h.body(await patch(`/members/${verified.id}/member-id`, adminToken, { member_id: 'MARC-BAHARU/2026-0010' }))).toEqual({ user_id: verified.id, member_id: 'MARC-BAHARU/2026-0010' })
    expect(await h.body(await patch(`/members/${verified.id}/member-id`, adminToken, { member_id: '  ' }))).toEqual({ error: 'nombor ahli tidak sah' })
    expect(await h.body(await patch(`/members/${admin.id}/staff-id`, adminToken, { staff_id: 'SELF' }))).toEqual({ error: 'tidak boleh betulkan nombor staff akaun sendiri' })
  })
})

function out(row: Record<string, unknown> | null, key: string): unknown {
  return row ? JSON.parse(row[key] as string) : null
}
