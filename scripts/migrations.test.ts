import { describe, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { problems } from './check-migrations'
import { owners, stamp } from './db-new'

describe('db:new', () => {
  test('cap masa UTC YYYYMMDDHHMMSS', () => {
    expect(stamp(new Date(Date.UTC(2026, 8, 26, 1, 2, 3)))).toBe('20260926010203')
  })

  test('feature diambil dari peta pemilik', async () => {
    const f = owners(await Bun.file(join(import.meta.dir, '../docs/modules/README.md')).text())
    expect(f).toContain('blocked_email_domains')
    expect(f).toContain('legacy_import')
  })

  test('semua migrasi sedia ada ikut format', () => {
    const files = readdirSync(join(import.meta.dir, '../src/database/migrations'))
    for (const f of files) expect(f).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/)
  })
})

describe('check-migrations', () => {
  const base = ['m/20260926100000_auth.sql', 'm/20260926100100_members.sql']

  test('migrasi baharu selepas terkini = lulus', () => {
    expect(problems([], ['m/20261001090000_posts_pin.sql'], base)).toEqual([])
  })

  test('suntingan migrasi sedia ada ditolak', () => {
    expect(problems(['m/20260926100000_auth.sql'], [], base)).toHaveLength(1)
  })

  test('cawangan lama (cap masa lebih awal) ditolak', () => {
    expect(problems([], ['m/20260926100050_posts_pin.sql'], base)[0]).toContain('di luar urutan')
  })

  test('nama bukan cap masa ditolak', () => {
    expect(problems([], ['m/0016_posts.sql'], base)[0]).toContain('nama tidak sah')
  })
})
