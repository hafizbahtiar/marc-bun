// "Ujian wajib" docs/modules/01-auth.md, melalui HTTP + D1/KV sebenar.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import bcrypt from 'bcryptjs'
import { testApp } from '../../test/app'

let h: Awaited<ReturnType<typeof testApp>>
const quiet = { log: console.log, error: console.error }
beforeAll(async () => {
  console.log = () => {}
  console.error = () => {}
  h = await testApp({ PASSWORD_RESET_URL: 'https://marc.test/reset', RESEND_API_KEY: 're_test', EMAIL_FROM: 'MARC <no-reply@marc.test>', CORS_ALLOWED_ORIGINS: 'https://marc.test' })
}, 60_000)
afterAll(async () => {
  Object.assign(console, quiet)
  await h.dispose()
})

let n = 0
const newMember = () => {
  n++
  return { email: `ahli${n}@gmail.com`, password: 'rahsia123', phone: `01234${String(n).padStart(5, '0')}`, staff_id: `S${n}` }
}
const post = (path: string, json: unknown, extra: { token?: string; ip?: string; headers?: Record<string, string> } = {}) =>
  h.request(path, { method: 'POST', json, ...extra })

async function register(m = newMember()) {
  const res = await post('/auth/register', m)
  expect(res.status).toBe(201)
  return { ...m, ...(await h.body(res)) } as ReturnType<typeof newMember> & { access_token: string; refresh_token: string }
}
const userIdOf = async (email: string) => (await h.db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: string }>())!.id
const me = (token: string) => h.request('/me/sessions', { token })

