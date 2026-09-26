// bun run secrets:check - bandingkan konfigurasi produksi dengan schema
// src/shared/config.ts. Rahsia yang hilang = ciri mati senyap (docs/00000 §4),
// jadi senaraikan semuanya sebelum deploy. Exit 1 hanya untuk yang WAJIB.
import { CONFIG_KEYS } from '../src/shared/config'
import { wranglerVars } from './secrets-lib'

const REQUIRED = new Set(['JWT_SECRET'])
const vars = await wranglerVars()

const proc = Bun.spawnSync(['bunx', 'wrangler', 'secret', 'list', '--format', 'json'])
if (proc.exitCode !== 0) {
  console.error(`wrangler secret list gagal (log masuk? \`bunx wrangler login\`):\n${proc.stderr.toString()}`)
  process.exit(1)
}
const start = proc.stdout.toString().indexOf('[')
const secrets = new Set((JSON.parse(proc.stdout.toString().slice(start)) as { name: string }[]).map((s) => s.name))

const rows = CONFIG_KEYS.map((key) => {
  const status = secrets.has(key) ? 'secret' : (vars[key] ?? '') !== '' ? 'var' : 'KOSONG'
  return { key, status, required: REQUIRED.has(key) }
})

for (const r of rows) console.log(`${r.status === 'KOSONG' ? (r.required ? '✘' : '·') : '✓'} ${r.key.padEnd(34)} ${r.status}`)

const missing = rows.filter((r) => r.required && r.status === 'KOSONG')
const off = rows.filter((r) => !r.required && r.status === 'KOSONG')
console.log(`\n${off.length} kosong (ciri berkenaan mati - pastikan disengajakan).`)
if (missing.length) {
  console.error(`WAJIB tiada: ${missing.map((r) => r.key).join(', ')} → isi .env, \`bun run secrets:push\``)
  process.exit(1)
}
