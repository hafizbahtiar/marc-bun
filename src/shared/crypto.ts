// Token legap + hash. Pariti marc_go internal/auth/token.go: 32 bait rawak,
// base64url tanpa padding; DB hanya menyimpan SHA-256 hex.

export function opaqueToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Banding rahsia dalam masa tetap (panjang berbeza = false serta-merta; panjang
// rahsia bukan rahsia). Ditulis sendiri kerana crypto.subtle.timingSafeEqual
// hanya wujud dalam workerd, bukan Bun (ujian).
export function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a)
  const y = new TextEncoder().encode(b)
  if (x.length !== y.length) return false
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!
  return diff === 0
}