describe('register', () => {
  test('201 + token; profil pending, telefon dinormalkan, staff_id disimpan', async () => {
    const m = { ...newMember(), email: 'Ali.Baru@Gmail.com', phone: '+60 12-345 6789' }
    const res = await post('/auth/register', m)
    expect(res.status).toBe(201)
    const body = await h.body(res)
    expect(Object.keys(body).sort()).toEqual(['access_token', 'expires_in', 'refresh_token'])
    expect(body.expires_in).toBe(900)
    const row = await h.row('SELECT p.status, p.phone, p.staff_id, p.member_id, u.email FROM profiles p JOIN users u ON u.id = p.user_id WHERE u.email = ?', 'ali.baru@gmail.com')
    expect(row).toEqual({ status: 'pending', phone: '0123456789', staff_id: m.staff_id, member_id: null, email: 'ali.baru@gmail.com' })
  })

  test('management dimaklumkan (member_pending) melalui queue', async () => {
    const boss = await register()
    await h.db.prepare('UPDATE profiles SET role_id = 3 WHERE user_id = ?').bind(await userIdOf(boss.email)).run()
    h.sent.jobs.length = 0
    const m = await register()
    const job = h.sent.jobs.find((j) => j.kind === 'member_pending')
    expect(job).toMatchObject({ type: 'notify', actorId: await userIdOf(m.email) })
    expect(job!.recipientIds).toContain(await userIdOf(boss.email))
  })

  test.each([
    [{ password: 'rahsia123', phone: '0123456789', staff_id: 'X' }, 'Email diperlukan'],
    [{ email: 'bukan-emel', password: 'rahsia123', phone: '0123456789', staff_id: 'X' }, 'Format email tidak sah'],
    [{ email: 'a@gmail.com', password: '', phone: '0123456789', staff_id: 'X' }, 'Kata laluan diperlukan'],
    [{ email: 'a@gmail.com', password: '12345', phone: '0123456789', staff_id: 'X' }, 'Kata laluan diperlukan (minimum 6 aksara)'],
    [{ email: 'a@gmail.com', password: 'x'.repeat(73), phone: '0123456789', staff_id: 'X' }, 'Kata laluan terlalu panjang (maksimum 72 aksara)'],
    [{ email: 'a@gmail.com', password: 'é'.repeat(40), phone: '0123456789', staff_id: 'X' }, 'Kata laluan terlalu panjang (maksimum 72 aksara)'],
    [{ email: 'a@gmail.com', password: 'rahsia123', staff_id: 'X' }, 'Data tidak sah'],
    [{ email: 'a@gmail.com', password: 'rahsia123', phone: '0123456789', staff_id: 'A/B' }, "nombor staff tidak boleh mengandungi '/'"],
    [{ email: 'a@gmail.com', password: 'rahsia123', phone: '0123456789', staff_id: '   ' }, 'nombor staff diperlukan'],
    [{ email: 'a@gmail.com', password: 'rahsia123', phone: '0151234567', staff_id: 'X' }, 'format nombor telefon tidak sah'],
    [{ email: 'a@yopmail.com', password: 'rahsia123', phone: '0123456789', staff_id: 'X' }, 'sila guna alamat emel kekal, bukan emel pelupusan/sekali-guna'],
  ])('400 %#', async (input, error) => {
    const res = await post('/auth/register', input)
    expect(res.status).toBe(400)
    expect(await h.body(res)).toEqual({ error })
  })

  test('domain disekat (jadual) ditolak, tetapi allowlist tester dihormati', async () => {
    await h.db.prepare("INSERT INTO blocked_email_domains (domain) VALUES ('spam.my'), ('yopmail.com')").run()
    expect((await post('/auth/register', { ...newMember(), email: 'x@spam.my' })).status).toBe(400)
    expect((await post('/auth/register', { ...newMember(), email: 'google@yopmail.com' })).status).toBe(201)
  })

  test('medan tak dikenali diabaikan (bukan 400)', async () => {
    expect((await post('/auth/register', { ...newMember(), role_id: 4 })).status).toBe(201)
  })

  test('409: emel sama (huruf berbeza) / staff_id sama', async () => {
    const m = await register()
    const dupEmail = await post('/auth/register', { ...newMember(), email: m.email.toUpperCase() })
    expect([dupEmail.status, await h.body(dupEmail)]).toEqual([409, { error: 'email ini sudah berdaftar' }])
    const dupStaff = await post('/auth/register', { ...newMember(), staff_id: m.staff_id })
    expect([dupStaff.status, await h.body(dupStaff)]).toEqual([409, { error: 'nombor staff ini sudah didaftarkan' }])
    // batch atomik: pengguna kedua tidak tertinggal tanpa profil
    const orphans = await h.row('SELECT COUNT(*) n FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE p.id IS NULL')
    expect(orphans).toEqual({ n: 0 })
  })
})

describe('login', () => {
  test('mesej sama untuk emel tidak wujud & kata laluan salah', async () => {
    const m = await register()
    for (const body of [{ email: 'tiada@gmail.com', password: 'rahsia123' }, { email: m.email, password: 'salah123' }]) {
      const res = await post('/auth/login', body)
      expect([res.status, await h.body(res)]).toEqual([401, { error: 'email atau kata laluan salah' }])
    }
    expect((await post('/auth/login', { email: m.email.toUpperCase(), password: m.password })).status).toBe(200)
  })

  test('hash bcrypt $2a$ dari marc_go kekal sah', async () => {
    const m = await register()
    const legacy = bcrypt.hashSync('kataLama99', 10).replace(/^\$2b\$/, '$2a$')
    await h.db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').bind(legacy, m.email).run()
    expect((await post('/auth/login', { email: m.email, password: 'kataLama99' })).status).toBe(200)
  })

  test('ahli digantung → 403', async () => {
    const m = await register()
    await h.db.prepare('UPDATE profiles SET banned_at = 1 WHERE user_id = ?').bind(await userIdOf(m.email)).run()
    const res = await post('/auth/login', { email: m.email, password: m.password })
    expect([res.status, await h.body(res)]).toEqual([403, { error: 'akaun anda sedang digantung' }])
  })
})

