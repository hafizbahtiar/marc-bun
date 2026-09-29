// "Ujian wajib" docs/modules/09-audit.md (trigger append-only: src/database/schema.test.ts).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { auditStmt } from '../../shared/audit'
import { ROLE, seedMember, testApp, tokenFor, type Harness } from '../../test/app'
import { retention } from './jobs'

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

const DAY = 86_400_000
const actor = { userId: null, ip: '1.2.3.4', userAgent: 'ua' }

describe('GET /audit-logs', () => {
  test('pengurusan sahaja; tapisan entiti, keyset, JSON dihurai', async () => {
    const entity = crypto.randomUUID()
    await h.db.batch([1, 2, 3].map((i) => auditStmt(h.db, { entityType: 'post', entityId: entity, action: 'update', actor, old: { n: i - 1 }, new: { n: i } })!))
    const ahli = await tokenFor((await seedMember(h)).id)
    expect(await h.body(await h.request('/audit-logs', { token: ahli }))).toEqual({ error: 'cuma pengurusan boleh lihat jejak audit' })

    const sup = await tokenFor((await seedMember(h, { role: ROLE.supervisor })).id)
    const get = async (q: string) => h.body(await h.request(`/audit-logs${q}`, { token: sup }))
    const timeline = (await get(`?entity_type=post&entity_id=${entity}&limit=2`)).logs as Record<string, unknown>[]
    expect(timeline.map((l) => l.new_values)).toEqual([{ n: 3 }, { n: 2 }])
    expect(timeline[0]).toMatchObject({ changed_fields: ['n'], old_values: { n: 2 }, action: 'update', actor_id: null })
    expect(timeline[0]).not.toHaveProperty('ip_address')

    const page = (await get(`?entity_type=post&before_id=${timeline[1]!.id}`)).logs as { id: number }[]
    expect(page.every((l) => l.id < (timeline[1]!.id as number))).toBe(true)
    expect(await get(`?entity_id=${entity}`)).toEqual({ error: 'entity_type wajib bersama entity_id' })
    expect(await get('?actor_id=x')).toEqual({ error: 'actor_id tidak sah' })
    expect(await get('?limit=-1')).toEqual({ error: 'limit tidak sah' })
  })

  test('mutasi gagal dalam batch → tiada baris audit', async () => {
    const entity = crypto.randomUUID()
    await expect(h.db.batch([auditStmt(h.db, { entityType: 'post', entityId: entity, action: 'create', actor, new: { a: 1 } })!, h.db.prepare('INSERT INTO tiada_jadual VALUES (1)')])).rejects.toThrow()
    expect(await h.row('SELECT 1 FROM audit_logs WHERE entity_id = ?', entity)).toBeNull()
  })
})

describe('retention', () => {
  test('2,500 baris lama dipadam merentas kepingan; baharu kekal; PII diredaksi; 0 = mati', async () => {
    const now = Date.now()
    const insert = (entity: string, age: number) =>
      h.db.prepare("INSERT INTO audit_logs (entity_type, entity_id, action, ip_address, user_agent, created_at) VALUES ('post', ?, 'create', '1.1.1.1', 'ua', ?)").bind(entity, now - age)
    const old = crypto.randomUUID()
    const mid = crypto.randomUUID()
    const fresh = crypto.randomUUID()
    const rows = [...Array.from({ length: 2500 }, () => insert(old, 400 * DAY)), insert(mid, 100 * DAY), insert(fresh, DAY)]
    for (let i = 0; i < rows.length; i += 500) await h.db.batch(rows.slice(i, i + 500))
    await h.db.batch([
      h.db.prepare("INSERT INTO deleted_uploads (r2_key, reason, deleted_at) VALUES ('lama', 'x', ?), ('belum', 'x', NULL)").bind(now - 40 * DAY),
      h.db.prepare("INSERT INTO payment_logs (module, event, status, gateway, created_at) VALUES ('donation', 'e', 'ok', 'stripe', ?)").bind(now - 100 * DAY),
    ])

    await retention({ ...h.env, AUDIT_RECORD_RETENTION_DAYS: '0' } as CloudflareBindings, now) // padam dimatikan
    expect((await h.row('SELECT COUNT(*) AS n FROM audit_logs WHERE entity_id = ?', old))!.n).toBe(2500)

    await retention(h.env, now)
    expect((await h.row('SELECT COUNT(*) AS n FROM audit_logs WHERE entity_id = ?', old))!.n).toBe(0)
    expect(await h.row('SELECT ip_address, user_agent FROM audit_logs WHERE entity_id = ?', mid)).toEqual({ ip_address: null, user_agent: null })
    expect(await h.row('SELECT ip_address FROM audit_logs WHERE entity_id = ?', fresh)).toEqual({ ip_address: '1.1.1.1' })
    expect((await h.db.prepare('SELECT r2_key FROM deleted_uploads').all()).results).toEqual([{ r2_key: 'belum' }])
    expect(await h.row('SELECT COUNT(*) AS n FROM payment_logs WHERE created_at < ?', now - 90 * DAY)).toEqual({ n: 0 })
  })
})
