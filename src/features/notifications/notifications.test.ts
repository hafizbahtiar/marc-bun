// "Ujian wajib" docs/modules/13-notifications.md.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { seedMember, testApp, tokenFor, type Harness } from '../../test/app'
import type { NotifyMessage } from '../../shared/jobs'
import { notify } from './jobs'

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

async function member() {
  const u = await seedMember(h)
  await h.db.prepare('UPDATE profiles SET email_verified = 1 WHERE user_id = ?').bind(u.id).run()
  return { ...u, token: await tokenFor(u.id) }
}

const count = async (recipient: string) => (await h.row('SELECT COUNT(*) AS n FROM notifications WHERE recipient_id = ?', recipient))!.n

describe('consumer notify', () => {
  test('pelaku dilangkau, penerima diulang sekali, penerima dipadam dilangkau (tiada retry kekal)', async () => {
    const actor = await member()
    const a = await member()
    await notify(h.env, { type: 'notify', kind: 'member_approved', actorId: actor.id, recipientIds: [a.id, a.id, actor.id, crypto.randomUUID()] })
    expect([await count(a.id), await count(actor.id)]).toEqual([1, 0])
  })

  test('push: satu panggilan OneSignal untuk semua peranti; gagal push tidak melempar', async () => {
    const actor = await member()
    const a = await member()
    await h.db.prepare("INSERT INTO device_tokens (id, user_id, onesignal_id) VALUES (?, ?, 'p1'), (?, ?, 'p2')").bind(crypto.randomUUID(), a.id, crypto.randomUUID(), a.id).run()
    const env = { ...h.env, ONESIGNAL_APP_ID: 'app', ONESIGNAL_API_KEY: 'key' } as CloudflareBindings
    const calls: { url: string; body: Record<string, unknown> }[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) })
      return new Response(null, { status: calls.length === 1 ? 200 : 500 })
    }) as typeof fetch
    try {
      const msg = { type: 'notify', kind: 'post_like', actorId: actor.id, recipientIds: [a.id], push: { title: 'T', message: 'M' } } satisfies NotifyMessage
      await notify(env, msg)
      await notify(env, msg) // 500 - dilog, bukan dilempar
    } finally {
      globalThis.fetch = realFetch
    }
    expect(calls[0]).toEqual({
      url: 'https://onesignal.com/api/v1/notifications',
      body: { app_id: 'app', include_player_ids: ['p1', 'p2'], headings: { en: 'T' }, contents: { en: 'M' } },
    })
    expect(await count(a.id)).toBe(2)
  })
})

describe('peti notifikasi', () => {
  test('senarai, tanda dibaca, padam terpilih diskop pemilik', async () => {
    const actor = await member()
    const a = await member()
    const b = await member()
    await notify(h.env, { type: 'notify', kind: 'post_like', actorId: actor.id, recipientIds: [a.id, b.id] })
    await notify(h.env, { type: 'notify', kind: 'comment_like', actorId: actor.id, recipientIds: [a.id] })
    const list = await h.body(await h.request('/notifications', { token: a.token }))
    const items = list.notifications as Record<string, unknown>[]
    expect(items.map((n) => n.type)).toEqual(['comment_like', 'post_like'])
    expect(items[0]).toMatchObject({ actor_id: actor.id, read: false, post_id: null, activity_id: null, certificate_id: null })

    expect((await h.request(`/notifications/${items[0]!.id}/read`, { method: 'POST', token: a.token })).status).toBe(204)
    expect((await h.request('/notifications/read', { method: 'DELETE', token: a.token })).status).toBe(204)
    expect(await count(a.id)).toBe(1)

    const bId = (await h.row('SELECT id FROM notifications WHERE recipient_id = ?', b.id))!.id
    const sel = (json: unknown) => h.request('/notifications/selected', { method: 'DELETE', token: a.token, json })
    expect((await sel({ ids: [bId, items[1]!.id] })).status).toBe(204)
    expect([await count(a.id), await count(b.id)]).toEqual([0, 1])
    expect(await h.body(await sel({ ids: [] }))).toEqual({ error: 'senarai notifikasi tidak sah' })
    expect(await h.body(await sel({ ids: ['bukan-uuid'] }))).toEqual({ error: 'senarai notifikasi tidak sah' })
  })
})

describe('device tokens', () => {
  test('upsert: pemilik sama = 204; pengguna lain = 409; padam by-onesignal', async () => {
    const a = await member()
    const b = await member()
    const up = (token: string, json: unknown) => h.request('/device-tokens', { method: 'POST', token, json })
    expect((await up(a.token, { onesignal_id: 'dev-1', platform: 'android' })).status).toBe(204)
    expect((await up(a.token, { onesignal_id: 'dev-1', platform: 'ios' })).status).toBe(204)
    expect(await h.row("SELECT platform FROM device_tokens WHERE onesignal_id = 'dev-1'")).toEqual({ platform: 'ios' })
    expect(await h.body(await up(b.token, { onesignal_id: 'dev-1' }))).toEqual({ error: 'peranti ini sudah didaftarkan pada akaun lain' })
    expect(await h.body(await up(b.token, {}))).toEqual({ error: 'OneSignal ID diperlukan' })
    expect((await h.request('/device-tokens/by-onesignal/dev-1', { method: 'DELETE', token: b.token })).status).toBe(204)
    expect(await h.row("SELECT user_id FROM device_tokens WHERE onesignal_id = 'dev-1'")).toEqual({ user_id: a.id })
    expect((await h.request('/device-tokens/by-onesignal/dev-1', { method: 'DELETE', token: a.token })).status).toBe(204)
    expect(await h.row("SELECT 1 FROM device_tokens WHERE onesignal_id = 'dev-1'")).toBeNull()
  })
})
