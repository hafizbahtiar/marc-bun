// "Ujian wajib" docs/modules/03-profile.md, melalui HTTP + D1 sebenar.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { seedMember, testApp, tokenFor, updatedAtOf, type Harness } from '../../test/app'

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

const patchMe = (token: string, json: unknown) => h.request('/me', { method: 'PATCH', token, json })

const ADDRESS = { address_type: 'landed', city: 'Kuala Lumpur', postcode: '50480', state: 'Wilayah Persekutuan Kuala Lumpur' }
const addAddress = (token: string, json: unknown) => h.request('/me/addresses', { method: 'POST', token, json })

describe('GET /me', () => {
  test('ahli pending: status sendiri + medan bayaran; approved: medan bayaran tidak relevan', async () => {
    const pending = await seedMember(h, { status: 'pending' })
    const approved = await seedMember(h, { status: 'approved' })
    for (const u of [pending, approved]) {
      await h.db
        .prepare("INSERT INTO registration_payments (id, user_id, amount_cents, gateway, gateway_ref, status) VALUES (?, ?, 1000, 'toyyibpay', ?, 'succeeded')")
        .bind(crypto.randomUUID(), u.id, `B-${u.id}`)
        .run()
    }

    const me = await h.body(await h.request('/me', { token: await tokenFor(pending.id) }))
    expect(me.status).toBe('pending')
    expect(me.registration_payment_status).toBe('succeeded')
    expect(me.registration_fee_cents).toBe(1000)
    expect(me).toMatchObject({ member_id: null, email_verified: false, telegram_linked: false, role_key: 'ahli', is_active: true, staff_id_verified_at: null })
    expect(typeof me.updated_at).toBe('string')

    const done = await h.body(await h.request('/me', { token: await tokenFor(approved.id) }))
    expect(done.registration_payment_status).toBeNull()
    expect(done.registration_fee_cents).toBeNull()
  })

  test('ahli rejected pun boleh baca status sendiri (bukan 403)', async () => {
    const rejected = await seedMember(h, { status: 'rejected' })
    const res = await h.request('/me', { token: await tokenFor(rejected.id) })
    expect([res.status, (await h.body(res)).status]).toEqual([200, 'rejected'])
  })
})

