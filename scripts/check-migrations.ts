// bun scripts/check-migrations.ts <base-ref>   (CI, pada PR)
// 1. Fail migrasi yang sudah ada di <base> tidak boleh diubah/dipadam/dinamakan semula.
// 2. Migrasi baharu mesti lebih baharu daripada migrasi terkini di <base> -
//    kalau tidak (cawangan lama), ia akan dijalankan di luar urutan di produksi.
//    Jana semula dengan `bun run db:new` selepas rebase.
// 3. Nama: YYYYMMDDHHMMSS_<snake_case>.sql.
const DIR = 'src/database/migrations'
const git = (...args: string[]) => {
  const p = Bun.spawnSync(['git', ...args])
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`)
  return p.stdout.toString().split('\n').filter(Boolean)
}

export function problems(changed: string[], added: string[], baseFiles: string[]): string[] {
  const out = changed.map((f) => `diubah/dipadam: ${f} - tulis migrasi baharu`)
  const latest = baseFiles.map((f) => f.split('/').pop()!).sort().at(-1) ?? ''
  for (const f of added.map((a) => a.split('/').pop()!)) {
    if (!/^\d{14}_[a-z0-9_]+\.sql$/.test(f)) out.push(`nama tidak sah: ${f} - guna bun run db:new`)
    else if (f <= latest) out.push(`di luar urutan: ${f} <= ${latest} - jana semula dengan bun run db:new`)
  }
  return out
}

if (import.meta.main) {
  const base = process.argv[2]
  if (!base) throw new Error('Guna: bun scripts/check-migrations.ts <base-ref>')
  const out = problems(
    git('diff', '--diff-filter=MDR', '--name-only', `${base}...HEAD`, '--', DIR),
    git('diff', '--diff-filter=A', '--name-only', `${base}...HEAD`, '--', DIR),
    git('ls-tree', '--name-only', base, `${DIR}/`).filter((f) => f.endsWith('.sql')),
  )
  for (const p of out) console.error(`✘ ${p}`)
  if (out.length) process.exit(1)
  console.log('✓ migrasi')
}
