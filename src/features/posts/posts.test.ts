// "Ujian wajib" docs/modules/12-posts.md + 11-uploads.md, melalui HTTP + D1/R2 sebenar.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ROLE, seedMember, testApp, tokenFor, type Harness } from '../../test/app'
import { reaper } from '../uploads'

let h: Harness
const quiet = { log: console.log, error: console.error }
beforeAll(async () => {
  console.log = () => { }
  console.error = () => { }
  h = await testApp()
}, 60_000)
afterAll(async () => {
  Object.assign(console, quiet)
  await h.dispose()
})

async function member(opts: Parameters<typeof seedMember>[1] = {}) {
  const u = await seedMember(h, opts)
  await h.db.prepare('UPDATE profiles SET email_verified = 1 WHERE user_id = ?').bind(u.id).run()
  return { ...u, token: await tokenFor(u.id) }
}

// PNG minimum: tandatangan + IHDR (lebar, tinggi).
function png(w: number, h: number) {
  const b = new Uint8Array(33)
  b.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82])
  new DataView(b.buffer).setUint32(16, w)
  new DataView(b.buffer).setUint32(20, h)
  return b
}

async function uploaded(userId: string, bytes: Uint8Array) {
  const key = `posts/${crypto.randomUUID()}`
  await h.env.BUCKET.put(key, bytes)
  await h.db.prepare('INSERT INTO pending_uploads (r2_key, user_id) VALUES (?, ?)').bind(key, userId).run()
  return key
}

const post = (token: string, json: unknown) => h.request('/posts', { method: 'POST', token, json })

