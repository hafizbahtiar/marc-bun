// "Ujian wajib" docs/modules/08-bans.md, melalui HTTP + D1/KV sebenar.
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
const ban = (token: string, id: string, json: unknown) => h.request(`/admin/members/${id}/ban`, { method: 'POST', token, json })
const unban = (token: string, id: string) => h.request(`/admin/members/${id}/ban`, { method: 'DELETE', token })
const me = (id: string) => tokenFor(id).then((token) => h.request('/me', { token }))

describe('siling & validasi', () => {
  test('superadmin sahaja; diri sendiri & superadmin ditolak; sebab/tarikh wajib', async () => {
    const manager = await seedMember(h, { role: ROLE.manager })
    const root = await seedMember(h, { role: ROLE.superadmin })
    const other = await seedMember(h, { role: ROLE.superadmin })
    const target = await seedMember(h)
    const token = await as(root.id)

    expect(await h.body(await ban(await as(manager.id), target.id, { reason: 'sebab' }))).toEqual({ error: 'tindakan ini untuk superadmin sahaja' })
    expect(await h.body(await ban(token, root.id, { reason: 'sebab' }))).toEqual({ error: 'akaun sendiri tidak boleh digantung' })
    expect(await h.body(await ban(token, other.id, { reason: 'sebab' }))).toEqual({ error: 'akaun superadmin tidak boleh digantung' })
    expect(await h.body(await ban(token, target.id, {}))).toEqual({ error: 'Data tidak sah' })
    expect(await h.body(await ban(token, target.id, { reason: '   ' }))).toEqual({ error: 'sebab penggantungan diperlukan' })
    expect(await h.body(await ban(token, target.id, { reason: 'spam', expires_at: 'bukan-tarikh' }))).toEqual({ error: 'tarikh tamat ban tidak sah' })
    expect(await h.body(await ban(token, target.id, { reason: 'spam', expires_at: new Date(Date.now() - 1000).toISOString() }))).toEqual({ error: 'tarikh tamat ban tidak sah' })
    expect(await h.body(await ban(token, crypto.randomUUID(), { reason: 'spam' }))).toEqual({ error: 'ahli tidak dijumpai' })
    expect((await ban(token, 'bukan-uuid', { reason: 'spam' })).status).toBe(400)
  })
})

describe('kesan ban', () => {
  test('ban → 403 serta-merta (KV) + audit; unban → 200; ban dua kali = 409', async () => {
    const root = await seedMember(h, { role: ROLE.superadmin })
    const token = await as(root.id)
    const target = await seedMember(h)

    expect((await me(target.id)).status).toBe(200)
    const banned = await ban(token, target.id, { reason: 'menyalahguna app' })
    expect([banned.status, await h.body(banned)]).toMatchObject([200, { user_id: target.id, ban_reason: 'menyalahguna app', banned_by: root.id, ban_expires_at: null }])
    expect(await h.env.KV.get(`ban:${target.id}`)).toBe('1')

    const after = await me(target.id)
    expect([after.status, await h.body(after)]).toEqual([403, { error: 'akaun anda sedang digantung' }])

    const twice = await ban(token, target.id, { reason: 'lagi' })
    expect([twice.status, await h.body(twice)]).toEqual([409, { error: 'akaun ini sudah digantung' }])

    const listed = (await (await h.request('/admin/banned-members', { token })).json()) as { members: { user_id: string; ban_reason: string }[] }
    expect(listed.members.find((m) => m.user_id === target.id)?.ban_reason).toBe('menyalahguna app')

    const unbanned = await unban(token, target.id)
    expect([unbanned.status, await h.body(unbanned)]).toEqual([200, { user_id: target.id, banned: false }])
    expect(await h.env.KV.get(`ban:${target.id}`)).toBeNull()
    expect((await me(target.id)).status).toBe(200)
    expect(await h.row('SELECT banned_at, ban_reason FROM profiles WHERE user_id = ?', target.id)).toEqual({ banned_at: null, ban_reason: null })
    expect((await unban(token, target.id)).status).toBe(409)
    expect(await h.row("SELECT COUNT(*) n FROM audit_logs WHERE entity_id = ? AND action = 'update'", target.id)).toEqual({ n: 2 })
    const banAudit = await h.row("SELECT new_values FROM audit_logs WHERE entity_id = ? AND new_values LIKE '%menyalahguna app%'", target.id)
    expect(JSON.parse(banAudit!.new_values as string)).toMatchObject({ banned: true, reason: 'menyalahguna app' })
  })

  test('ban bertempoh: nyahsenarai sendiri selepas luput (KV + DB)', async () => {
    const root = await seedMember(h, { role: ROLE.superadmin })
    const token = await as(root.id)
    const target = await seedMember(h)
    const expires = new Date(Date.now() + 3600_000).toISOString()

    const res = await ban(token, target.id, { reason: 'sehari', expires_at: expires })
    expect([res.status, (await h.body(res)).ban_expires_at]).toEqual([200, expires])
    expect((await me(target.id)).status).toBe(403)

    // Simulasi TTL KV yang luput: kunci hilang, DB pula sudah tamat tempoh.
    await h.env.KV.delete(`ban:${target.id}`)
    await h.db.prepare('UPDATE profiles SET ban_expires_at = ? WHERE user_id = ?').bind(Date.now() - 1000, target.id).run()
    expect((await me(target.id)).status).toBe(200)
    expect(await h.row('SELECT banned_at FROM profiles WHERE user_id = ?', target.id)).not.toBeNull() // baris ban kekal sebagai sejarah
  })
})
