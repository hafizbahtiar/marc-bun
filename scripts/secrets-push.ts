// bun run secrets:push [--dry-run]
// Tolak semua rahsia dalam .env ke Worker PRODUKSI dalam satu
// permintaan (`wrangler secret bulk`). Nilai dihantar melalui stdin - tiada
// fail sementara, tiada nilai dicetak. Lokal guna .env.dev, bukan fail ini.
import { parseEnv, planSecrets, secretKeys, wranglerVars } from './secrets-lib'

const FILE = '.env'
const dryRun = process.argv.includes('--dry-run')

const file = Bun.file(new URL(`../${FILE}`, import.meta.url))
if (!(await file.exists())) {
  console.error(`${FILE} tiada. Salin .env.example → ${FILE} dan isi nilai PRODUKSI.`)
  process.exit(1)
}

const vars = await wranglerVars()
const plan = planSecrets(parseEnv(await file.text()), secretKeys(vars), vars)

if (plan.errors.length) {
  for (const e of plan.errors) console.error(`✘ ${e}`)
  process.exit(1)
}

const keys = Object.keys(plan.push)
for (const k of keys) console.log(`↑ ${k}`)
for (const k of plan.skipped) console.log(`· ${k} (kosong - dilangkau, nilai remote tidak disentuh)`)

if (keys.length === 0) {
  console.log('Tiada rahsia untuk ditolak.')
  process.exit(0)
}
if (dryRun) {
  console.log(`\n--dry-run: ${keys.length} rahsia akan ditolak ke produksi. Tiada apa dihantar.`)
  process.exit(0)
}

const push = Bun.spawnSync(['bunx', 'wrangler', 'secret', 'bulk'], {
  stdin: new TextEncoder().encode(JSON.stringify(plan.push)),
  stdout: 'inherit',
  stderr: 'inherit',
})
if (push.exitCode !== 0) process.exit(push.exitCode ?? 1)

console.log('\nSemak keseluruhan:')
const check = Bun.spawnSync(['bun', 'scripts/secrets-check.ts'], { stdout: 'inherit', stderr: 'inherit' })
process.exit(check.exitCode ?? 1)
