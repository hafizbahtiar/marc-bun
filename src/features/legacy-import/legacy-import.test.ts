// "Ujian wajib" docs/modules/10-legacy-import.md, melalui HTTP + D1 sebenar.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ROLE, seedMember, testApp, tokenFor, type Harness } from '../../test/app'
import { HEADER_NAMES } from './parse'

let h: Harness
let sa: string
const quiet = { log: console.log, error: console.error }
beforeAll(async () => {
  console.log = () => { }
  console.error = () => { }
  h = await testApp()
  await h.db.prepare("INSERT OR IGNORE INTO departments (code, name) VALUES ('BPI', 'Bahagian BPI')").run()
  sa = await tokenFor((await seedMember(h, { role: ROLE.superadmin })).id)
}, 60_000)
afterAll(async () => {
  Object.assign(console, quiet)
  await h.dispose()
})

type R = { bil: number; staff: string; member: string; name?: string; email: string; dept?: string; status?: string }
const line = (r: R) =>
  [r.bil, r.status ?? 'Aktif', 'LAMA', 'Tiada', 'MARC-', r.staff, '/', '2026', '-', r.bil, r.member, r.name ?? `Nama ${r.bil}`, '0123456789', r.email, r.dept ?? 'BPI', '', 'Pegawai', '', '', '', '', '', '', ''].join(',')
const csv = (rows: R[]) => ['SENARAI,,,', HEADER_NAMES.join(','), ...rows.map(line)].join('\n')

async function dryRun(rows: R[], token = sa) {
  const fd = new FormData()
  fd.set('file', new File([csv(rows)], 'ahli.csv', { type: 'text/csv' }))
  return h.request('/admin/legacy-member-import/dry-run', { method: 'POST', token, body: fd })
}
const rowsOf = async (id: string) => (await h.body(await h.request(`/admin/legacy-member-import/${id}`, { token: sa }))).rows as Record<string, unknown>[]
let seq = 0
const uniq = () => `${Date.now().toString(36)}${++seq}`

