// "Ujian wajib" docs/modules/15-activities.md.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ROLE, seedMember, testApp, tokenFor, type Harness } from '../../test/app'
import type { JobMessage } from '../../shared/jobs'
import { lifecycle } from './jobs'
import { claimReminders } from './repo'

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

const HIKING = '00000000-0000-4000-8000-000000000001'
const DAY = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString()

async function member(role: number = ROLE.ahli) {
  const u = await seedMember(h, { role })
  await h.db.prepare('UPDATE profiles SET email_verified = 1 WHERE user_id = ?').bind(u.id).run()
  return { ...u, token: await tokenFor(u.id) }
}

const body = (over: Record<string, unknown> = {}) => {
  const t = Date.now() + 10 * DAY
  return {
    category_id: HIKING,
    title: 'Hiking Bukit',
    location_name: 'Bukit Tabur',
    registration_closes_at: iso(t - DAY),
    sessions: [
      { seq: 2, starts_at: iso(t + DAY), ends_at: iso(t + DAY + 3600_000) },
      { seq: 1, title: 'Hari 1', starts_at: iso(t), ends_at: iso(t + 3600_000) },
    ],
    ...over,
  }
}

const createAs = (token: string, json: unknown) => h.request('/activities', { method: 'POST', token, json })

describe('kategori', () => {
  test('senarai aktif sahaja; ?all=true manager ke atas; cipta/sunting dengan CAS', async () => {
    const ahli = await member()
    const sup = await member(ROLE.supervisor)
    const mgr = await member(ROLE.manager)
    const active = (await h.body(await h.request('/activity-categories', { token: ahli.token }))).categories as { key: string }[]
    expect(active.map((c) => c.key)).not.toContain('futsal')
    expect(await h.body(await h.request('/activity-categories?all=true', { token: sup.token }))).toEqual({ error: 'tindakan ini untuk manager ke atas sahaja' })
    expect(((await h.body(await h.request('/activity-categories?all=true', { token: mgr.token }))).categories as unknown[]).length).toBe(18)

    const create = (json: unknown) => h.request('/activity-categories', { method: 'POST', token: mgr.token, json })
    expect(await h.body(await create({ key: 'Bad Key', name: 'x' }))).toEqual({ error: 'kunci kategori mesti huruf kecil, nombor dan garis bawah sahaja' })
    expect(await h.body(await create({ key: 'panjat', name: '  ' }))).toEqual({ error: 'nama kategori diperlukan' })
    const cat = await h.body(await create({ key: 'panjat', name: 'Panjat', sort_order: 5 }))
    expect(cat).toMatchObject({ key: 'panjat', name: 'Panjat', sort_order: 5, is_active: true })
    expect(await h.body(await create({ key: 'panjat', name: 'Lagi' }))).toEqual({ error: 'kunci kategori sudah wujud' })

    const patch = (json: unknown) => h.request(`/activity-categories/${cat.id}`, { method: 'PATCH', token: mgr.token, json })
    const upd = await h.body(await patch({ is_active: false, updated_at: cat.updated_at }))
    expect([upd.is_active, upd.name]).toEqual([false, 'Panjat'])
    const stale = await patch({ name: 'Y', updated_at: cat.updated_at })
    expect([stale.status, (await h.body(stale)).code]).toEqual([409, 'stale_write'])
    expect((await h.request('/activity-categories', { method: 'POST', token: sup.token, json: {} })).status).toBe(403)
  })
})

