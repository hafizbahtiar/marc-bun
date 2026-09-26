// Access token HS256 - pariti marc_go internal/auth/jwt.go: `sub` = user id,
// `sid` = family_id refresh (pilihan - token lama tanpa sid kekal sah),
// `iat`, `exp`. JWT_SECRET sama dengan marc_go → token sedia ada kekal sah.
import { jwtVerify, SignJWT } from 'jose'

// issuedAtMs: dari claim `iat_ms` (token marc_bun). Token marc_go lama hanya ada
// `iat` (saat) - dianggap dikeluarkan pada AWAL saat itu, jadi pembatalan dalam
// saat yang sama tetap menolaknya (konservatif).
export type AccessClaims = { userId: string; sessionId: string | null; issuedAtMs: number }

const key = (secret: string) => new TextEncoder().encode(secret)

export async function signAccess(secret: string, ttlMinutes: number, userId: string, sessionId: string): Promise<string> {
  return new SignJWT({ sid: sessionId, iat_ms: Date.now() })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${ttlMinutes}m`)
    .sign(key(secret))
}

// null = tidak sah (tandatangan, tamat, algoritma, atau bentuk). Algoritma
// DIPIN - `alg: none`/RS256 ditolak.
export async function verifyAccess(secret: string, token: string): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: ['HS256'] })
    if (typeof payload.sub !== 'string' || !payload.sub) return null
    const sid = typeof payload.sid === 'string' && payload.sid ? payload.sid : null
    const iatMs = typeof payload.iat_ms === 'number' ? payload.iat_ms : (payload.iat ?? 0) * 1000
    return { userId: payload.sub, sessionId: sid, issuedAtMs: iatMs }
  } catch {
    return null
  }
}