describe('refresh', () => {
  test('rotasi: token lama selepas refresh → 401', async () => {
    const m = await register()
    const r1 = await post('/auth/refresh', { refresh_token: m.refresh_token })
    expect(r1.status).toBe(200)
    const b1 = await h.body(r1)
    expect(b1.refresh_token).not.toBe(m.refresh_token)
    expect((await post('/auth/refresh', { refresh_token: b1.refresh_token })).status).toBe(200)
  })

  test('reuse dari IP lain → keluarga mati (token terbaru & access ditolak)', async () => {
    const m = await register()
    const fresh = await h.body(await post('/auth/refresh', { refresh_token: m.refresh_token }, { ip: '10.0.0.1' }))
    const reuse = await post('/auth/refresh', { refresh_token: m.refresh_token }, { ip: '203.0.113.9' })
    expect([reuse.status, await h.body(reuse)]).toEqual([401, { error: 'refresh token tidak sah' }])
    expect((await post('/auth/refresh', { refresh_token: fresh.refresh_token })).status).toBe(401)
    expect((await me(fresh.access_token as string)).status).toBe(401)
  })

  test('reuse dalam 5 s dari IP SAMA (retry) → 401 tetapi keluarga hidup', async () => {
    const m = await register()
    const fresh = await h.body(await post('/auth/refresh', { refresh_token: m.refresh_token }))
    expect((await post('/auth/refresh', { refresh_token: m.refresh_token })).status).toBe(401)
    expect((await post('/auth/refresh', { refresh_token: fresh.refresh_token })).status).toBe(200)
  })

  test('dua refresh serentak dengan token sama → tepat satu berjaya', async () => {
    const m = await register()
    const results = await Promise.all(Array.from({ length: 5 }, () => post('/auth/refresh', { refresh_token: m.refresh_token })))
    expect(results.map((r) => r.status).filter((s) => s === 200)).toHaveLength(1)
  })

  test('token luput → sudah luput; token rawak → tidak sah; tiada body → diperlukan', async () => {
    const m = await register()
    await h.db.prepare('UPDATE refresh_tokens SET expires_at = 1 WHERE user_id = ?').bind(await userIdOf(m.email)).run()
    expect(await h.body(await post('/auth/refresh', { refresh_token: m.refresh_token }))).toEqual({ error: 'refresh token sudah luput' })
    expect(await h.body(await post('/auth/refresh', { refresh_token: 'rawak' }))).toEqual({ error: 'refresh token tidak sah' })
    expect(await h.body(await post('/auth/refresh', {}))).toEqual({ error: 'Refresh token diperlukan' })
  })
})

