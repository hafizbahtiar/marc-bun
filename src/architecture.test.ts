// Menguatkuasakan docs/00000-foundation.md §5.2. Ujian ini gagal = reka bentuk
// salah, bukan ujian salah. Peta pemilik jadual dibaca TERUS dari
// docs/modules/README.md supaya dokumen dan kod tidak boleh terpesong.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const SRC = join(ROOT, 'src')

const files = (readdirSync(SRC, { recursive: true }) as string[])
  .filter((f) => f.endsWith('.ts'))
  .map((f) => join(SRC, f))

// features/<nama> atau features/<nama>/… → nama
const featureOf = (abs: string): string | null => relative(SRC, abs).match(/^features\/([^/]+)(?:\/|$)/)?.[1] ?? null

function imports(abs: string): string[] {
  const src = readFileSync(abs, 'utf8')
  const specs = [...src.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) => m[1]!)
  return specs.map((s) => resolve(dirname(abs), s).replace(/\.ts$/, ''))
}

const edges = files.flatMap((from) => imports(from).map((to) => ({ from, to })))

describe('sempadan feature', () => {
  test('feature lain hanya diimport melalui index.ts', () => {
    const bad = edges.filter(({ from, to }) => {
      const target = featureOf(to)
      if (!target || featureOf(from) === target) return false
      return !/^features\/[^/]+(\/index)?$/.test(relative(SRC, to))
    })
    expect(bad.map((e) => `${relative(SRC, e.from)} → ${relative(SRC, e.to)}`)).toEqual([])
  })

  test('shared/ tidak mengimport features/', () => {
    const bad = edges.filter(({ from, to }) => relative(SRC, from).startsWith('shared/') && relative(SRC, to).startsWith('features/'))
    expect(bad.map((e) => relative(SRC, e.from))).toEqual([])
  })

  test('graf feature asiklik', () => {
    const graph = new Map<string, Set<string>>()
    for (const { from, to } of edges) {
      const a = featureOf(from)
      const b = featureOf(to)
      if (a && b && a !== b) graph.set(a, (graph.get(a) ?? new Set()).add(b))
    }
    const state = new Map<string, 'visiting' | 'done'>()
    const cycles: string[] = []
    const visit = (n: string, path: string[]) => {
      if (state.get(n) === 'done') return
      if (state.get(n) === 'visiting') return void cycles.push([...path, n].join(' → '))
      state.set(n, 'visiting')
      for (const m of graph.get(n) ?? []) visit(m, [...path, n])
      state.set(n, 'done')
    }
    for (const n of graph.keys()) visit(n, [])
    expect(cycles).toEqual([])
  })
})

describe('pemilik jadual', () => {
  // Jadual "Pemilik jadual" dalam docs/modules/README.md: | feature | `a`, `b` |
  const doc = readFileSync(join(ROOT, 'docs/modules/README.md'), 'utf8')
  const section = doc.split('## Pemilik jadual')[1]?.split('\n## ')[0] ?? ''
  const owner = new Map<string, string>()
  for (const line of section.split('\n')) {
    const m = line.match(/^\| ([a-z-]+) \| (.+) \|$/)
    if (!m) continue
    for (const t of m[2]!.matchAll(/`([a-z_]+)`/g)) owner.set(t[1]!, m[1]!)
  }

  test('peta pemilik boleh dibaca dari dokumen (36 jadual)', () => {
    expect(owner.size).toBe(36)
  })

  test('repo.ts hanya menulis jadual miliknya', () => {
    const bad: string[] = []
    for (const f of files.filter((f) => f.endsWith('/repo.ts'))) {
      const feature = featureOf(f)
      const sql = readFileSync(f, 'utf8')
      for (const m of sql.matchAll(/\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|(?<!DO\s+)UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+([a-z_]+)/gi)) {
        const table = m[1]!.toLowerCase()
        if (owner.get(table) !== feature) bad.push(`${relative(SRC, f)} menulis ${table} (pemilik: ${owner.get(table) ?? 'tiada'})`)
      }
    }
    expect(bad).toEqual([])
  })
})
