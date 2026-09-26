import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { app } from './app'
import { rateLimit } from './shared/middleware/rate-limit'
import type { AppEnv } from './shared/types'
import { testEnv } from './test/env'

let t: Awaited<ReturnType<typeof testEnv>>
const quiet = console.log
beforeAll(async () => {
  console.log = () => {} // logger permintaan
  t = await testEnv()
}, 60_000)
afterAll(async () => {
  console.log = quiet
  await t.dispose()
})

describe('app', () => {
  test('GET /healthz', async () => {
    const res = await app.request('/healthz', {}, t.env)
    expect(res.status).toBe(200)
    expect(await res.json<unknown>()).toEqual({ status: 'ok' })
    expect(res.headers.get('X-Request-ID')).toBeTruthy()
  })

  test('laluan tidak wujud = 404 teks Gin', async () => {
    const res = await app.request('/tiada', {}, t.env)
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('404 page not found')
  })

  test('body > 1 MB → 400 Data tidak sah', async () => {
    const res = await app.request('/healthz', { method: 'POST', body: 'x'.repeat((1 << 20) + 1) }, t.env)
    expect(res.status).toBe(400)
    expect(await res.json<unknown>()).toEqual({ error: 'Data tidak sah' })
  })
})

describe('rateLimit', () => {
  const build = (limit: RateLimit['limit']) =>
    new Hono<AppEnv>().use(rateLimit('RL_AUTH')).get('/', (c) => c.text('ok'))
      .request('/', {}, { ...t.env, RL_AUTH: { limit } })

  test('ditolak → 429 dengan mesej marc_go', async () => {
    const res = await build(async () => ({ success: false }))
    expect(res.status).toBe(429)
    expect(await res.json<unknown>()).toEqual({ error: 'terlalu banyak percubaan, cuba lagi sebentar' })
  })

  test('binding gagal → gagal-terbuka', async () => {
    const err = console.error
    console.error = () => {}
    const res = await build(async () => {
      throw new Error('down')
    })
    console.error = err
    expect(res.status).toBe(200)
  })
})

describe('platform (verifikasi TODO.md)', () => {
  test('D1: kunci asing dikuatkuasakan', async () => {
    const row = await t.env.DB.prepare('PRAGMA foreign_keys').first<{ foreign_keys: number }>()
    expect(row?.foreign_keys).toBe(1)
  })

  test('D1: batch atomik - statement gagal membatalkan yang sebelumnya', async () => {
    await t.env.DB.exec('CREATE TABLE t_batch (id TEXT PRIMARY KEY)')
    const failing = t.env.DB.batch([
      t.env.DB.prepare('INSERT INTO t_batch VALUES (?)').bind('a'),
      t.env.DB.prepare('INSERT INTO t_batch VALUES (?)').bind('a'),
    ])
    await expect(failing).rejects.toThrow()
    const n = await t.env.DB.prepare('SELECT COUNT(*) AS n FROM t_batch').first<{ n: number }>()
    expect(n?.n).toBe(0)
  })

  test('KV: bulk get memulangkan Map', async () => {
    await t.env.KV.put('a', '1')
    const got = await t.env.KV.get(['a', 'b'])
    expect(got.get('a')).toBe('1')
    expect(got.get('b')).toBeNull()
  })
})
