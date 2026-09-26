import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { z } from 'zod'
import { getConfig } from './config'
import { chunk, D1_MAX_PARAMS } from './db'
import { ApiError, onError, parseBody, uuidParam } from './http'
import { fromJson, mytMonthRange, mytYear, toJson } from './time'

const post = (app: Hono, body: string) => app.request('/', { method: 'POST', body, headers: { 'Content-Type': 'application/json' } })

describe('parseBody (pariti friendlyBindError)', () => {
  const schema = z.object({
    email: z.email({ error: 'Format email tidak sah' }),
    name: z.string(),
  })
  const app = new Hono().post('/', async (c) => c.json(await parseBody(c, schema))).onError(onError)

  test('medan tak dikenali dibuang, bukan 400', async () => {
    const res = await post(app, JSON.stringify({ email: 'a@b.co', name: 'x', role_id: 1 }))
    expect(res.status).toBe(200)
    expect(await res.json<unknown>()).toEqual({ email: 'a@b.co', name: 'x' })
  })

  test('mesej khusus medan', async () => {
    const res = await post(app, JSON.stringify({ email: 'bukan-emel', name: 'x' }))
    expect(res.status).toBe(400)
    expect(await res.json<unknown>()).toEqual({ error: 'Format email tidak sah' })
  })

  test('tiada mesej khusus → Data tidak sah', async () => {
    const res = await post(app, JSON.stringify({ email: 'a@b.co' }))
    expect(await res.json<unknown>()).toEqual({ error: 'Data tidak sah' })
  })

  test('JSON rosak → Data tidak sah', async () => {
    const res = await post(app, '{')
    expect(res.status).toBe(400)
    expect(await res.json<unknown>()).toEqual({ error: 'Data tidak sah' })
  })
})

describe('http', () => {
  const app: Hono = new Hono()
    .get('/x/:id', (c) => c.json({ id: uuidParam(c, 'id') }))
    .get('/stale', () => {
      throw new ApiError(409, 'data telah berubah', { code: 'stale_write' })
    })
    .get('/boom', () => {
      throw new Error('rahsia dalaman')
    })
    .onError(onError)

  test('uuid tidak sah → id tidak sah', async () => {
    const res = await app.request('/x/123')
    expect(res.status).toBe(400)
    expect(await res.json<unknown>()).toEqual({ error: 'id tidak sah' })
  })

  test('uuid dinormalkan huruf kecil', async () => {
    const res = await app.request('/x/0F8FAD5B-D9CB-469F-A165-70867728950E')
    expect(await res.json<unknown>()).toEqual({ id: '0f8fad5b-d9cb-469f-a165-70867728950e' })
  })

  test('ApiError membawa medan tambahan', async () => {
    const res = await app.request('/stale')
    expect(res.status).toBe(409)
    expect(await res.json<unknown>()).toEqual({ error: 'data telah berubah', code: 'stale_write' })
  })

  test('ralat tak dijangka tidak membocorkan mesej', async () => {
    const err = console.error
    console.error = () => {}
    const res = await app.request('/boom')
    console.error = err
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('rahsia')
  })
})

describe('time', () => {
  test('ms ↔ JSON, mikrosaat dipotong', () => {
    expect(toJson(0)).toBe('1970-01-01T00:00:00.000Z')
    expect(fromJson('2026-09-26T13:04:05.123456+08:00')).toBe(Date.UTC(2026, 8, 26, 5, 4, 5, 123))
    expect(fromJson('bukan masa')).toBeNull()
  })

  test('sempadan bulan MYT', () => {
    // 1 Okt 00:30 MYT = 30 Sep 16:30 UTC → sudah bulan Oktober di MYT
    const [start, end] = mytMonthRange(Date.UTC(2026, 8, 30, 16, 30))
    expect(toJson(start)).toBe('2026-09-30T16:00:00.000Z')
    expect(toJson(end)).toBe('2026-10-31T16:00:00.000Z')
    expect(mytYear(Date.UTC(2026, 11, 31, 16, 0))).toBe(2027)
  })
})

describe('db.chunk', () => {
  test('tidak pernah melebihi 100 parameter', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => i)
    for (const perRow of [1, 7, 13, 100]) {
      const parts = chunk(rows, perRow)
      expect(parts.flat()).toEqual(rows)
      for (const p of parts) expect(p.length * perRow).toBeLessThanOrEqual(D1_MAX_PARAMS)
    }
  })

  test('baris lebih lebar daripada had ditolak', () => {
    expect(() => chunk([1], 101)).toThrow(RangeError)
  })
})

describe('config', () => {
  test('JWT_SECRET wajib', () => {
    expect(() => getConfig({})).toThrow(/JWT_SECRET/)
  })

  test('lalai + senarai', () => {
    const c = getConfig({ JWT_SECRET: 'x'.repeat(32), CORS_ALLOWED_ORIGINS: 'https://a.my, ,https://b.my', REGISTRATION_FEE_CENTS: '2500' })
    expect(c.CORS_ALLOWED_ORIGINS).toEqual(['https://a.my', 'https://b.my'])
    expect(c.REGISTRATION_FEE_CENTS).toBe(2500)
    expect(c.ACCESS_TOKEN_TTL_MINUTES).toBe(15)
    expect(c.RESEND_API_KEY).toBe('')
  })
})