describe('aktiviti', () => {
  test('cipta: pengurusan sahaja; peraturan medan; tetingkap = min/max sesi', async () => {
    const ahli = await member()
    const sup = await member(ROLE.supervisor)
    expect(await h.body(await createAs(ahli.token, body()))).toEqual({ error: 'tindakan ini untuk pengurusan sahaja' })
    expect(await h.body(await createAs(sup.token, body({ fee_cents: -1 })))).toEqual({ error: 'yuran tidak boleh negatif' })
    expect(await h.body(await createAs(sup.token, body({ capacity: 0 })))).toEqual({ error: 'kapasiti mesti lebih daripada sifar' })
    expect(await h.body(await createAs(sup.token, body({ attendance_threshold_pct: 101 })))).toEqual({ error: 'ambang kehadiran mesti antara 1 dan 100 peratus' })
    expect(await h.body(await createAs(sup.token, body({ sessions: [] })))).toEqual({ error: 'Data tidak sah' })
    const t = Date.now()
    expect(await h.body(await createAs(sup.token, body({ sessions: [{ seq: 1, starts_at: iso(t), ends_at: iso(t) }] })))).toEqual({ error: 'masa tamat sesi mesti selepas masa mula' })
    expect(await h.body(await createAs(sup.token, body({ sessions: [{ seq: 1, starts_at: iso(t), ends_at: iso(t + 1) }, { seq: 1, starts_at: iso(t), ends_at: iso(t + 1) }] })))).toEqual({
      error: 'nombor urutan sesi mesti unik',
    })
    expect(await h.body(await createAs(sup.token, body({ category_id: crypto.randomUUID() })))).toEqual({ error: 'kategori tidak dijumpai' })

    const b = body()
    const res = await createAs(sup.token, b)
    expect(res.status).toBe(201)
    const a = await h.body(res)
    expect(a).toMatchObject({ status: 'draft', category_key: 'hiking', attendance_threshold_pct: 100, currency: 'MYR', capacity: null, registration_count: 0, is_registered: false })
    expect([a.starts_at, a.ends_at]).toEqual([b.sessions[1]!.starts_at, b.sessions[0]!.ends_at])
    expect((a.sessions as { seq: number }[]).map((s) => s.seq)).toEqual([1, 2])
    expect(await h.row("SELECT action FROM audit_logs WHERE entity_type = 'activity' AND entity_id = ?", a.id)).toEqual({ action: 'create' })

    // Draf tersembunyi daripada ahli.
    expect((await h.request(`/activities/${a.id}`, { token: ahli.token })).status).toBe(404)
    expect(await h.body(await h.request('/activities?status=draft', { token: ahli.token }))).toEqual({ error: 'tindakan ini untuk pengurusan sahaja' })
    expect(await h.body(await h.request('/activities?limit=500', { token: ahli.token }))).toEqual({ error: 'parameter limit mesti antara 1 dan 100' })
  })

  test('PATCH separa: medan tiada = kekal; null pada NOT NULL = 400; null capacity = tiada had', async () => {
    const sup = await member(ROLE.supervisor)
    const a = await h.body(await createAs(sup.token, body({ description: 'asal', capacity: 5 })))
    const patch = (json: unknown) => h.request(`/activities/${a.id}`, { method: 'PATCH', token: sup.token, json })
    const upd = await h.body(await patch({ title: 'Baharu', capacity: null }))
    expect(upd).toMatchObject({ title: 'Baharu', description: 'asal', capacity: null, location_name: 'Bukit Tabur' })
    expect(await h.body(await patch({ title: null }))).toEqual({ error: 'medan title tidak boleh null' })
    expect(await h.body(await patch({ title: '  ' }))).toEqual({ error: 'medan title tidak boleh kosong' })
    expect(await h.body(await patch({ title: 'x'.repeat(201) }))).toEqual({ error: 'tajuk terlalu panjang (maksimum 200 aksara)' })
    expect(await h.body(await patch({ fee_cents: -1 }))).toEqual({ error: 'yuran tidak boleh negatif' })
  })

  test('terbit: notifikasi kepada ahli approved (bukan pelaku); terbit semula = 409', async () => {
    const sup = await member(ROLE.supervisor)
    const other = await member()
    const a = await h.body(await createAs(sup.token, body()))
    h.sent.jobs.length = 0
    const pub = await h.body(await h.request(`/activities/${a.id}/publish`, { method: 'POST', token: sup.token }))
    expect(pub.status).toBe('published')
    const recipients = h.sent.jobs.flatMap((j) => j.recipientIds)
    expect(recipients).toContain(other.id)
    expect(h.sent.jobs[0]).toMatchObject({ kind: 'activity_published', actorId: sup.id, activityId: a.id, push: { title: 'Aktiviti Baharu', message: 'Hiking Bukit' } })
    expect(await h.body(await h.request(`/activities/${a.id}/publish`, { method: 'POST', token: sup.token }))).toEqual({ error: 'hanya aktiviti draf boleh diterbitkan' })
  })

  test('PUT sesi: ganti keseluruhan + tetingkap dikira semula; berkehadiran = 409 tanpa perubahan separa', async () => {
    const sup = await member(ROLE.supervisor)
    const a = await h.body(await createAs(sup.token, body()))
    const put = (sessions: unknown) => h.request(`/activities/${a.id}/sessions`, { method: 'PUT', token: sup.token, json: { sessions } })
    expect(await h.body(await put([]))).toEqual({ error: 'Data tidak sah' })
    expect((await h.body(await h.request(`/activities/${a.id}`, { token: sup.token }))).starts_at).toBe(a.starts_at)

    const t = Date.now() + 20 * DAY
    const replaced = await h.body(await put([{ seq: 1, starts_at: iso(t), ends_at: iso(t + 7200_000) }]))
    expect((replaced.sessions as unknown[]).length).toBe(1)
    const after = await h.body(await h.request(`/activities/${a.id}`, { token: sup.token }))
    expect([after.starts_at, after.ends_at]).toEqual([iso(t), iso(t + 7200_000)])

    // Kehadiran pada sesi semasa → ganti ditolak.
    const sid = (replaced.sessions as { id: string }[])[0]!.id
    const regId = crypto.randomUUID()
    await h.db.batch([
      h.db.prepare("INSERT INTO activity_registrations (id, activity_id, user_id, checkin_token) VALUES (?, ?, ?, 'tok-put')").bind(regId, a.id, sup.id),
      h.db.prepare("INSERT INTO activity_attendances (id, registration_id, session_id, method) VALUES (?, ?, ?, 'manual')").bind(crypto.randomUUID(), regId, sid),
    ])
    expect(await h.body(await put([{ seq: 1, starts_at: iso(t + DAY), ends_at: iso(t + DAY + 1) }]))).toEqual({ error: 'sesi yang sudah ada kehadiran tidak boleh diganti' })
    expect(await h.row('SELECT id FROM activity_sessions WHERE activity_id = ?', a.id)).toEqual({ id: sid })
    expect((await h.body(await h.request(`/activities/${a.id}`, { token: sup.token }))).starts_at).toBe(iso(t))
  })

  test('batal: sebab wajib; notifikasi kepada yang berdaftar sahaja; batal semula = 409', async () => {
    const sup = await member(ROLE.supervisor)
    const reg = await member()
    const a = await h.body(await createAs(sup.token, body()))
    await h.db.prepare("INSERT INTO activity_registrations (id, activity_id, user_id, checkin_token) VALUES (?, ?, ?, ?)").bind(crypto.randomUUID(), a.id, reg.id, crypto.randomUUID()).run()
    const cancel = (json: unknown) => h.request(`/activities/${a.id}/cancel`, { method: 'POST', token: sup.token, json })
    expect(await h.body(await cancel({}))).toEqual({ error: 'Data tidak sah' })
    expect(await h.body(await cancel({ reason: '  ' }))).toEqual({ error: 'sebab pembatalan diperlukan' })
    h.sent.jobs.length = 0
    const res = await h.body(await cancel({ reason: ' Hujan ' }))
    expect([res.status, res.cancelled_reason]).toEqual(['cancelled', 'Hujan'])
    expect(h.sent.jobs).toEqual([
      { type: 'notify', kind: 'activity_cancelled', actorId: sup.id, activityId: a.id as string, recipientIds: [reg.id], push: { title: 'Aktiviti Dibatalkan', message: 'Hiking Bukit telah dibatalkan: Hujan' } },
    ])
    expect(await h.body(await cancel({ reason: 'lagi' }))).toEqual({ error: 'aktiviti ini sudah dibatalkan' })
  })
})

