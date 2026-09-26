// Setiap kekangan skema mesti GAGAL bila dilanggar (docs/00002-tooling.md §2).
// DB baharu, migrasi dijalankan dengan runner produksi (src/test/env.ts).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { testEnv } from '../test/env'

let t: Awaited<ReturnType<typeof testEnv>>
let db: D1Database
beforeAll(async () => {
  t = await testEnv()
  db = t.env.DB
}, 60_000)
afterAll(() => t.dispose())

const run = (sql: string, ...params: unknown[]) => db.prepare(sql).bind(...params).run()
const one = <T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<NoInfer<T> | null> => db.prepare(sql).bind(...params).first<T>()
const rejects = (sql: string, ...params: unknown[]) => expect(run(sql, ...params)).rejects.toThrow()

let n = 0
const id = () => `00000000-0000-4000-9000-${String(++n).padStart(12, '0')}`

async function user() {
  const u = id()
  await run('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)', u, `${u}@marc.test`, 'x')
  await run('INSERT INTO profiles (id, user_id, role_id, staff_id) VALUES (?, ?, 1, ?)', id(), u, `S-${u}`)
  return u
}

async function activity() {
  const a = id()
  await run(
    `INSERT INTO activities (id, category_id, title, location_name, starts_at, ends_at, registration_closes_at)
     VALUES (?, '00000000-0000-4000-8000-000000000001', 'A', 'L', 1000, 2000, 900)`,
    a,
  )
  return a
}

describe('struktur', () => {
  test('36 jadual = peta pemilik docs/modules/README.md', async () => {
    const doc = readFileSync(join(import.meta.dir, '../../docs/modules/README.md'), 'utf8')
    const section = doc.split('## Pemilik jadual')[1]!.split('\n## ')[0]!
    const documented = [...section.matchAll(/^\| [a-z-]+ \| (.+) \|$/gm)].flatMap((m) => [...m[1]!.matchAll(/`([a-z_]+)`/g)].map((x) => x[1]!))
    const { results } = await db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'`)
      .all<{ name: string }>()
    expect(results.map((r) => r.name).sort()).toEqual(documented.sort())
  })

  test('setiap jadual STRICT', async () => {
    const { results } = await db.prepare(`PRAGMA table_list`).all<{ name: string; strict: number; schema: string }>()
    const loose = results.filter((r) => r.schema === 'main' && !/^(sqlite_|_cf_|d1_migrations)/.test(r.name) && r.strict !== 1)
    expect(loose.map((r) => r.name)).toEqual([])
  })

  test('STRICT menolak rentetan dalam lajur masa INTEGER', async () => {
    await rejects('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)', id(), 'iso@marc.test', 'x', '2026-01-01T00:00:00Z')
  })

  test('default created_at = unix ms', async () => {
    const u = await user()
    const row = await one<{ created_at: number }>('SELECT created_at FROM users WHERE id = ?', u)
    expect(Math.abs(row!.created_at - Date.now())).toBeLessThan(60_000)
  })
})

describe('seed', () => {
  test('roles: id & rank sama dengan marc_go', async () => {
    const { results } = await db.prepare('SELECT id, key, category, rank FROM roles ORDER BY id').all()
    expect(results).toEqual([
      { id: 1, key: 'ahli', category: 'ahli', rank: 10 },
      { id: 2, key: 'supervisor', category: 'management', rank: 50 },
      { id: 3, key: 'manager', category: 'management', rank: 60 },
      { id: 4, key: 'superadmin', category: 'management', rank: 100 },
      { id: 5, key: 'tester', category: 'ahli', rank: 5 },
      { id: 6, key: 'admin', category: 'management', rank: 80 },
    ])
  })

  test('kategori: 16 aktif, futsal & larian tidak aktif; satu templat aktif; 17 bahagian', async () => {
    expect((await one<{ n: number }>('SELECT COUNT(*) n FROM activity_categories WHERE is_active = 1'))!.n).toBe(16)
    expect((await one<{ n: number }>("SELECT COUNT(*) n FROM activity_categories WHERE key IN ('futsal','larian') AND is_active = 0"))!.n).toBe(2)
    expect((await one<{ n: number }>('SELECT COUNT(*) n FROM certificate_templates WHERE is_active = 1'))!.n).toBe(1)
    expect((await one<{ n: number }>('SELECT COUNT(*) n FROM departments'))!.n).toBe(17)
  })
})

