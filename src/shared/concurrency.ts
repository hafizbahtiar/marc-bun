// Kunci optimistik melalui updated_at (pariti marc_go handlers/concurrency.go).
// Tulis = `UPDATE … WHERE id = ? AND updated_at = ?`; 0 baris = lapuk → 409.
import { ApiError } from './http'
import { fromJson } from './time'

export function expectedUpdatedAt(raw: string): number {
  if (!raw.trim()) throw new ApiError(400, 'updated_at diperlukan untuk mengelakkan perubahan lapuk')
  const ms = fromJson(raw.trim())
  if (ms === null) throw new ApiError(400, 'updated_at tidak sah')
  return ms
}

export const staleWrite = (message: string) => new ApiError(409, message, { code: 'stale_write' })
