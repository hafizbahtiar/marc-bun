// "Ujian wajib" docs/modules/16-registrations.md.
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

const HOUR = 3600_000
const MIN = 60_000

async function member(role: number = ROLE.ahli) {
  const u = await seedMember(h, { role })
  await h.db.prepare('UPDATE profiles SET email_verified = 1 WHERE user_id = ?').bind(u.id).run()
  return { ...u, token: await tokenFor(u.id) }
}

// Aktiviti terus melalui SQL: masa dikawal tepat.
async function activity(o: { status?: string; capacity?: number | null; fee?: number; startsIn?: number; closesIn?: number; opensIn?: number | null } = {}) {
  const id = crypto.randomUUID()
  const sid = crypto.randomUUID()
  const now = Date.now()
  const start = now + (o.startsIn ?? 24 * HOUR)
  await h.db.batch([
    h.db
      .prepare(
        `INSERT INTO activities (id, category_id, title, location_name, starts_at, ends_at, registration_opens_at, registration_closes_at, capacity, fee_cents, status)
         VALUES (?, '00000000-0000-4000-8000-000000000001', 'Aktiviti', 'Lokasi', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, start, start + HOUR, o.opensIn == null ? null : now + o.opensIn, now + (o.closesIn ?? HOUR), o.capacity ?? null, o.fee ?? 0, o.status ?? 'published'),
    h.db.prepare("INSERT INTO activity_sessions (id, activity_id, seq, starts_at, ends_at) VALUES (?, ?, 1, ?, ?)").bind(sid, id, start, start + HOUR),
  ])
  return { id, sid, start }
}

const register = (token: string, id: string) => h.request(`/activities/${id}/registration`, { method: 'POST', token })

describe('daftar', () => {
  test('kapasiti 10, 30 permintaan serentak → tepat 10 berjaya', async () => {
    const a = await activity({ capacity: 10 })
    const users = await Promise.all(Array.from({ length: 30 }, () => member()))
    const statuses = await Promise.all(users.map((u) => register(u.token, a.id).then((r) => r.status)))
    expect(statuses.filter((s) => s === 201).length).toBe(10)
    expect((await h.row("SELECT COUNT(*) AS n FROM activity_registrations WHERE activity_id = ? AND status <> 'cancelled'", a.id))!.n).toBe(10)
    const full = await register((await member()).token, a.id)
    expect([full.status, await h.body(full)]).toEqual([409, { error: 'aktiviti sudah penuh' }])
  })

  test('mesej: belum dibuka / ditutup / sudah berdaftar / tidak dijumpai; berbayar = pending', async () => {
    const u = await member()
    expect(await h.body(await register(u.token, (await activity({ status: 'draft' })).id))).toEqual({ error: 'aktiviti belum dibuka' })
    expect(await h.body(await register(u.token, (await activity({ closesIn: -MIN })).id))).toEqual({ error: 'pendaftaran telah ditutup' })
    expect(await h.body(await register(u.token, (await activity({ opensIn: HOUR })).id))).toEqual({ error: 'pendaftaran telah ditutup' })
    expect(await h.body(await register(u.token, crypto.randomUUID()))).toEqual({ error: 'aktiviti tidak dijumpai' })
    const paid = await activity({ fee: 1500 })
    const r = (await h.body(await register(u.token, paid.id))).registration as Record<string, unknown>
    expect(r).toMatchObject({ status: 'registered', payment_status: 'pending', cancelled_at: null, fee_cents_paid: null })
    expect(r.checkin_token).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(await h.body(await register(u.token, paid.id))).toEqual({ error: 'anda sudah berdaftar' })
  })

  test('batal kemudian daftar semula; batal selepas tamat = 422; /me/activities tanpa yang dibatal', async () => {
    const u = await member()
    const a = await activity()
    await register(u.token, a.id)
    const del = () => h.request(`/activities/${a.id}/registration`, { method: 'DELETE', token: u.token })
    expect(((await h.body(await del())).registration as { status: string }).status).toBe('cancelled')
    expect(await h.body(await del())).toEqual({ error: 'anda tidak berdaftar' })
    expect((await h.body(await h.request('/me/activities', { token: u.token }))).registrations).toEqual([])
    expect((await register(u.token, a.id)).status).toBe(201)
    const mine = (await h.body(await h.request('/me/activities', { token: u.token }))).registrations as Record<string, unknown>[]
    expect(mine.map((m) => [m.title, m.activity_status, m.fee_cents, m.currency])).toEqual([['Aktiviti', 'published', 0, 'MYR']])

    await h.db.prepare('UPDATE activities SET ends_at = ? WHERE id = ?').bind(Date.now() - MIN, a.id).run()
    const late = await del()
    expect([late.status, await h.body(late)]).toEqual([422, { error: 'aktiviti sudah tamat, pendaftaran tidak boleh dibatalkan' }])
  })
})

describe('kehadiran', () => {
  const mark = (token: string, a: { id: string; sid: string }, json: unknown) => h.request(`/activities/${a.id}/sessions/${a.sid}/attendance`, { method: 'POST', token, json })

  test('self_scan: identiti JWT sahaja; tetingkap 2j; ulang = created false', async () => {
    const u = await member()
    const other = await member()
    const a = await activity({ startsIn: 2 * HOUR + MIN }) // 2j01m sebelum sesi
    await register(u.token, a.id)
    const reg = ((await h.body(await register(other.token, a.id))).registration as { id: string }).id
    expect(await h.body(await mark(u.token, a, { method: 'self_scan', registration_id: reg }))).toEqual({ error: 'self_scan tidak menerima registration_id/checkin_token' })
    expect(await h.body(await mark(u.token, a, { method: 'code' }))).toEqual({ error: 'kaedah kehadiran tidak sah' })
    const early = await mark(u.token, a, { method: 'self_scan' })
    expect([early.status, await h.body(early)]).toEqual([422, { error: 'di luar tetingkap check-in' }])

    const ok = await activity({ startsIn: 2 * HOUR - MIN }) // 1j59m
    await register(u.token, ok.id)
    const first = await h.body(await mark(u.token, ok, { method: 'self_scan' }))
    expect(first).toMatchObject({ created: true, member: { member_id: '' } })
    expect((await h.body(await mark(u.token, ok, { method: 'self_scan' }))).created).toBe(false)
    expect((await h.row("SELECT COUNT(*) AS n FROM audit_logs WHERE entity_type = 'activity_attendance' AND actor_id = ?", u.id))!.n).toBe(1)
    expect(await h.body(await mark(other.token, ok, { method: 'self_scan' }))).toEqual({ error: 'anda tidak berdaftar untuk aktiviti ini' })
  })

  test('manual/scan pengurusan sahaja; pindaan di luar tetingkap diaudit; senarai + buang', async () => {
    const u = await member()
    const sup = await member(ROLE.supervisor)
    const a = await activity({ startsIn: 5 * HOUR })
    const reg = (await h.body(await register(u.token, a.id))).registration as { id: string; checkin_token: string }
    expect(await h.body(await mark(u.token, a, { method: 'manual', registration_id: reg.id }))).toEqual({ error: 'tindakan ini untuk pengurusan sahaja' })
    expect(await h.body(await mark(sup.token, a, { method: 'scan', registration_id: reg.id, checkin_token: reg.checkin_token }))).toEqual({ error: 'berikan registration_id atau checkin_token, satu sahaja' })
    expect(await h.body(await mark(sup.token, a, { method: 'scan', checkin_token: 'salah' }))).toEqual({ error: 'QR tidak dikenali' })
    expect((await mark(sup.token, a, { method: 'scan', checkin_token: reg.checkin_token })).status).toBe(422)
    expect(await h.body(await mark(sup.token, a, { method: 'manual', registration_id: reg.id, amend: true, reason: ' ' }))).toEqual({ error: 'sebab pindaan diperlukan' })
    expect((await h.body(await mark(sup.token, a, { method: 'manual', registration_id: reg.id, amend: true, reason: 'lupa scan' }))).created).toBe(true)
    const log = await h.row("SELECT new_values FROM audit_logs WHERE entity_type = 'activity_attendance' AND action = 'create' AND actor_id = ?", sup.id)
    expect(JSON.parse(log!.new_values as string)).toMatchObject({ amendment: true, reason: 'lupa scan', method: 'manual' })

    const list = (await h.body(await h.request(`/activities/${a.id}/registrations`, { token: sup.token }))).registrations as Record<string, unknown>[]
    expect(list[0]).toMatchObject({ id: reg.id, attended_session_ids: [a.sid] })
    expect(list[0]).not.toHaveProperty('checkin_token')
    expect(await h.body(await h.request(`/activities/${a.id}/registrations`, { token: u.token }))).toEqual({ error: 'tindakan ini untuk pengurusan sahaja' })

    const unmark = () => h.request(`/activities/${a.id}/sessions/${a.sid}/attendance/${reg.id}`, { method: 'DELETE', token: sup.token })
    expect(await h.body(await unmark())).toEqual({ deleted: true })
    expect((await h.row("SELECT COUNT(*) AS n FROM audit_logs WHERE entity_type = 'activity_attendance' AND action = 'delete'"))!.n).toBe(1)
    expect(await h.body(await unmark())).toEqual({ error: 'kehadiran tidak dijumpai' })
    const after = (await h.body(await h.request(`/activities/${a.id}/registrations`, { token: sup.token }))).registrations as Record<string, unknown>[]
    expect(after[0]!.attended_session_ids).toEqual([])
  })
})
