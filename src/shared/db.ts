// Had D1: 100 parameter terikat setiap statement (docs/00000-foundation.md §9).
export const D1_MAX_PARAMS = 100

export const uuid = (): string => crypto.randomUUID()

// Pecah baris supaya setiap statement ≤ D1_MAX_PARAMS parameter.
export function chunk<T>(rows: readonly T[], paramsPerRow: number): T[][] {
  if (paramsPerRow < 1 || paramsPerRow > D1_MAX_PARAMS) throw new RangeError(`paramsPerRow ${paramsPerRow}`)
  const size = Math.floor(D1_MAX_PARAMS / paramsPerRow)
  const out: T[][] = []
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size))
  return out
}

// `?, ?, ?` untuk klausa IN / VALUES.
export const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ')

// D1 simpan boolean sebagai 0/1.
export const bool = (v: unknown): boolean => v === 1 || v === true
