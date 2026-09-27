// "Ujian wajib" docs/modules/07-account-lifecycle.md, melalui HTTP + D1/KV sebenar.
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
const requests = (token: string) => h.request('/admin/account-deletion-requests', { token })
const targets = (token: string) => h.request('/admin/account-deletion-targets', { token })
const execute = (token: string, mode: 'requests' | 'targets', id: string, json?: unknown) =>
  h.request(`/admin/account-deletion-${mode}/${id}/execute`, { method: 'POST', token, ...(json === undefined ? {} : { json }) })

// Mangsa lengkap: avatar, karangan upload, gambar post, dan derma TANPA emel
// (baris itu menggagalkan pemadaman jika payments.detach() tiada).
// Setiap kunci R2 mengandungi user id, jadi ujian boleh menapis miliknya sahaja.
async function victim() {
  const u = await seedMember(h)
  const avatar = `avatars/${u.id}.jpg`
  const postId = crypto.randomUUID()
  const donationId = crypto.randomUUID()
  await h.db.batch([
    h.db.prepare('UPDATE profiles SET avatar_r2_key = ? WHERE user_id = ?').bind(avatar, u.id),
    h.db.prepare("INSERT INTO donations (id, user_id, amount_cents, gateway, gateway_ref) VALUES (?, ?, 500, 'stripe', ?)").bind(donationId, u.id, `D-${donationId}`),
    h.db.prepare('INSERT INTO pending_uploads (r2_key, user_id) VALUES (?, ?)').bind(`karangan/${u.id}.jpg`, u.id),
    h.db.prepare('INSERT INTO posts (id, author_id, content) VALUES (?, ?, ?)').bind(postId, u.id, 'hai'),
  ])
  await h.db.prepare('INSERT INTO post_images (id, post_id, r2_key, position) VALUES (?, ?, ?, 0)').bind(crypto.randomUUID(), postId, `posts/${u.id}.jpg`).run()
  return { ...u, avatar, postId, donationId }
}

const queuedFor = async (userId: string) =>
  (await h.db.prepare("SELECT r2_key FROM deleted_uploads WHERE r2_key LIKE '%' || ? || '%' ORDER BY r2_key").bind(userId).all<{ r2_key: string }>()).results.map((r) => r.r2_key)

describe('siling', () => {
  test('superadmin sahaja', async () => {
    const manager = await seedMember(h, { role: ROLE.manager })
    const token = await as(manager.id)
    for (const res of [await requests(token), await targets(token), await execute(token, 'targets', crypto.randomUUID(), { reason: 'x' })]) {
      expect([res.status, await h.body(res)]).toEqual([403, { error: 'tindakan ini untuk superadmin sahaja' }])
    }
  })
})

describe('senarai', () => {
  test('permintaan ahli + sasaran langsung (superadmin dikecualikan)', async () => {
    const root = await seedMember(h, { role: ROLE.superadmin })
    const token = await as(root.id)
    const u = await seedMember(h, { status: 'pending' })
    await h.request('/me/deletion-request', { method: 'POST', token: await as(u.id) })

    const list = (await (await requests(token)).json()) as { requests: Record<string, unknown>[] }
    const mine = list.requests.find((r) => r.user_id === u.id)!
    expect(mine).toMatchObject({ status: 'pending', completed_at: null, account_status: 'pending' })
    expect(typeof mine.requested_at).toBe('string')

    const all = (await (await targets(token)).json()) as { accounts: Record<string, unknown>[] }
    const ids = all.accounts.map((a) => a.user_id)
    expect(ids).toContain(u.id)
    expect(ids).not.toContain(root.id)
  })
})