describe('PATCH /me', () => {
  test('kunci optimistik: tiada/kosong/tak sah = 400; lapuk = 409; ulangan = 409', async () => {
    const u = await seedMember(h)
    const token = await tokenFor(u.id)
    // Nilai lama yang diketahui: CAS diuji tanpa bergantung pada jam sebenar.
    await h.db.prepare('UPDATE profiles SET updated_at = 1 WHERE user_id = ?').bind(u.id).run()
    expect(await h.body(await patchMe(token, { display_name: 'Ali' }))).toEqual({ error: 'Data tidak sah' })
    expect(await h.body(await patchMe(token, { display_name: 'Ali', updated_at: '   ' }))).toEqual({ error: 'updated_at diperlukan untuk mengelakkan perubahan lapuk' })
    expect(await h.body(await patchMe(token, { display_name: 'Ali', updated_at: 'bukan-tarikh' }))).toEqual({ error: 'updated_at tidak sah' })

    const before = await updatedAtOf(h, u.id)
    expect(before).toBe(1)
    const ok = await patchMe(token, { display_name: 'Ali', updated_at: new Date(before).toISOString() })
    expect(ok.status).toBe(200)
    const body = await h.body(ok)
    expect(Object.keys(body).sort()).toEqual(['avatar_url', 'display_name', 'member_id', 'phone', 'updated_at'])
    expect(Date.parse(body.updated_at as string)).toBeGreaterThan(before)

    const stale = await patchMe(token, { display_name: 'Ali lagi', updated_at: new Date(before).toISOString() })
    expect([stale.status, await h.body(stale)]).toEqual([409, { error: 'profil telah berubah. Muat semula sebelum menyunting lagi.', code: 'stale_write' }])
    expect((await h.row('SELECT display_name FROM profiles WHERE user_id = ?', u.id))).toEqual({ display_name: 'Ali' })
  })

  test('medan tidak dikenali diabaikan (bukan 400); medan dihantar = ditetapkan; "" = kosong', async () => {
    const u = await seedMember(h, { displayName: 'Nama Asal' })
    const token = await tokenFor(u.id)
    const res = await patchMe(token, { display_name: '  Nama Baharu  ', role_id: 4, status: 'approved', updated_at: new Date(await updatedAtOf(h, u.id)).toISOString() })
    expect(res.status).toBe(200)
    expect((await h.body(res)).display_name).toBe('Nama Baharu')
    expect(await h.row('SELECT display_name, role_id, status FROM profiles WHERE user_id = ?', u.id)).toEqual({ display_name: 'Nama Baharu', role_id: 1, status: 'approved' })

    const empty = await patchMe(token, { display_name: '', updated_at: new Date(await updatedAtOf(h, u.id)).toISOString() })
    expect(empty.status).toBe(200)
    expect(await h.row('SELECT display_name FROM profiles WHERE user_id = ?', u.id)).toEqual({ display_name: '' })
  })

  test('panjang dikira AKSARA (rune); mesej marc_go; telefon dinormalkan / ditolak', async () => {
    const u = await seedMember(h)
    const token = await tokenFor(u.id)
    const at = async () => new Date(await updatedAtOf(h, u.id)).toISOString()

    expect(await h.body(await patchMe(token, { display_name: 'é'.repeat(101), updated_at: await at() }))).toEqual({ error: 'nama paparan terlalu panjang (maksimum 100 aksara)' })
    expect(await h.body(await patchMe(token, { health_notes: 'x'.repeat(501), updated_at: await at() }))).toEqual({ error: 'nota kesihatan terlalu panjang (maksimum 500 aksara)' })
    expect(await h.body(await patchMe(token, { emergency_contact_name: 'x'.repeat(101), updated_at: await at() }))).toEqual({ error: 'nama waris terlalu panjang (maksimum 100 aksara)' })
    expect(await h.body(await patchMe(token, { phone: '0151234567', updated_at: await at() }))).toEqual({ error: 'format nombor telefon tidak sah' })
    expect(await h.body(await patchMe(token, { emergency_contact_phone: 'abc', updated_at: await at() }))).toEqual({ error: 'format nombor telefon waris tidak sah' })

    // 100 rune = 200 bait: had dikira rune, bukan bait (regresi L23 marc_go).
    const ok = await patchMe(token, { display_name: 'é'.repeat(100), phone: '+60 12-345 6789', updated_at: await at() })
    expect(ok.status).toBe(200)
    expect((await h.body(ok)).phone).toBe('0123456789')
  })

  test('avatar: kunci baharu ditolak (Fasa 4) tanpa mengubah apa-apa; "" mengosongkan + gilir + audit', async () => {
    const u = await seedMember(h, { avatar: 'avatars/lama.jpg' })
    const token = await tokenFor(u.id)

    const rejected = await patchMe(token, { avatar_r2_key: 'avatars/baharu.jpg', updated_at: new Date(await updatedAtOf(h, u.id)).toISOString() })
    expect([rejected.status, await h.body(rejected)]).toEqual([400, { error: 'gambar tidak sah atau belum diupload' }])
    expect(await h.row('SELECT avatar_r2_key FROM profiles WHERE user_id = ?', u.id)).toEqual({ avatar_r2_key: 'avatars/lama.jpg' })
    expect(await h.row('SELECT COUNT(*) n FROM deleted_uploads')).toEqual({ n: 0 })

    const cleared = await patchMe(token, { avatar_r2_key: '', updated_at: new Date(await updatedAtOf(h, u.id)).toISOString() })
    expect([cleared.status, (await h.body(cleared)).avatar_url]).toEqual([200, null])
    expect(await h.row('SELECT avatar_r2_key FROM profiles WHERE user_id = ?', u.id)).toEqual({ avatar_r2_key: null })
    expect(await h.row('SELECT reason FROM deleted_uploads WHERE r2_key = ?', 'avatars/lama.jpg')).toEqual({ reason: 'avatar_replaced' })
    expect(await h.row("SELECT changed_fields FROM audit_logs WHERE entity_type = 'profile' AND entity_id = ?", u.id)).toEqual({ changed_fields: '["avatar_r2_key"]' })
  })

  test('kosongkan avatar tanpa avatar sedia ada = tiada baris audit', async () => {
    const u = await seedMember(h)
    const res = await patchMe(await tokenFor(u.id), { avatar_r2_key: '', updated_at: new Date(await updatedAtOf(h, u.id)).toISOString() })
    expect(res.status).toBe(200)
    expect(await h.row('SELECT COUNT(*) n FROM audit_logs WHERE entity_id = ?', u.id)).toEqual({ n: 0 })
  })
})