describe('job lifecycle', () => {
  test('dua tuntutan serentak → satu peringatan; auto-selesai aktiviti tamat', async () => {
    const sup = await member(ROLE.supervisor)
    const reg = await member()
    const now = Date.now()
    const soon = await h.body(await createAs(sup.token, body({ sessions: [{ seq: 1, starts_at: iso(now + 3600_000), ends_at: iso(now + 7200_000) }] })))
    const ended = await h.body(await createAs(sup.token, body({ sessions: [{ seq: 1, starts_at: iso(now - 7200_000), ends_at: iso(now - 3600_000) }] })))
    await h.db.prepare("UPDATE activities SET status = 'published' WHERE id IN (?, ?)").bind(soon.id, ended.id).run()
    await h.db.prepare('INSERT INTO activity_registrations (id, activity_id, user_id, checkin_token) VALUES (?, ?, ?, ?)').bind(crypto.randomUUID(), soon.id, reg.id, crypto.randomUUID()).run()

    const [x, y] = await Promise.all([claimReminders(h.db, now), claimReminders(h.db, now)])
    expect([...x, ...y].filter((a) => a.id === soon.id).length).toBe(1)

    await h.db.prepare('UPDATE activities SET reminder_sent_at = NULL WHERE id = ?').bind(soon.id).run()
    const sent: JobMessage[] = []
    const env = { ...h.env, JOBS: { send: async (m: JobMessage) => void sent.push(m) } } as unknown as CloudflareBindings
    await lifecycle(env, now)
    await lifecycle(env, now)
    expect(sent.filter((m) => m.activityId === soon.id)).toEqual([
      {
        type: 'notify',
        kind: 'activity_reminder',
        actorId: '',
        selfActor: true,
        activityId: soon.id as string,
        recipientIds: [reg.id],
        push: { title: 'Peringatan Aktiviti', message: 'Hiking Bukit bermula tidak lama lagi. Jangan terlepas!' },
      },
    ])
    expect(await h.row('SELECT status FROM activities WHERE id = ?', ended.id)).toEqual({ status: 'completed' })
  })
})