describe('logout / logout-all / sesi', () => {
  test('logout: keluarga dipadam, access token ditolak, idempoten', async () => {
    const m = await register()
    expect((await post('/auth/logout', { refresh_token: m.refresh_token })).status).toBe(204)
    expect((await post('/auth/logout', { refresh_token: m.refresh_token })).status).toBe(204)
    expect((await me(m.access_token)).status).toBe(401)
    expect((await post('/auth/refresh', { refresh_token: m.refresh_token })).status).toBe(401)
  })

  test('logout-all → access token sedia ada ditolak serta-merta', async () => {
    const m = await register()
    const other = await h.body(await post('/auth/login', { email: m.email, password: m.password }))
    expect((await post('/auth/logout-all', {}, { token: m.access_token })).status).toBe(204)
    expect((await me(other.access_token as string)).status).toBe(401)
    // log masuk semula serta-merta selepas itu berfungsi
    const again = await h.body(await post('/auth/login', { email: m.email, password: m.password }))
    expect((await me(again.access_token as string)).status).toBe(200)
  })

  test('/me/sessions: satu baris setiap peranti, is_current, batal peranti lain', async () => {
    const m = await register()
    await post('/auth/refresh', { refresh_token: m.refresh_token }) // rotasi dalam keluarga sama
    const phone = await h.body(await post('/auth/login', { email: m.email, password: m.password }, { headers: { 'X-MARC-Device-Label': 'iPhone Ali · iOS 18' } }))
    const list = (await (await me(m.access_token)).json()) as { id: string; user_agent: string; is_current: boolean }[]
    expect(list).toHaveLength(2)
    expect(list.filter((s) => s.is_current)).toHaveLength(1)
    const phoneSession = list.find((s) => s.user_agent === 'iPhone Ali · iOS 18')!
    expect((await h.request(`/me/sessions/${phoneSession.id}`, { method: 'DELETE', token: m.access_token })).status).toBe(204)
    expect((await me(phone.access_token as string)).status).toBe(401)
    const missing = await h.request(`/me/sessions/${phoneSession.id}`, { method: 'DELETE', token: m.access_token })
    expect([missing.status, await h.body(missing)]).toEqual([404, { error: 'sesi tidak dijumpai' }])
    expect((await h.request('/me/sessions/bukan-uuid', { method: 'DELETE', token: m.access_token })).status).toBe(400)
  })

  test('batal pukal: keluarga orang lain diabaikan', async () => {
    const a = await register()
    const b = await register()
    const bSessions = (await (await me(b.access_token)).json()) as { id: string }[]
    const res = await post('/me/sessions/revoke', { ids: [bSessions[0]!.id] }, { token: a.access_token })
    expect([res.status, await h.body(res)]).toEqual([404, { error: 'sesi tidak dijumpai' }])
    expect((await me(b.access_token)).status).toBe(200)
  })

  test('tanpa token / token rosak', async () => {
    expect(await h.body(await me(''))).toEqual({ error: 'token tidak dijumpai' })
    expect(await h.body(await me('rosak'))).toEqual({ error: 'token tidak sah' })
  })
})

describe('pengesahan emel', () => {
  async function approved() {
    const m = await register()
    await h.db.prepare("UPDATE profiles SET status = 'approved' WHERE user_id = ?").bind(await userIdOf(m.email)).run()
    return m
  }
  const linkToken = () => new URL(h.sent.emails.at(-1)!.html.match(/href="([^"]+)"/)![1]!.replaceAll('&amp;', '&')).searchParams.get('token')!

  test('ahli pending → 403 (lapisan approved)', async () => {
    const m = await register()
    const res = await post('/auth/verify-email/request', {}, { token: m.access_token })
    expect([res.status, await h.body(res)]).toEqual([403, { error: 'akaun anda belum diluluskan pihak pengurusan' }])
  })

  test('minta → emel → sahkan (JSON) → email_verified; token sekali-guna; had 60 s', async () => {
    const m = await approved()
    expect((await post('/auth/verify-email/request', {}, { token: m.access_token })).status).toBe(204)
    expect(h.sent.emails.at(-1)!.to).toBe(m.email)
    const token = linkToken()
    const cooldown = await post('/auth/verify-email/request', {}, { token: m.access_token })
    expect([cooldown.status, await h.body(cooldown)]).toEqual([429, { error: 'tunggu sebentar sebelum minta emel pengesahan semula' }])

    expect((await post('/auth/verify-email/confirm', { token })).status).toBe(204)
    const row = await h.row('SELECT email_verified FROM profiles WHERE user_id = ?', await userIdOf(m.email))
    expect(row).toEqual({ email_verified: 1 })
    expect(await h.body(await post('/auth/verify-email/confirm', { token }))).toEqual({ error: 'token tidak sah' })
  })

  test('had harian 5', async () => {
    const m = await approved()
    const id = await userIdOf(m.email)
    for (let i = 0; i < 5; i++) await h.db.prepare('INSERT INTO email_verification_sends (id, user_id, created_at) VALUES (?, ?, ?)').bind(crypto.randomUUID(), id, Date.now() - 3_600_000 - i).run()
    expect(await h.body(await post('/auth/verify-email/request', {}, { token: m.access_token }))).toEqual({ error: 'had harian emel pengesahan tercapai. Cuba lagi esok.' })
  })

  test('pautan GET → HTML', async () => {
    const m = await approved()
    await post('/auth/verify-email/request', {}, { token: m.access_token })
    const ok = await h.request(`/auth/verify-email/confirm?token=${linkToken()}`)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('Content-Type')).toContain('text/html')
    expect(await ok.text()).toContain('Email anda berjaya disahkan')
    const bad = await h.request('/auth/verify-email/confirm?token=x')
    expect([bad.status, (await bad.text()).includes('token tidak sah.')]).toEqual([400, true])
  })

  test('CORS preflight: origin dibenarkan dapat header, OPTIONS 204', async () => {
    const res = await h.request('/auth/verify-email/confirm', { method: 'OPTIONS', headers: { Origin: 'https://marc.test' } })
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://marc.test')
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS')
    const evil = await h.request('/auth/verify-email/confirm', { method: 'OPTIONS', headers: { Origin: 'https://jahat.test' } })
    expect(evil.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })
})