describe('alamat', () => {
  test('alamat pertama dipaksa default; yang baharu menyahtetapkan yang lama', async () => {
    const u = await seedMember(h)
    const token = await tokenFor(u.id)

    const first = await addAddress(token, { ...ADDRESS, is_default: false })
    expect([first.status, (await h.body(first)).is_default]).toEqual([201, true])

    const second = await addAddress(token, { ...ADDRESS, city: 'Shah Alam', is_default: true })
    expect([second.status, (await h.body(second)).is_default]).toEqual([201, true])
    const list = (await (await h.request('/me/addresses', { token })).json()) as { id: string; city: string; is_default: boolean }[]
    expect(list.filter((a) => a.is_default)).toHaveLength(1)
    expect(list.find((a) => a.is_default)!.city).toBe('Shah Alam')

    const third = await addAddress(token, { ...ADDRESS, city: 'Klang' })
    expect(third.status).toBe(201)
    expect(await h.row('SELECT COUNT(*) n FROM member_addresses WHERE user_id = ? AND is_default = 1', u.id)).toEqual({ n: 1 })
  })

  test('had 3: keempat ditolak, dan lima serentak pada ahli baharu = tepat 3', async () => {
    const u = await seedMember(h)
    const token = await tokenFor(u.id)
    for (let i = 0; i < 3; i++) expect((await addAddress(token, { ...ADDRESS, city: `Bandar ${i}` })).status).toBe(201)
    const fourth = await addAddress(token, { ...ADDRESS, city: 'Keempat' })
    expect([fourth.status, await h.body(fourth)]).toEqual([400, { error: 'had maksimum 3 alamat setiap ahli' }])

    const race = await seedMember(h)
    const raceToken = await tokenFor(race.id)
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => addAddress(raceToken, { ...ADDRESS, city: `Serentak ${i}` })))
    expect(results.filter((r) => r.status === 201)).toHaveLength(3)
    expect(await h.row('SELECT COUNT(*) n FROM member_addresses WHERE user_id = ?', race.id)).toEqual({ n: 3 })
    expect(await h.row('SELECT COUNT(*) n FROM member_addresses WHERE user_id = ? AND is_default = 1', race.id)).toEqual({ n: 1 })
  })

  test('padam default → alamat tertua dipromosi; padam semua → sifar baris', async () => {
    const u = await seedMember(h)
    const token = await tokenFor(u.id)
    const first = (await (await addAddress(token, { ...ADDRESS, city: 'Pertama' })).json()) as { id: string }
    await addAddress(token, { ...ADDRESS, city: 'Kedua', is_default: true })
    const second = (await (await addAddress(token, { ...ADDRESS, city: 'Ketiga' })).json()) as { id: string }
    void second

    expect((await h.request(`/me/addresses/${first.id}`, { method: 'DELETE', token })).status).toBe(204)
    expect(await h.row('SELECT COUNT(*) n FROM member_addresses WHERE user_id = ? AND is_default = 1', u.id)).toEqual({ n: 1 })

    const list = (await (await h.request('/me/addresses', { token })).json()) as { id: string }[]
    for (const a of list) expect((await h.request(`/me/addresses/${a.id}`, { method: 'DELETE', token })).status).toBe(204)
    expect(await h.row('SELECT COUNT(*) n FROM member_addresses WHERE user_id = ?', u.id)).toEqual({ n: 0 })
  })

  test('is_default=false pada PATCH diabaikan (invarian satu default kekal)', async () => {
    const u = await seedMember(h)
    const token = await tokenFor(u.id)
    const a = (await (await addAddress(token, ADDRESS)).json()) as { id: string }
    const res = await h.request(`/me/addresses/${a.id}`, { method: 'PATCH', token, json: { is_default: false, city: 'Johor Bahru' } })
    expect([res.status, (await h.body(res)).is_default]).toEqual([200, true])
  })

  test('validasi medan (mesej marc_go) + medan tak dikenali diabaikan', async () => {
    const u = await seedMember(h)
    const token = await tokenFor(u.id)
    const cases: [unknown, string][] = [
      [{ ...ADDRESS, address_type: 'condo' }, "jenis alamat mesti 'landed' atau 'highrise'"],
      [{ ...ADDRESS, postcode: '123' }, 'poskod mesti 5 digit'],
      [{ ...ADDRESS, state: 'Singapura' }, 'negeri tidak sah'],
      [{ ...ADDRESS, city: '   ' }, 'bandar diperlukan (maksimum 100 aksara)'],
      [{ ...ADDRESS, label: 'x'.repeat(101) }, 'label terlalu panjang (maksimum 100 aksara)'],
      [{ address_type: 'landed' }, 'Data tidak sah'],
    ]
    for (const [json, error] of cases) expect(await h.body(await addAddress(token, json))).toEqual({ error })

    const ok = await addAddress(token, { ...ADDRESS, user_id: crypto.randomUUID() })
    expect(ok.status).toBe(201)
    expect((await h.body(ok)).is_default).toBe(true)
  })

  test('bukan milik sendiri → 404 (bukan 403), dan tiada perubahan', async () => {
    const owner = await seedMember(h)
    const other = await seedMember(h)
    const ownerToken = await tokenFor(owner.id)
    const otherToken = await tokenFor(other.id)
    const a = (await (await addAddress(ownerToken, ADDRESS)).json()) as { id: string }

    expect(await h.body(await h.request(`/me/addresses/${a.id}`, { method: 'PATCH', token: otherToken, json: { city: 'Dirampas' } }))).toEqual({ error: 'alamat tidak dijumpai' })
    expect((await h.request(`/me/addresses/${a.id}`, { method: 'DELETE', token: otherToken })).status).toBe(404)
    expect(await h.row('SELECT city FROM member_addresses WHERE id = ?', a.id)).toEqual({ city: 'Kuala Lumpur' })

    expect((await h.request(`/me/addresses/${a.id}`, { method: 'DELETE', token: ownerToken })).status).toBe(204)
    expect((await h.request(`/me/addresses/${a.id}`, { method: 'DELETE', token: ownerToken })).status).toBe(404)
    expect((await h.request('/me/addresses/bukan-uuid', { method: 'DELETE', token: ownerToken })).status).toBe(400)
  })
})

describe('permintaan pemadaman akaun', () => {
  test('idempoten: baris sama, audit hanya sekali', async () => {
    const u = await seedMember(h, { status: 'pending' })
    const token = await tokenFor(u.id)
    const first = await h.request('/me/deletion-request', { method: 'POST', token })
    const firstBody = await h.body(first)
    expect([first.status, firstBody.status]).toEqual([200, 'pending'])
    const again = await h.request('/me/deletion-request', { method: 'POST', token })
    expect(again.status).toBe(200)
    expect(await h.body(again)).toEqual(firstBody)
    expect(await h.row('SELECT COUNT(*) n FROM account_deletion_requests WHERE user_id = ?', u.id)).toEqual({ n: 1 })
    expect(await h.row("SELECT COUNT(*) n FROM audit_logs WHERE entity_type = 'account_deletion_request' AND entity_id = ?", u.id)).toEqual({ n: 1 })
  })
})