describe('post', () => {
  test('cipta dengan gambar: post_images ditulis, pending dibuang - satu batch', async () => {
    const u = await member()
    const key = await uploaded(u.id, png(100, 100))
    const res = await post(u.token, { content: 'Hai', r2_keys: [key] })
    expect(res.status).toBe(201)
    const p = await h.body(res)
    expect(p).toMatchObject({ type: 'normal', content: 'Hai', like_count: 0, comment_count: 0, liked_by_me: false, comment_previews: [], edited_at: null })
    expect(await h.row('SELECT position FROM post_images WHERE post_id = ? AND r2_key = ?', p.id, key)).toEqual({ position: 0 })
    expect(await h.row('SELECT 1 FROM pending_uploads WHERE r2_key = ?', key)).toBeNull()
  })

  test('gambar: bukan milik / terlalu besar dimensi / rosak = 400, objek ditolak dipadam', async () => {
    const u = await member()
    const other = await member()
    const foreign = await uploaded(other.id, png(10, 10))
    expect(await h.body(await post(u.token, { content: 'x', r2_keys: [foreign] }))).toEqual({ error: 'gambar tidak sah atau belum diupload' })
    const huge = await uploaded(u.id, png(5000, 10))
    expect(await h.body(await post(u.token, { content: 'x', r2_keys: [huge] }))).toEqual({ error: 'dimensi gambar melebihi 4096px' })
    expect(await h.env.BUCKET.get(huge)).toBeNull()
    const junk = await uploaded(u.id, new Uint8Array([1, 2, 3]))
    expect(await h.body(await post(u.token, { content: 'x', r2_keys: [junk] }))).toEqual({ error: 'gambar tidak sah atau belum diupload' })
  })

  test('peraturan cipta: jenis, had gambar, pengumuman management sahaja, emel belum disahkan', async () => {
    const u = await member()
    expect(await h.body(await post(u.token, { type: 'iklan', content: 'x' }))).toEqual({ error: 'jenis post tidak sah' })
    expect(await h.body(await post(u.token, { content: 'x', r2_keys: ['a', 'b', 'c', 'd', 'e'] }))).toEqual({ error: 'maksimum 4 gambar setiap post' })
    expect(await h.body(await post(u.token, { type: 'announcement', content: 'x' }))).toEqual({ error: 'cuma management boleh buat pengumuman' })
    const m = await member({ role: ROLE.manager })
    expect((await post(m.token, { type: 'announcement', content: 'x' })).status).toBe(201)
    const unverified = await seedMember(h)
    expect((await post(await tokenFor(unverified.id), { content: 'x' })).status).toBe(403)
  })

  test('sunting: pemilik sahaja; CAS lapuk = 409 stale_write', async () => {
    const u = await member()
    const other = await member({ role: ROLE.superadmin })
    const p = await h.body(await post(u.token, { content: 'asal' }))
    const edit = (token: string, updated_at: unknown) => h.request(`/posts/${p.id}`, { method: 'PATCH', token, json: { content: 'baru', updated_at } })
    expect(await h.body(await edit(other.token, p.updated_at))).toEqual({ error: 'cuma pemilik boleh edit post' })
    const ok = await h.body(await edit(u.token, p.updated_at))
    expect(ok.content).toBe('baru')
    expect(ok.edited_at).not.toBeNull()
    const stale = await edit(u.token, p.updated_at)
    expect([stale.status, (await h.body(stale)).code]).toEqual([409, 'stale_write'])
  })

  test('padam: management boleh padam post orang; gambar digilir; komen pada post dipadam = 404', async () => {
    const u = await member()
    const key = await uploaded(u.id, png(10, 10))
    const p = await h.body(await post(u.token, { content: 'x', r2_keys: [key] }))
    const stranger = await member()
    const del = (token: string) => h.request(`/posts/${p.id}`, { method: 'DELETE', token, json: { updated_at: p.updated_at } })
    expect(await h.body(await del(stranger.token))).toEqual({ error: 'tidak dibenarkan padam post ini' })
    const m = await member({ role: ROLE.manager })
    expect((await del(m.token)).status).toBe(204)
    expect(await h.row('SELECT reason FROM deleted_uploads WHERE r2_key = ?', key)).toEqual({ reason: 'post_deleted' })
    expect(await h.row("SELECT action FROM audit_logs WHERE entity_id = ? AND action = 'delete'", p.id)).toEqual({ action: 'delete' })
    expect((await h.request(`/posts/${p.id}`, { token: u.token })).status).toBe(404)
    expect(await h.body(await h.request(`/posts/${p.id}/comments`, { method: 'POST', token: u.token, json: { content: 'x' } }))).toEqual({ error: 'post tidak dijumpai' })
  })

  test('like: sekali notifikasi walau diulang; like sendiri tiada notifikasi', async () => {
    const owner = await member()
    const fan = await member()
    const p = await h.body(await post(owner.token, { content: 'x' }))
    h.sent.jobs.length = 0
    for (let i = 0; i < 2; i++) expect((await h.request(`/posts/${p.id}/like`, { method: 'POST', token: fan.token })).status).toBe(204)
    await h.request(`/posts/${p.id}/like`, { method: 'POST', token: owner.token })
    expect(h.sent.jobs).toEqual([
      { type: 'notify', kind: 'post_like', actorId: fan.id, recipientIds: [owner.id], postId: p.id as string, push: { title: 'Post anda disukai', message: 'Seseorang menyukai post anda' } },
    ])
    const got = await h.body(await h.request(`/posts/${p.id}`, { token: fan.token }))
    expect([got.like_count, got.liked_by_me]).toEqual([2, true])
    expect((await h.request(`/posts/${crypto.randomUUID()}/like`, { method: 'POST', token: fan.token })).status).toBe(404)
  })

  test('senarai: keyset kursor tanpa pertindihan', async () => {
    const u = await member()
    for (let i = 0; i < 3; i++) await post(u.token, { content: `k${i}` })
    const first = await h.body(await h.request('/posts?limit=2', { token: u.token }))
    expect((first.posts as unknown[]).length).toBe(2)
    const next = await h.body(await h.request(`/posts?limit=2&cursor=${encodeURIComponent(first.next_cursor as string)}`, { token: u.token }))
    const ids = [...(first.posts as { id: string }[]), ...(next.posts as { id: string }[])].map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(await h.body(await h.request('/posts?cursor=rosak', { token: u.token }))).toEqual({ error: 'cursor tidak sah' })
  })
})

