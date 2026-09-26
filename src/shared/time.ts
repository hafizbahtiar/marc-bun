// Satu-satunya tempat masa ditukar format. DB = INTEGER unix ms UTC.

export const now = (): number => Date.now()

export const toJson = (ms: number): string => new Date(ms).toISOString()

export const toJsonNullable = (ms: number | null): string | null => (ms === null ? null : toJson(ms))

// RFC3339 dari klien → ms. Dipotong ke ms: nilai marc_go (mikrosaat) masih
// padan dengan `updated_at` yang disimpan semasa cutover. NaN = null.
export function fromJson(value: string): number | null {
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

const MYT_OFFSET_MS = 8 * 60 * 60 * 1000 // Malaysia tiada DST

// Julat [mula, tamat) bulan kalendar MYT yang mengandungi `at`, dalam ms UTC.
export function mytMonthRange(at: number): [number, number] {
  const myt = new Date(at + MYT_OFFSET_MS)
  const start = Date.UTC(myt.getUTCFullYear(), myt.getUTCMonth(), 1) - MYT_OFFSET_MS
  const end = Date.UTC(myt.getUTCFullYear(), myt.getUTCMonth() + 1, 1) - MYT_OFFSET_MS
  return [start, end]
}

export const mytYear = (at: number): number => new Date(at + MYT_OFFSET_MS).getUTCFullYear()