describe('dry-run & semakan', () => {
  test('superadmin sahaja; konflik fail + akaun sebenar + bahagian; conflicts sentiasa array', async () => {
    const ahli = await tokenFor((await seedMember(h, { role: ROLE.admin })).id)
    expect(await h.body(await dryRun([], ahli))).toEqual({ error: 'tindakan ini untuk superadmin sahaja' })

    const existing = await seedMember(h) // staff_id sebenar S-n
    const u = uniq()
    const res = await dryRun([
      { bil: 1, staff: `A${u}`, member: `M1${u}`, email: `a${u}@x.my` },
      { bil: 2, staff: `B${u}`, member: `M2${u}`, email: `b${u}@x.my`, dept: 'TIADA' },
      { bil: 3, staff: existing.staffId, member: `M3${u}`, email: `c${u}@x.my` },
    ])
    expect(res.status).toBe(201)
    const b = await h.body(res)
    expect(b).toMatchObject({ source_file: 'ahli.csv', total_rows: 3, valid_rows: 1, conflict_rows: 2, header_row: 2 })
    const rows = await rowsOf(b.id as string)
    expect(rows.map((r) => [r.status, (r.conflicts as { code: string }[]).map((c) => c.code)])).toEqual([
      ['valid', []],
      ['conflict', ['unknown_department']],
      ['conflict', ['existing_staff_id']],
    ])
    expect(rows[0]!.warnings).toEqual([])
    expect(await h.body(await h.request('/admin/legacy-member-import/batches', { token: sa }))).toMatchObject({ batches: expect.arrayContaining([expect.objectContaining({ id: b.id, status: 'dry_run' })]) })
  })

  test('1,000 baris tanpa melanggar had parameter', async () => {
    const u = uniq()
    const rows = Array.from({ length: 1000 }, (_, i) => ({ bil: i + 1, staff: `K${u}-${i}`, member: `N${u}-${i}`, email: `k${i}.${u}@x.my` }))
    const b = await h.body(await dryRun(rows))
    expect([b.total_rows, b.valid_rows]).toEqual([1000, 1000])
    expect((await h.row('SELECT COUNT(*) AS n FROM legacy_member_import_rows WHERE batch_id = ?', b.id))!.n).toBe(1000)
  })

  test('betulkan satu baris → seluruh batch dinilai semula (pendua ialah pasangan)', async () => {
    const u = uniq()
    const b = await h.body(
      await dryRun([
        { bil: 1, staff: `D${u}`, member: `P1${u}`, email: `d1${u}@x.my` },
        { bil: 2, staff: `D${u}`, member: `P2${u}`, email: `d2${u}@x.my` },
      ]),
    )
    const [r1, r2] = await rowsOf(b.id as string)
    expect([r1!.status, r2!.status]).toEqual(['conflict', 'conflict'])
    const patch = (json: unknown) => h.request(`/admin/legacy-member-import/rows/${r2!.id}`, { method: 'PATCH', token: sa, json })
    expect(await h.body(await patch({}))).toEqual({ error: 'tiada medan untuk dikemas kini' })
    expect(await h.body(await patch({ legacy_staff_id: ' ' }))).toEqual({ error: 'No. ID. tidak boleh kosong' })
    expect(await h.body(await patch({ legacy_staff_id: `E${u}` }))).toEqual({ batch_id: b.id })
    expect((await rowsOf(b.id as string)).map((r) => r.status)).toEqual(['valid', 'valid'])
    expect(await h.row('SELECT valid_rows, conflict_rows FROM legacy_member_import_batches WHERE id = ?', b.id)).toEqual({ valid_rows: 2, conflict_rows: 0 })
  })

  test('resolve-department: cipta bahagian + tulis semula rujukan baris serentak', async () => {
    const u = uniq()
    const b = await h.body(await dryRun([{ bil: 1, staff: `F${u}`, member: `Q${u}`, email: `f${u}@x.my`, dept: 'PEJ. TKPE (P) / BKP' }]))
    const resolve = (json: unknown) => h.request(`/admin/legacy-member-import/${b.id}/resolve-department`, { method: 'POST', token: sa, json })
    expect(await h.body(await resolve({ from: 'PEJ. TKPE (P) / BKP', code: 'A/B', name: 'x' }))).toEqual({ error: "kod bahagian tidak boleh mengandungi '/'" })
    expect(await h.body(await resolve({ from: 'PEJ. TKPE (P) / BKP', code: `TKPE${u}` }))).toEqual({ error: 'nama diperlukan untuk bahagian baharu' })
    expect(await h.body(await resolve({ from: 'pej. tkpe (p) / bkp', code: `TKPE${u}`, name: 'Pejabat TKPE' }))).toEqual({ code: `TKPE${u}` })
    const [row] = await rowsOf(b.id as string)
    expect([row!.department_code, row!.status]).toEqual([`TKPE${u}`, 'valid'])
    // Kod sedia ada (huruf berbeza) = gabung, bukan pendua.
    expect(await h.body(await resolve({ from: `TKPE${u}`, code: 'bpi' }))).toEqual({ code: 'BPI' })
  })
})

