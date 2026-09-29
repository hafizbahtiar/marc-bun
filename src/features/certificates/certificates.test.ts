// "Ujian wajib" docs/modules/17-certificates.md.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ROLE, seedMember, testApp, tokenFor, type Harness } from '../../test/app'
import { notify } from '../notifications'

let h: Harness
const quiet = { log: console.log, error: console.error }
beforeAll(async () => {
  console.log = () => {}
  console.error = () => {}
  h = await testApp({ CERTIFICATE_VERIFY_URL: 'https://marc.test/sahkan-sijil' })
}, 60_000)
afterAll(async () => {
  Object.assign(console, quiet)
  await h.dispose()
})

const HOUR = 3600_000

async function member(role: number = ROLE.ahli, displayName?: string) {
  const u = await seedMember(h, { role, displayName })
  await h.db.prepare('UPDATE profiles SET email_verified = 1 WHERE user_id = ?').bind(u.id).run()
  return { ...u, token: await tokenFor(u.id) }
}

// Aktiviti 3 sesi; `attend[i]` = bilangan sesi dihadiri ahli ke-i.
async function activity(attendees: { id: string; attend: number }[], o: { threshold?: number; endsIn?: number; title?: string } = {}) {
  const id = crypto.randomUUID()
  const end = Date.now() + (o.endsIn ?? -HOUR)
  const sessions = [0, 1, 2].map((i) => ({ id: crypto.randomUUID(), start: end - (3 - i) * HOUR }))
  const stmts = [
    h.db
      .prepare(
        `INSERT INTO activities (id, category_id, title, location_name, starts_at, ends_at, registration_closes_at, attendance_threshold_pct, status)
         VALUES (?, '00000000-0000-4000-8000-000000000001', ?, 'L', ?, ?, ?, ?, 'published')`,
      )
      .bind(id, o.title ?? 'Hiking Bukit', sessions[0]!.start, end, end, o.threshold ?? 66),
    ...sessions.map((s, i) => h.db.prepare('INSERT INTO activity_sessions (id, activity_id, seq, starts_at, ends_at) VALUES (?, ?, ?, ?, ?)').bind(s.id, id, i + 1, s.start, s.start + HOUR)),
  ]
  for (const a of attendees) {
    const reg = crypto.randomUUID()
    stmts.push(h.db.prepare('INSERT INTO activity_registrations (id, activity_id, user_id, checkin_token) VALUES (?, ?, ?, ?)').bind(reg, id, a.id, crypto.randomUUID()))
    for (const s of sessions.slice(0, a.attend)) stmts.push(h.db.prepare("INSERT INTO activity_attendances (id, registration_id, session_id, method) VALUES (?, ?, ?, 'manual')").bind(crypto.randomUUID(), reg, s.id))
  }
  await h.db.batch(stmts)
  return id
}

const issue = (token: string, id: string) => h.request(`/activities/${id}/certificates`, { method: 'POST', token })

describe('terbit', () => {
  test('layak ikut ambang (2/3 @ 66); ulang = tiada pendua, siri tidak bergerak; notifikasi termasuk pelaku', async () => {
    const sup = await member(ROLE.supervisor)
    const a = await member(ROLE.ahli, 'Ali')
    const b = await member(ROLE.ahli, 'Bakar')
    const id = await activity([{ id: a.id, attend: 2 }, { id: b.id, attend: 1 }, { id: sup.id, attend: 3 }])
    expect(await h.body(await issue(a.token, id))).toEqual({ error: 'tindakan ini untuk pengurusan sahaja' })

    h.sent.jobs.length = 0
    expect(await h.body(await issue(sup.token, id))).toEqual({ issued: 2, files_ready: 2, message: 'sijil siap dimuat turun' })
    const seq = (await h.row("SELECT current_value FROM sequences WHERE key = 'certificate_serial'"))!.current_value as number
    const serial = (await h.row('SELECT serial, activity_date FROM activity_certificates WHERE activity_id = ? AND user_id = ?', id, a.id))!
    expect(serial.serial).toMatch(/^MARC-\d{4}-\d{6}$/)
    expect(await h.row('SELECT 1 AS x FROM activity_certificates WHERE activity_id = ? AND user_id = ?', id, b.id)).toBeNull()
    expect(await h.row('SELECT certificates_issued_at IS NOT NULL AS x FROM activities WHERE id = ?', id)).toEqual({ x: 1 })

    expect(await h.body(await issue(sup.token, id))).toMatchObject({ issued: 0 })
    expect((await h.row("SELECT current_value FROM sequences WHERE key = 'certificate_serial'"))!.current_value).toBe(seq)

    // Consumer: pelaku (sup) turut menerima; setiap baris dipautkan ke sijil sendiri.
    expect(h.sent.jobs).toHaveLength(1)
    await notify(h.env, h.sent.jobs[0]!)
    const n = await h.db
      .prepare("SELECT n.recipient_id, n.certificate_id = c.id AS own FROM notifications n JOIN activity_certificates c ON c.user_id = n.recipient_id AND c.activity_id = n.activity_id WHERE n.type = 'certificate_ready' AND n.activity_id = ?")
      .bind(id)
      .all()
    expect(n.results.map((r) => r.own)).toEqual([1, 1])
  })

  test('sebelum sesi terakhir tamat = 422; medan tidak boleh dicetak dinamakan', async () => {
    const sup = await member(ROLE.supervisor)
    const early = await activity([], { endsIn: HOUR })
    const res = await issue(sup.token, early)
    expect([res.status, await h.body(res)]).toEqual([422, { error: 'sijil hanya boleh diterbitkan selepas sesi terakhir tamat' }])

    const cjk = await member(ROLE.ahli, '锦标赛')
    const bad = await activity([{ id: cjk.id, attend: 3 }])
    expect(await h.body(await issue(sup.token, bad))).toEqual({ error: 'medan sijil tidak boleh dicetak: RecipientName "锦标赛"' })
    expect(await h.row('SELECT 1 AS x FROM activity_certificates WHERE activity_id = ?', bad)).toBeNull()
  })
})