describe('execute', () => {
  test('permintaan ahli: tanpa permintaan = 409; pelaksanaan memadam + gilir objek + audit + KV', async () => {
    const root = await seedMember(h, { role: ROLE.superadmin })
    const token = await as(root.id)
    const u = await victim()

    const early = await execute(token, 'requests', u.id)
    expect([early.status, await h.body(early)]).toEqual([409, { error: 'akaun ini tiada permintaan pemadaman yang menunggu' }])

    await h.request('/me/deletion-request', { method: 'POST', token: await as(u.id) })
    const done = await execute(token, 'requests', u.id)
    expect([done.status, await h.body(done)]).toEqual([200, { ok: true, user_id: u.id }])

    expect(await h.row('SELECT COUNT(*) n FROM users WHERE id = ?', u.id)).toEqual({ n: 0 })
    expect(await h.row('SELECT COUNT(*) n FROM profiles WHERE user_id = ?', u.id)).toEqual({ n: 0 })
    expect(await h.row('SELECT COUNT(*) n FROM post_images WHERE post_id = ?', u.postId)).toEqual({ n: 0 })
    expect(await h.row('SELECT COUNT(*) n FROM account_deletion_requests WHERE user_id = ?', u.id)).toEqual({ n: 0 })

    // Rekod kewangan kekal, tetapi dipisahkan daripada akaun (emel disalin dahulu).
    expect(await h.row('SELECT user_id, donor_email FROM donations WHERE id = ?', u.donationId)).toEqual({ user_id: null, donor_email: u.email })

    const queued = await queuedFor(u.id)
    expect(queued).toEqual([u.avatar, `karangan/${u.id}.jpg`, `posts/${u.id}.jpg`].sort())

    const audit = await h.row("SELECT action, old_values FROM audit_logs WHERE entity_id = ? AND action = 'delete'", u.id)
    expect(JSON.parse(audit!.old_values as string)).toMatchObject({ email: u.email, deletion_mode: 'member_request' })
    expect(await h.env.KV.get(`rv:user:${u.id}`)).not.toBeNull()
  })

  test('pemadaman terus: sebab wajib, bukan diri sendiri, bukan superadmin, id mesti UUID', async () => {
    const root = await seedMember(h, { role: ROLE.superadmin })
    const other = await seedMember(h, { role: ROLE.superadmin })
    const token = await as(root.id)

    expect(await h.body(await execute(token, 'targets', other.id))).toEqual({ error: 'Data tidak sah' })
    expect(await h.body(await execute(token, 'targets', other.id, { reason: '   ' }))).toEqual({ error: 'sebab pemadaman diperlukan' })
    expect(await h.body(await execute(token, 'targets', root.id, { reason: 'sebab' }))).toEqual({ error: 'akaun sendiri tidak boleh dipadam melalui modul ini' })
    expect(await h.body(await execute(token, 'targets', other.id, { reason: 'sebab' }))).toEqual({ error: 'akaun superadmin tidak boleh dipadam melalui modul ini' })
    expect(await h.body(await execute(token, 'targets', 'bukan-uuid', { reason: 'sebab' }))).toEqual({ error: 'ID pengguna tidak sah' })
    expect(await h.row('SELECT COUNT(*) n FROM users WHERE id = ?', other.id)).toEqual({ n: 1 })

    const u = await seedMember(h)
    expect((await execute(token, 'targets', u.id, { reason: 'permintaan pemilik' })).status).toBe(200)
    expect(await h.row('SELECT COUNT(*) n FROM users WHERE id = ?', u.id)).toEqual({ n: 0 })
  })

  test('batch gagal di tengah → tiada apa berubah (separuh jalan mustahil)', async () => {
    const root = await seedMember(h, { role: ROLE.superadmin })
    const token = await as(root.id)
    const u = await victim()

    // Paksa satu statement dalam batch gagal (gilir objek), tanpa menyentuh kod produksi.
    await h.db.prepare("CREATE TRIGGER ujian_gagal BEFORE INSERT ON deleted_uploads BEGIN SELECT RAISE(ABORT, 'ujian: batch mesti rollback'); END").run()
    try {
      const res = await execute(token, 'targets', u.id, { reason: 'sebab' })
      expect([res.status, await h.body(res)]).toEqual([500, { error: 'ralat dalaman' }])
    } finally {
      await h.db.prepare('DROP TRIGGER ujian_gagal').run()
    }

    expect(await h.row('SELECT COUNT(*) n FROM users WHERE id = ?', u.id)).toEqual({ n: 1 })
    expect(await h.row('SELECT COUNT(*) n FROM profiles WHERE user_id = ?', u.id)).toEqual({ n: 1 })
    expect(await queuedFor(u.id)).toEqual([])
    expect(await h.row('SELECT COUNT(*) n FROM audit_logs WHERE entity_id = ?', u.id)).toEqual({ n: 0 })
    expect(await h.env.KV.get(`rv:user:${u.id}`)).toBeNull()
  })
})
