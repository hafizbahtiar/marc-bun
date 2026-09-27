// Peraturan tulen (tiada DB) - diuji terus dalam members.test.ts.
import type { RoleRow } from './repo'

export const MANAGEMENT = 'management'
export const SUPERADMIN = 'superadmin'

// Rank TERTINGGI yang boleh dilihat: semua orang sehingga SATU tingkat di atas
// rank sendiri, kecuali rank tertinggi (superadmin) yang hanya dilihat oleh
// rank tertinggi. Dikira dari jadual roles, bukan hardcode.
//   ahli 10 → 50 · supervisor 50 → 60 · manager 60 → 60 · admin 80 → 80 · superadmin 100 → 100
export function visibleRankCeiling(roles: Pick<RoleRow, 'rank'>[], viewerRank: number): number {
  const top = Math.max(...roles.map((r) => r.rank))
  if (viewerRank >= top) return top
  let ceiling = viewerRank
  for (const r of roles) {
    if (r.rank > viewerRank && r.rank < top && (ceiling === viewerRank || r.rank < ceiling)) ceiling = r.rank
  }
  return ceiling
}

// {kod} member_id + kunci jujukan (null = tiada nombor, cth superadmin).
export function memberIdCode(roleKey: string): { prefix: string; sequenceKey: string | null; pad: number } {
  if (roleKey === SUPERADMIN) return { prefix: 'SA', sequenceKey: null, pad: 0 }
  if (roleKey === 'tester') return { prefix: 'T', sequenceKey: 'member_seq:tester', pad: 0 }
  return { prefix: '', sequenceKey: 'member_seq:ahli', pad: 4 }
}

// MARC-{staff_id}/{tahun MYT}-{kod}
export const formatMemberId = (staffId: string, year: number, code: string) => `MARC-${staffId}/${year}-${code}`

export const codeFor = (roleKey: string, seq: number | null) => {
  const c = memberIdCode(roleKey)
  return c.sequenceKey === null ? c.prefix : `${c.prefix}${String(seq).padStart(c.pad, '0')}`
}