describe('muat turun, sahkan, tarik balik', () => {
  test('PDF pemilik sahaja; verify medan terhad; ditarik balik → ditarik_balik + 410', async () => {
    const sup = await member(ROLE.supervisor)
    const a = await member(ROLE.ahli, 'Siti')
    const other = await member()
    const id = await activity([{ id: a.id, attend: 3 }])
    await issue(sup.token, id)
    const [cert] = (await h.body(await h.request('/me/certificates', { token: a.token }))).certificates as Record<string, string>[]
    expect(cert).toMatchObject({ recipient_name: 'Siti', activity_title: 'Hiking Bukit', category_name: 'Hiking', file_ready: true })

    const file = await h.request(`/me/certificates/${cert!.id}/file`, { token: a.token })
    expect([file.status, file.headers.get('Content-Type')]).toEqual([200, 'application/pdf'])
    expect(new TextDecoder().decode((await file.arrayBuffer()).slice(0, 5))).toBe('%PDF-')
    expect(await h.body(await h.request(`/me/certificates/${cert!.id}/file`, { token: other.token }))).toEqual({ error: 'sijil tidak dijumpai' })

    const v = await h.body(await h.request(`/verify/certificates/${cert!.verify_token}`))
    expect(Object.keys(v).sort()).toEqual(['activity_date', 'activity_title', 'issued_at', 'recipient_name', 'serial', 'status'])
    expect(v.status).toBe('sah')
    expect(v.issued_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    const random = await h.request(`/verify/certificates/${'x'.repeat(32)}`)
    const malformed = await h.request('/verify/certificates/%00%ff')
    expect([random.status, await random.text()]).toEqual([malformed.status, await malformed.text()])

    const revoke = (json: unknown) => h.request(`/certificates/${cert!.id}/revoke`, { method: 'POST', token: sup.token, json })
    expect(await h.body(await revoke({ reason: ' ' }))).toEqual({ error: 'sebab tarik balik diperlukan' })
    expect(await h.body(await revoke({ reason: 'silap' }))).toEqual({ revoked: true })
    expect(await h.body(await revoke({ reason: 'lagi' }))).toEqual({ error: 'sijil sudah ditarik balik' })
    expect((await h.body(await h.request(`/verify/certificates/${cert!.verify_token}`))).status).toBe('ditarik_balik')
    const gone = await h.request(`/me/certificates/${cert!.id}/file`, { token: a.token })
    expect([gone.status, await h.body(gone)]).toEqual([410, { error: 'sijil ini telah ditarik balik' }])
    expect((await h.body(await h.request('/me/certificates', { token: a.token }))).certificates).toEqual([])
  })
})

describe('templat', () => {
  test('sunting: pengesahan + CAS; terbit menukar aktif; terbit lapuk tidak menyahaktif apa-apa', async () => {
    const sup = await member(ROLE.supervisor)
    const list = (await h.body(await h.request('/admin/certificate-templates', { token: sup.token }))).templates as Record<string, unknown>[]
    const std = list[0]!
    expect(std).toMatchObject({ name: 'Template MARC Standard', is_active: true })

    const base = { name: 'Baharu', primary_color: '#000000', secondary_color: '#FFFFFF', title: 'T', subtitle: 'S', body_text: 'B', issuer_name: 'I', signature_name: 'G', footer_text: 'F' }
    const patch = (json: unknown) => h.request(`/admin/certificate-templates/${std.id}`, { method: 'PATCH', token: sup.token, json })
    expect(await h.body(await patch({ ...base, title: ' ', updated_at: std.updated_at }))).toEqual({ error: 'tajuk diperlukan' })
    expect(await h.body(await patch({ ...base, primary_color: 'merah', updated_at: std.updated_at }))).toEqual({ error: 'format warna tidak sah' })
    const upd = await h.body(await patch({ ...base, updated_at: std.updated_at }))
    expect(upd).toMatchObject({ name: 'Baharu', is_active: true })
    expect((await patch({ ...base, updated_at: std.updated_at })).status).toBe(409)

    // Templat kedua (draf) → terbit.
    const draft = crypto.randomUUID()
    await h.db.prepare("INSERT INTO certificate_templates (id, name, updated_at) VALUES (?, 'Draf', 5)").bind(draft).run()
    const publish = (id: string, updated_at: unknown) => h.request(`/admin/certificate-templates/${id}/publish`, { method: 'POST', token: sup.token, json: { updated_at } })
    const stale = await publish(draft, new Date(4).toISOString())
    expect([stale.status, (await h.body(stale)).code]).toEqual([409, 'stale_write'])
    expect(await h.row('SELECT COUNT(*) AS n FROM certificate_templates WHERE is_active = 1')).toEqual({ n: 1 })
    expect(await h.body(await publish(draft, new Date(5).toISOString()))).toMatchObject({ id: draft, is_active: true })
    expect(await h.row('SELECT id FROM certificate_templates WHERE is_active = 1')).toEqual({ id: draft })
    expect(await h.body(await h.request(`/admin/certificate-templates/${crypto.randomUUID()}`, { token: sup.token }))).toEqual({ error: 'template sijil tidak dijumpai' })
  })
})
