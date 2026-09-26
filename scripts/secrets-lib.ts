// Dikongsi oleh secrets-check.ts dan secrets-push.ts. Logik tulen - diuji
// dalam secrets.test.ts.
import { CONFIG_KEYS } from '../src/shared/config'

// wrangler.jsonc: buang komen baris penuh sahaja (URL dalam string mengandungi //).
export async function wranglerVars(): Promise<Record<string, string>> {
  const text = await Bun.file(new URL('../wrangler.jsonc', import.meta.url)).text()
  return (JSON.parse(text.replace(/^\s*\/\/.*$/gm, '')) as { vars?: Record<string, string> }).vars ?? {}
}

// Rahsia = kunci config yang BUKAN var dalam wrangler.jsonc. Satu nama tidak
// boleh jadi kedua-duanya (wrangler deploy menolak pertembungan itu).
export const secretKeys = (vars: Record<string, string>): string[] => CONFIG_KEYS.filter((k) => !(k in vars))

// KEY=VALUE, komen `#`, baris kosong, petikan '…' / "…" dibuang.
export function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (!m) throw new Error(`baris tidak sah: ${line.split('=')[0]}`) // jangan cetak nilai
    out.set(m[1]!, m[2]!.replace(/^(['"])(.*)\1$/, '$2'))
  }
  return out
}

export type SecretPlan = { push: Record<string, string>; skipped: string[]; errors: string[] }

export function planSecrets(entries: Map<string, string>, secrets: string[], vars: Record<string, string>): SecretPlan {
  const plan: SecretPlan = { push: {}, skipped: [], errors: [] }
  for (const [key, value] of entries) {
    // Tindihan lokal (.env.dev); produksi sentiasa `production` (wrangler.jsonc).
    if (key === 'ENVIRONMENT') plan.skipped.push(key)
    else if (key in vars) plan.errors.push(`${key} ialah var dalam wrangler.jsonc, bukan rahsia - set di sana`)
    else if (!secrets.includes(key)) plan.errors.push(`${key} tidak dikenali (salah eja? lihat src/shared/config.ts)`)
    else if (value === '') plan.skipped.push(key)
    else if (key === 'JWT_SECRET' && value.length < 32) plan.errors.push('JWT_SECRET mesti sekurang-kurangnya 32 aksara')
    else plan.push[key] = value
  }
  return plan
}