describe('auth & profile', () => {
  test('emel unik tanpa kira huruf', async () => {
    await run('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)', id(), 'Ali@marc.test', 'x')
    await rejects('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)', id(), 'ali@MARC.test', 'x')
  })

  test('profiles: role wujud, status tertutup, staff_id unik, ban tanpa banned_at ditolak', async () => {
    const u = id()
    await run('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)', u, `${u}@m.test`, 'x')
    await rejects('INSERT INTO profiles (id, user_id, role_id, staff_id) VALUES (?, ?, 99, ?)', id(), u, 'S1')
    await rejects("INSERT INTO profiles (id, user_id, role_id, staff_id, status) VALUES (?, ?, 1, ?, 'aktif')", id(), u, 'S2')
    await rejects('INSERT INTO profiles (id, user_id, role_id, staff_id, ban_expires_at) VALUES (?, ?, 1, ?, 5)', id(), u, 'S3')
    await run('INSERT INTO profiles (id, user_id, role_id, staff_id) VALUES (?, ?, 1, ?)', id(), u, 'S4')
    const v = await user()
    await rejects("UPDATE profiles SET staff_id = 'S4' WHERE user_id = ?", v)
  })

  test('padam bahagian → department_code NULL, ahli kekal', async () => {
    await run("INSERT INTO departments (code, name) VALUES ('TMP', 'Sementara')")
    const u = await user()
    await run("UPDATE profiles SET department_code = 'TMP' WHERE user_id = ?", u)
    await run("DELETE FROM departments WHERE code = 'TMP'")
    expect(await one('SELECT department_code FROM profiles WHERE user_id = ?', u)).toEqual({ department_code: null })
  })

  test("kod bahagian dengan '/' ditolak", async () => {
    await rejects("INSERT INTO departments (code, name) VALUES ('A/B', 'x')")
  })

  test('alamat: satu default setiap ahli', async () => {
    const u = await user()
    const addr = "INSERT INTO member_addresses (id, user_id, is_default, address_type, city, postcode, state) VALUES (?, ?, ?, 'landed', 'KL', '50000', 'Selangor')"
    await run(addr, id(), u, 1)
    await run(addr, id(), u, 0)
    await rejects(addr, id(), u, 1)
  })

  test('domain disekat mesti huruf kecil', async () => {
    await rejects("INSERT INTO blocked_email_domains (domain) VALUES ('Spam.COM')")
  })

  test('padam ahli: cascade ke profil, derma kekal dengan user_id NULL', async () => {
    const u = await user()
    const d = id()
    // Pariti marc_go: derma ahli log masuk menyimpan donor_email = '' (bukan NULL).
    await run("INSERT INTO donations (id, user_id, donor_email, amount_cents, gateway, gateway_ref) VALUES (?, ?, '', 500, 'stripe', ?)", d, u, d)
    await run('DELETE FROM users WHERE id = ?', u)
    expect(await one('SELECT COUNT(*) n FROM profiles WHERE user_id = ?', u)).toEqual({ n: 0 })
    expect(await one('SELECT user_id FROM donations WHERE id = ?', d)).toEqual({ user_id: null })
  })

  test('padam ahli tanpa payments.detach() gagal bila donor_email NULL', async () => {
    const u = await user()
    const d = id()
    await run("INSERT INTO donations (id, user_id, amount_cents, gateway, gateway_ref) VALUES (?, ?, 500, 'stripe', ?)", d, u, d)
    await rejects('DELETE FROM users WHERE id = ?', u)
  })
})

