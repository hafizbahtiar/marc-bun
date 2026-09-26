// Senarai tolak KV untuk access token (docs/modules/00-shared.md). Ditulis
// hanya semasa pembatalan; dibaca oleh requireAuth di edge tanpa menyentuh D1.
// D1 kekal sumber kebenaran pada /auth/refresh.
//
// Kunci hanya perlu hidup selagi access token yang terjejas boleh hidup
// (TTL access + 60 s), kecuali ban yang tamat mengikut ban_expires_at.
import type { AccessClaims } from './jwt'

const KV_MIN_TTL = 60

const sidKey = (sid: string) => `rv:sid:${sid}`
const userKey = (userId: string) => `rv:user:${userId}`
const banKey = (userId: string) => `ban:${userId}`

const ttl = (accessTtlMinutes: number) => Math.max(KV_MIN_TTL, accessTtlMinutes * 60 + 60)

export async function revokeSessions(kv: KVNamespace, sessionIds: string[], accessTtlMinutes: number): Promise<void> {
  await Promise.all([...new Set(sessionIds)].map((sid) => kv.put(sidKey(sid), '1', { expirationTtl: ttl(accessTtlMinutes) })))
}

// Semua token ahli yang dikeluarkan pada atau sebelum `nowMs` ditolak. Ketepatan
// milisaat (claim iat_ms): token yang dikeluarkan sesaat sebelum logout-all
// TIDAK terlepas, dan log masuk semula selepasnya kekal sah.
export async function revokeUser(kv: KVNamespace, userId: string, accessTtlMinutes: number, nowMs: number): Promise<void> {
  await kv.put(userKey(userId), String(nowMs), { expirationTtl: ttl(accessTtlMinutes) })
}

// expiresAtMs null = ban kekal.
export async function setBan(kv: KVNamespace, userId: string, expiresAtMs: number | null, nowMs: number): Promise<void> {
  if (expiresAtMs === null) return kv.put(banKey(userId), '1')
  const seconds = Math.ceil((expiresAtMs - nowMs) / 1000)
  if (seconds <= 0) return kv.delete(banKey(userId))
  await kv.put(banKey(userId), '1', { expirationTtl: Math.max(KV_MIN_TTL, seconds) })
}

export const clearBan = (kv: KVNamespace, userId: string): Promise<void> => kv.delete(banKey(userId))

export type Rejection = 'revoked' | 'banned' | null

export async function rejection(kv: KVNamespace, claims: AccessClaims): Promise<Rejection> {
  const keys = [userKey(claims.userId), banKey(claims.userId)]
  if (claims.sessionId) keys.push(sidKey(claims.sessionId))
  const got = await kv.get(keys)
  if (got.get(banKey(claims.userId))) return 'banned'
  if (claims.sessionId && got.get(sidKey(claims.sessionId))) return 'revoked'
  const cutoff = got.get(userKey(claims.userId))
  if (cutoff && claims.issuedAtMs <= Number(cutoff)) return 'revoked'
  return null
}