describe('reset kata laluan', () => {
  const resetToken = () => new URL(h.sent.emails.at(-1)!.html.match(/href="([^"]+)"/)![1]!).searchParams.get('token')!

  test('URL tidak dikonfigur → 503 (sebelum parse body)', async () => {
    const res = await h.request('/auth/password-reset/request', { method: 'POST', body: '{' }, { PASSWORD_RESET_URL: '' })
    expect([res.status, await h.body(res)]).toEqual([503, { error: 'reset kata laluan belum tersedia' }])
  })

  test('emel tidak wujud → 204 tanpa emel (tiada enumerasi)', async () => {
    const before = h.sent.emails.length
    expect((await post('/auth/password-reset/request', { email: 'tiada@gmail.com' })).status).toBe(204)
    expect(h.sent.emails.length).toBe(before)
  })

  test('reset: kata laluan bertukar, SEMUA sesi mati, token sekali-guna', async () => {
    const m = await register()
    expect((await post('/auth/password-reset/request', { email: m.email })).status).toBe(204)
    const token = resetToken()
    expect((await post('/auth/password-reset/confirm', { token, password: 'baharu123' })).status).toBe(204)

    expect((await me(m.access_token)).status).toBe(401)
    expect((await post('/auth/refresh', { refresh_token: m.refresh_token })).status).toBe(401)
    expect((await post('/auth/login', { email: m.email, password: m.password })).status).toBe(401)
    expect((await post('/auth/login', { email: m.email, password: 'baharu123' })).status).toBe(200)
    expect(await h.body(await post('/auth/password-reset/confirm', { token, password: 'lain12345' }))).toEqual({ error: 'pautan tidak sah' })
  })

  test('token luput → pautan sudah luput, kata laluan TIDAK bertukar', async () => {
    const m = await register()
    await post('/auth/password-reset/request', { email: m.email })
    const token = resetToken()
    await h.db.prepare('UPDATE password_reset_tokens SET expires_at = 1 WHERE user_id = ?').bind(await userIdOf(m.email)).run()
    expect(await h.body(await post('/auth/password-reset/confirm', { token, password: 'baharu123' }))).toEqual({ error: 'pautan sudah luput' })
    expect((await post('/auth/login', { email: m.email, password: m.password })).status).toBe(200)
  })

  test('dua confirm serentak dengan token sama → tepat satu berjaya', async () => {
    const m = await register()
    await post('/auth/password-reset/request', { email: m.email })
    const token = resetToken()
    const results = await Promise.all([1, 2, 3].map((i) => post('/auth/password-reset/confirm', { token, password: `baharu${i}23` })))
    expect(results.filter((r) => r.status === 204)).toHaveLength(1)
  })
})