describe('aktiviti', () => {
  test('sesi: ends_at > starts_at', async () => {
    const a = await activity()
    await rejects('INSERT INTO activity_sessions (id, activity_id, seq, starts_at, ends_at) VALUES (?, ?, 1, 2000, 2000)', id(), a)
  })

  test('kunci kategori: huruf kecil, nombor, garis bawah', async () => {
    await rejects("INSERT INTO activity_categories (id, key, name) VALUES (?, 'Bola Sepak', 'x')", id())
    await run("INSERT INTO activity_categories (id, key, name) VALUES (?, 'sepak_takraw_2', 'x')", id())
  })

  test('pendaftaran: satu aktif setiap ahli, daftar semula selepas batal dibenarkan', async () => {
    const a = await activity()
    const u = await user()
    const reg = 'INSERT INTO activity_registrations (id, activity_id, user_id, status, checkin_token) VALUES (?, ?, ?, ?, ?)'
    await run(reg, id(), a, u, 'cancelled', id())
    await run(reg, id(), a, u, 'registered', id())
    await rejects(reg, id(), a, u, 'pending_payment', id())
  })

  test("kehadiran: sekali setiap sesi, kaedah tertutup", async () => {
    const a = await activity()
    const u = await user()
    const r = id()
    const s = id()
    await run("INSERT INTO activity_registrations (id, activity_id, user_id, checkin_token) VALUES (?, ?, ?, ?)", r, a, u, id())
    await run('INSERT INTO activity_sessions (id, activity_id, seq, starts_at, ends_at) VALUES (?, ?, 1, 1000, 2000)', s, a)
    await run("INSERT INTO activity_attendances (id, registration_id, session_id, method) VALUES (?, ?, ?, 'manual')", id(), r, s)
    await rejects("INSERT INTO activity_attendances (id, registration_id, session_id, method) VALUES (?, ?, ?, 'scan')", id(), r, s)
    await rejects("INSERT INTO activity_attendances (id, registration_id, session_id, method) VALUES (?, ?, ?, 'qr')", id(), id(), s)
  })

  test('sijil: satu setiap ahli setiap aktiviti, tarikh YYYY-MM-DD, templat aktif tunggal', async () => {
    const a = await activity()
    const u = await user()
    const cert = 'INSERT INTO activity_certificates (id, activity_id, user_id, serial, verify_token, recipient_name, activity_title, activity_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    await rejects(cert, id(), a, u, id(), id(), 'N', 'T', '26/09/2026')
    await run(cert, id(), a, u, id(), id(), 'N', 'T', '2026-09-26')
    await rejects(cert, id(), a, u, id(), id(), 'N', 'T', '2026-09-26')
    await rejects("INSERT INTO certificate_templates (id, name, is_active) VALUES (?, 'Kedua', 1)", id())
  })

  test('aktiviti dengan sijil tidak boleh dipadam (RESTRICT)', async () => {
    const a = await activity()
    const u = await user()
    await run(
      "INSERT INTO activity_certificates (id, activity_id, user_id, serial, verify_token, recipient_name, activity_title, activity_date) VALUES (?, ?, ?, ?, ?, 'N', 'T', '2026-09-26')",
      id(), a, u, id(), id(),
    )
    await rejects('DELETE FROM activities WHERE id = ?', a)
  })
})

