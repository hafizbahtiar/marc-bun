// Kursor keyset legap "<ISO>|<uuid>" (pariti format marc_go; klien tidak menghurainya).
import { toJson } from './time'

export const encodeCursor = (createdAt: number, id: string) => `${toJson(createdAt)}|${id}`

export function decodeCursor(s: string): { createdAt: number; id: string } | null {
  const i = s.lastIndexOf('|')
  if (i < 0) return null
  const createdAt = Date.parse(s.slice(0, i))
  const id = s.slice(i + 1)
  return Number.isNaN(createdAt) || !/^[0-9a-f-]{36}$/i.test(id) ? null : { createdAt, id: id.toLowerCase() }
}

// `limit` pertanyaan: 1..100, selainnya lalai (marc_go mengabaikan nilai buruk).
export function pageLimit(raw: string | undefined, fallback = 20): number {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 && n <= 100 ? n : fallback
}