describe('komen', () => {
  test('kedalaman 2: balasan kepada balasan dilekat pada induk tahap-1; pratonton + kiraan', async () => {
    const owner = await member()
    const u = await member()
    const p = await h.body(await post(owner.token, { content: 'x' }))
    const comment = async (json: unknown) => h.body(await h.request(`/posts/${p.id}/comments`, { method: 'POST', token: u.token, json }))
    const top = await comment({ content: 'satu' })
    const reply = await comment({ content: 'dua', parent_comment_id: top.id })
    const deep = await comment({ content: 'tiga', parent_comment_id: reply.id })
    expect([reply.parent_comment_id, deep.parent_comment_id]).toEqual([top.id, top.id])
    expect(await comment({ content: 'x', parent_comment_id: crypto.randomUUID() })).toEqual({ error: 'comment induk tidak dijumpai' })
    expect(h.sent.jobs.at(-1)).toMatchObject({ kind: 'post_comment', recipientIds: [owner.id], postId: p.id })

    const got = await h.body(await h.request(`/posts/${p.id}`, { token: owner.token }))
    expect(got.comment_count).toBe(3)
    expect((got.comment_previews as { id: string }[]).map((c) => c.id)).toEqual([top.id as string])
    expect(((await h.body(await h.request(`/posts/${p.id}/comments`, { token: owner.token }))).comments as unknown[]).length).toBe(3)
  })

  test('sunting pemilik sahaja; padam oleh management; like komen', async () => {
    const owner = await member()
    const u = await member()
    const p = await h.body(await post(owner.token, { content: 'x' }))
    const c = await h.body(await h.request(`/posts/${p.id}/comments`, { method: 'POST', token: u.token, json: { content: 'asal' } }))
    expect(await h.body(await h.request(`/comments/${c.id}`, { method: 'PATCH', token: owner.token, json: { content: 'y', updated_at: c.updated_at } }))).toEqual({
      error: 'cuma pemilik boleh edit comment',
    })
    const edited = await h.body(await h.request(`/comments/${c.id}`, { method: 'PATCH', token: u.token, json: { content: 'baru', updated_at: c.updated_at } }))
    expect(edited.content).toBe('baru')

    expect((await h.request(`/comments/${c.id}/like`, { method: 'POST', token: owner.token })).status).toBe(204)
    expect(h.sent.jobs.at(-1)).toMatchObject({ kind: 'comment_like', recipientIds: [u.id], commentId: c.id })

    const m = await member({ role: ROLE.manager })
    expect((await h.request(`/comments/${c.id}`, { method: 'DELETE', token: m.token, json: { updated_at: edited.updated_at } })).status).toBe(204)
    expect((await h.body(await h.request(`/posts/${p.id}`, { token: owner.token }))).comment_count).toBe(0)
  })
})

describe('uploads', () => {
  test('reaper: upload > 5 MB yang belum dilampir dibuang selepas ~10 min; kecil & baharu kekal', async () => {
    const u = await member()
    const now = Date.now()
    const put = async (bytes: number, ageMin: number) => {
      const key = `posts/${crypto.randomUUID()}`
      await h.env.BUCKET.put(key, new Uint8Array(bytes))
      await h.db.prepare('INSERT INTO pending_uploads (r2_key, user_id, created_at) VALUES (?, ?, ?)').bind(key, u.id, now - ageMin * 60_000).run()
      return key
    }
    const big = await put(5 * 1024 * 1024 + 1, 12)
    const small = await put(1024, 12)
    const fresh = await put(5 * 1024 * 1024 + 1, 2) // URL mungkin masih sah - belum disemak
    // Larian 1: yang besar & cukup tua digilir (keluar dari pending); kecil & baharu tidak disentuh.
    await reaper(h.env, now)
    expect(await h.row('SELECT 1 AS x FROM pending_uploads WHERE r2_key = ?', big)).toBeNull()
    expect(await h.row('SELECT reason FROM deleted_uploads WHERE r2_key = ?', big)).toEqual({ reason: 'upload_oversized' })
    expect(await h.row('SELECT 1 AS x FROM deleted_uploads WHERE r2_key IN (?, ?)', small, fresh)).toBeNull()
    // Larian 2 (15 min kemudian): objek dipadam dari R2; yang "baharu" kini dalam tetingkap.
    await reaper(h.env, now + 15 * 60_000)
    expect(await h.env.BUCKET.head(big)).toBeNull()
    expect(await h.row('SELECT deleted_at IS NOT NULL AS done FROM deleted_uploads WHERE r2_key = ?', big)).toEqual({ done: 1 })
    expect(await h.row('SELECT reason FROM deleted_uploads WHERE r2_key = ?', fresh)).toEqual({ reason: 'upload_oversized' })
    expect((await h.env.BUCKET.head(small))?.size).toBe(1024)
  })

  test('presign: R2 belum dikonfigurasi = 503; jenis tidak disokong = 400; sah = URL + pending', async () => {
    const u = await member()
    const presign = (json: unknown, env = {}) => h.request('/uploads/presign', { method: 'POST', token: u.token, json }, env)
    expect(await h.body(await presign({ content_type: 'image/png' }))).toEqual({ error: 'upload gambar belum tersedia' })
    const r2 = { R2_ACCOUNT_ID: 'acc', R2_ACCESS_KEY_ID: 'id', R2_SECRET_ACCESS_KEY: 'secret', R2_BUCKET_NAME: 'marc' }
    expect(await h.body(await presign({ content_type: 'image/gif' }, r2))).toEqual({ error: 'jenis fail tidak disokong' })
    const ok = await h.body(await presign({ content_type: 'image/png' }, r2))
    expect(ok.upload_url).toStartWith('https://acc.r2.cloudflarestorage.com/marc/posts/')
    expect(await h.row('SELECT user_id FROM pending_uploads WHERE r2_key = ?', ok.r2_key)).toEqual({ user_id: u.id })
  })
})
