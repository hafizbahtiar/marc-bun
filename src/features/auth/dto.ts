import { toJson } from '../../shared/time'
import type { SessionRow } from './repo'

// Satu sesi = satu keluarga refresh (satu peranti), bukan satu baris token.
// created_at = log masuk asal; expires_at = token termuda; metadata peranti
// dari baris paling awal. Susunan: log masuk terbaharu dahulu.
export function sessionsDto(rows: SessionRow[], currentFamily: string | null) {
  const byFamily = new Map<string, { first: SessionRow; expiresAt: number }>()
  for (const r of rows) {
    const a = byFamily.get(r.family_id)
    if (!a) byFamily.set(r.family_id, { first: r, expiresAt: r.expires_at })
    else {
      if (r.created_at < a.first.created_at) a.first = r
      if (r.expires_at > a.expiresAt) a.expiresAt = r.expires_at
    }
  }
  return [...byFamily.values()]
    .sort((x, y) => y.first.created_at - x.first.created_at)
    .map(({ first, expiresAt }) => ({
      id: first.family_id,
      user_agent: first.user_agent,
      created_ip: first.created_ip,
      created_at: toJson(first.created_at),
      expires_at: toJson(expiresAt),
      is_current: currentFamily !== null && first.family_id === currentFamily,
    }))
}