describe('bayaran', () => {
  test('derma mesti boleh dijejak', async () => {
    await rejects("INSERT INTO donations (id, amount_cents, gateway, gateway_ref) VALUES (?, 500, 'stripe', ?)", id(), id())
  })

  test('amaun positif, gateway tertutup', async () => {
    await rejects("INSERT INTO donations (id, donor_email, amount_cents, gateway, gateway_ref) VALUES (?, 'a@b.c', 0, 'stripe', ?)", id(), id())
    await rejects("INSERT INTO donations (id, donor_email, amount_cents, gateway, gateway_ref) VALUES (?, 'a@b.c', 5, 'paypal', ?)", id(), id())
  })

  test('yuran pendaftaran: banyak gateway_ref NULL dibenarkan, pendua bukan-NULL ditolak', async () => {
    const u = await user()
    const pay = "INSERT INTO registration_payments (id, user_id, amount_cents, gateway, gateway_ref) VALUES (?, ?, 1000, 'toyyibpay', ?)"
    await run(pay, id(), u, null)
    await run(pay, id(), u, null)
    await run(pay, id(), u, 'BILL1')
    await rejects(pay, id(), u, 'BILL1')
  })
})

describe('notifikasi', () => {
  test('jenis tertutup', async () => {
    const u = await user()
    await rejects("INSERT INTO notifications (id, recipient_id, actor_id, type) VALUES (?, ?, ?, 'post_share')", id(), u, u)
  })
})

describe('audit append-only', () => {
  async function entry(actor: string | null = null) {
    const { meta } = await run(
      "INSERT INTO audit_logs (entity_type, entity_id, action, actor_id, ip_address, user_agent) VALUES ('post', ?, 'update', ?, '1.2.3.4', 'ua')",
      id(), actor,
    )
    return meta.last_row_id
  }

  test('ubah kandungan ditolak', async () => {
    const a = await entry()
    await expect(run("UPDATE audit_logs SET action = 'delete' WHERE id = ?", a)).rejects.toThrow(/append-only/)
    await expect(run("UPDATE audit_logs SET changed_fields = '[\"x\"]' WHERE id = ?", a)).rejects.toThrow(/append-only/)
  })

  test('redaksi ip/ua kepada NULL dibenarkan; ke nilai lain ditolak', async () => {
    const a = await entry()
    await run('UPDATE audit_logs SET ip_address = NULL, user_agent = NULL WHERE id = ?', a)
    await expect(run("UPDATE audit_logs SET ip_address = '9.9.9.9' WHERE id = ?", a)).rejects.toThrow(/append-only/)
  })

  test('redaksi + ubah lajur lain serentak ditolak', async () => {
    const a = await entry()
    await expect(run("UPDATE audit_logs SET ip_address = NULL, entity_type = 'x' WHERE id = ?", a)).rejects.toThrow(/append-only/)
  })

  test('padam pelaku → actor_id NULL (trigger membenarkan), baris kekal', async () => {
    const u = await user()
    const a = await entry(u)
    await run('DELETE FROM users WHERE id = ?', u)
    expect(await one('SELECT actor_id FROM audit_logs WHERE id = ?', a)).toEqual({ actor_id: null })
  })

  test('changed_fields mesti array JSON', async () => {
    await rejects("INSERT INTO audit_logs (entity_type, entity_id, action, changed_fields) VALUES ('post', ?, 'update', '{}')", id())
  })

  test('retention boleh memadam', async () => {
    const a = await entry()
    await run('DELETE FROM audit_logs WHERE id = ?', a)
    expect(await one('SELECT COUNT(*) n FROM audit_logs WHERE id = ?', a)).toEqual({ n: 0 })
  })
})

describe('legacy import', () => {
  test('conflicts/warnings sentiasa array JSON', async () => {
    const b = id()
    await run("INSERT INTO legacy_member_import_batches (id, source_filename, source_sha256) VALUES (?, 'f.csv', 'h')", b)
    await rejects("INSERT INTO legacy_member_import_rows (id, batch_id, source_row, conflicts) VALUES (?, ?, 1, 'null')", id(), b)
    await rejects("INSERT INTO legacy_member_import_rows (id, batch_id, source_row, warnings) VALUES (?, ?, 2, '{}')", id(), b)
    await run('INSERT INTO legacy_member_import_rows (id, batch_id, source_row) VALUES (?, ?, 3)', id(), b)
  })
})
