// bun run db:new <feature>_<apa>
// Cipta migrasi `YYYYMMDDHHMMSS_<feature>_<apa>.sql` (masa UTC - sama zon
// dengan semua masa lain dalam projek). `wrangler d1 migrations create` hanya
// memberi max+1, bukan cap masa.
//
// <feature> mesti feature pemilik dalam docs/modules/README.md (features-first):
// setiap migrasi ada pemilik yang jelas.
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const DIR = join(ROOT, 'src/database/migrations')

export const stamp = (d: Date): string => d.toISOString().replace(/\D/g, '').slice(0, 14)

export function owners(readme: string): string[] {
  const section = readme.split('## Pemilik jadual')[1]?.split('\n## ')[0] ?? ''
  return [...section.matchAll(/^\| ([a-z-]+) \|/gm)].map((m) => m[1]!.replaceAll('-', '_'))
}

if (import.meta.main) {
  const name = process.argv[2] ?? ''
  const features = owners(await Bun.file(join(ROOT, 'docs/modules/README.md')).text())
  const feature = features.filter((f) => name === f || name.startsWith(`${f}_`)).sort((a, b) => b.length - a.length)[0]

  if (!/^[a-z0-9_]+$/.test(name) || !feature) {
    console.error(`Guna: bun run db:new <feature>_<apa>   (cth: posts_add_pinned)\nFeature: ${features.join(', ')}`)
    process.exit(1)
  }

  const ts = stamp(new Date())
  if (readdirSync(DIR).some((f) => f.startsWith(ts))) {
    console.error(`Migrasi dengan cap masa ${ts} sudah wujud - cuba lagi sesaat kemudian.`)
    process.exit(1)
  }
  const file = join(DIR, `${ts}_${name}.sql`)
  if (existsSync(file)) process.exit(1)

  await Bun.write(
    file,
    `-- Pemilik: features/${feature.replaceAll('_', '-')}
--
-- Kenapa: <satu ayat - apa yang berubah dan sebabnya>
--
-- Forward-only. Expand → deploy → contract (docs/00002-tooling.md §2).
-- Jadual baharu: STRICT + tambah ke peta pemilik docs/modules/README.md.

`,
  )
  console.log(`✓ ${file.slice(ROOT.length + 1)}`)
}