describe('import & tuntutan', () => {
  test('import: hanya akaun sedia ada dikemas kini; diulang = tiada pendua', async () => {
    const acct = await seedMember(h, { displayName: undefined })
    await h.db.prepare('UPDATE profiles SET display_name = NULL, staff_id = user_id, member_id = NULL WHERE user_id = ?').bind(acct.id).run()
    const u = uniq()
    const b = await h.body(
      await dryRun([
        { bil: 1, staff: `G${u}`, member: `R1${u}`, email: acct.email, name: 'Dari Eksport', status: 'Tidak Aktif' },
        { bil: 2, staff: `H${u}`, member: `R2${u}`, email: `h${u}@x.my` },
      ]),
    )
    const imp = () => h.request(`/admin/legacy-member-import/${b.id}/import`, { method: 'POST', token: sa })
    expect(await h.body(await imp())).toEqual({ imported: 1, blocked: 0, unclaimed: 'baris tanpa akaun kekal untuk claim' })
    expect(await h.row('SELECT display_name, staff_id, member_id, is_active, staff_id_verified_at IS NOT NULL AS v FROM profiles WHERE user_id = ?', acct.id)).toEqual({
      display_name: 'Dari Eksport',
      staff_id: `G${u}`,
      member_id: `R1${u}`,
      is_active: 0,
      v: 1,
    })
    expect(await h.body(await imp())).toMatchObject({ imported: 0 })
    expect((await h.row("SELECT COUNT(*) AS n FROM audit_logs WHERE entity_type = 'profile' AND new_values LIKE ?", `%G${u}%`))!.n).toBe(1)
    expect((await rowsOf(b.id as string)).map((r) => r.status)).toEqual(['imported', 'valid'])
  })

  test('claim: respons sama untuk tiga kes; lengkapkan sekali; pautan luput/diguna → 400', async () => {
    const u = uniq()
    const email = `claim${u}@x.my`
    await dryRun([{ bil: 1, staff: `C${u}`, member: `S${u}`, email, name: 'Penuntut' }])
    const existing = await seedMember(h)
    const request = (json: unknown) => h.request('/auth/legacy-member-claim/request', { method: 'POST', json })
    const cases = [
      { email, staff_id: `C${u}` }, // padan
      { email: `tiada${u}@x.my`, staff_id: 'X' }, // tidak padan
      { email: existing.email, staff_id: existing.staffId }, // akaun wujud
    ]
    const responses = await Promise.all(cases.map(async (json) => {
      const res = await request(json)
      return [res.status, await res.text()]
    })) // prettier-ignore
    expect(responses).toEqual([
      [204, ''],
      [204, ''],
      [204, ''],
    ])
    expect(await h.body(await request({ email: 'bukan-emel', staff_id: 'x' }))).toEqual({ error: 'Format email tidak sah' })

    // Emel dikonfigurasi → pautan ke halaman frontend (bukan PUBLIC_BASE_URL backend).
    h.sent.emails.length = 0
    await h.request('/auth/legacy-member-claim/request', { method: 'POST', json: cases[0] }, { RESEND_API_KEY: 're_x', EMAIL_FROM: 'MARC <a@b.my>', CLAIM_ACCOUNT_URL: 'https://marc.test/claim-account' })
    expect(h.sent.emails.map((e) => [e.to, e.subject])).toEqual([[email, 'Tuntut akaun MARC']])
    expect(h.sent.emails[0]!.html).toContain('href="https://marc.test/claim-account?token=')

    // Pautan hanya dilog di development (emel belum dikonfigurasi dalam ujian) - token dijana semula di sini.
    const token = `tok-${u}`
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))].map((b) => b.toString(16).padStart(2, '0')).join('')
    await h.db.prepare('UPDATE legacy_member_claim_tokens SET token_hash = ? WHERE row_id = (SELECT id FROM legacy_member_import_rows WHERE email = ?)').bind(hash, email).run()

    const complete = (json: unknown) => h.request('/auth/legacy-member-claim/complete', { method: 'POST', json })
    expect(await h.body(await complete({ token, password: '123' }))).toEqual({ error: 'Kata laluan diperlukan (minimum 6 aksara)' })
    expect((await complete({ token, password: 'rahsia123' })).status).toBe(204)
    const user = await h.row('SELECT u.id, p.status, p.email_verified, p.staff_id, p.department_code FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.email = ?', email)
    expect(user).toMatchObject({ status: 'approved', email_verified: 1, staff_id: `C${u}`, department_code: 'BPI' })
    expect(await h.row('SELECT status, user_id FROM legacy_member_import_rows WHERE email = ?', email)).toEqual({ status: 'claimed', user_id: user!.id })
    expect(await h.body(await complete({ token, password: 'rahsia123' }))).toEqual({ error: 'pautan claim tidak sah atau sudah luput' })
    // Login dengan kata laluan baharu berfungsi.
    expect((await h.request('/auth/login', { method: 'POST', json: { email, password: 'rahsia123' } })).status).toBe(200)
  })
})
