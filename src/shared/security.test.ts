// Port ujian tulen marc_go (phone_test.go, disposableemail_test.go) + jwt,
// crypto, dan senarai tolak KV.
import { describe, expect, test } from 'bun:test'
import { SignJWT } from 'jose'
import { opaqueToken, safeEqual, sha256Hex } from './crypto'
import { domainOf, isDisposable } from './disposable-email'
import { signAccess, verifyAccess } from './jwt'
import { normalizeMY } from './phone'
import { rejection, revokeSessions, revokeUser, setBan } from './revocation'

describe('phone.normalizeMY (phone_test.go)', () => {
  test.each([
    ['0123456789', '0123456789'],
    ['012-345 6789', '0123456789'],
    ['+60123456789', '0123456789'],
    ['60123456789', '0123456789'],
    ['01112345678', '01112345678'],
    ['+601112345678', '01112345678'],
  ])('sah: %s', (input, want) => expect(normalizeMY(input)).toBe(want))

  test.each(['', '123456789', '0151234567', '012345', '0123456789012', 'abcdefghij', '03-12345678', '0111234567'])(
    'ditolak: %s',
    (input) => expect(normalizeMY(input)).toBeNull(),
  )
})

describe('disposable-email (disposableemail_test.go)', () => {
  test.each([
    ['someone@yopmail.com', true],
    ['someone@mailinator.com', true],
    ['someone@gmail.com', false],
    ['someone@hafizbahtiar98gmail.com', false],
    ['google@yopmail.com', false],
    ['apple@yopmail.com', false],
    ['randomperson@yopmail.com', true],
  ])('%s → %p', (email, want) => expect(isDisposable(email)).toBe(want))

  test.each([
    ['someone@yopmail.com', 'yopmail.com'],
    ['SOMEONE@YOPMAIL.COM', 'yopmail.com'],
    ['invalid-email', ''],
    ['trailing@', ''],
  ])('domainOf(%s)', (email, want) => expect(domainOf(email)).toBe(want))
})

describe('crypto', () => {
  test('token legap: 43 aksara base64url, unik', () => {
    const a = opaqueToken()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(opaqueToken()).not.toBe(a)
  })

  test('sha256 hex (vektor diketahui)', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  test('safeEqual', () => {
    expect(safeEqual('rahsia', 'rahsia')).toBe(true)
    expect(safeEqual('rahsia', 'rahsiA')).toBe(false)
    expect(safeEqual('rahsia', 'rahsia!')).toBe(false)
  })
})

describe('jwt', () => {
  const secret = 'x'.repeat(40)

  test('pusingan: sub + sid + iat', async () => {
    const claims = await verifyAccess(secret, await signAccess(secret, 15, 'u1', 's1'))
    expect(claims).toMatchObject({ userId: 'u1', sessionId: 's1' })
    expect(Math.abs(claims!.issuedAtMs - Date.now())).toBeLessThan(5000)
  })

  test('token marc_go lama tanpa sid kekal sah', async () => {
    const token = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject('u1').setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(secret))
    expect(await verifyAccess(secret, token)).toMatchObject({ userId: 'u1', sessionId: null })
  })

  test('rahsia salah / tamat / HS512 ditolak', async () => {
    expect(await verifyAccess('y'.repeat(40), await signAccess(secret, 15, 'u1', 's1'))).toBeNull()
    const expired = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject('u1').setExpirationTime(Math.floor(Date.now() / 1000) - 10).sign(new TextEncoder().encode(secret))
    expect(await verifyAccess(secret, expired)).toBeNull()
    const hs512 = await new SignJWT({}).setProtectedHeader({ alg: 'HS512' }).setSubject('u1').setExpirationTime('5m').sign(new TextEncoder().encode(secret))
    expect(await verifyAccess(secret, hs512)).toBeNull()
  })
})

describe('revocation (KV palsu)', () => {
  const fakeKv = () => {
    const m = new Map<string, string>()
    return {
      m,
      kv: {
        put: async (k: string, v: string) => void m.set(k, v),
        delete: async (k: string) => void m.delete(k),
        get: async (keys: string[]) => new Map(keys.map((k) => [k, m.get(k) ?? null])),
      } as unknown as KVNamespace,
    }
  }
  const now = Date.now()
  const claims = { userId: 'u1', sessionId: 's1', issuedAtMs: now - 100 }

  test('tiada kunci = lulus', async () => {
    expect(await rejection(fakeKv().kv, claims)).toBeNull()
  })

  test('sesi dibatalkan', async () => {
    const { kv } = fakeKv()
    await revokeSessions(kv, ['s1'], 15)
    expect(await rejection(kv, claims)).toBe('revoked')
    expect(await rejection(kv, { ...claims, sessionId: 's2' })).toBeNull()
  })

  test('logout-all: token pada/sebelum cutoff (ms) ditolak, selepasnya lulus', async () => {
    const { kv } = fakeKv()
    await revokeUser(kv, 'u1', 15, now)
    expect(await rejection(kv, claims)).toBe('revoked')
    expect(await rejection(kv, { ...claims, issuedAtMs: now })).toBe('revoked')
    expect(await rejection(kv, { ...claims, issuedAtMs: now + 1 })).toBeNull()
  })

  test('token marc_go lama (iat saat) dalam saat yang sama → ditolak', async () => {
    const { kv } = fakeKv()
    const second = Math.floor(now / 1000) * 1000
    await revokeUser(kv, 'u1', 15, second + 500)
    expect(await rejection(kv, { ...claims, issuedAtMs: second })).toBe('revoked')
  })

  test('ban mengatasi semua; ban tamat di masa lalu = padam', async () => {
    const { kv, m } = fakeKv()
    await setBan(kv, 'u1', null, now)
    expect(await rejection(kv, claims)).toBe('banned')
    await setBan(kv, 'u1', now - 1000, now)
    expect(m.has('ban:u1')).toBe(false)
  })
})
