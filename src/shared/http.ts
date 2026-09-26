import type { Context, ErrorHandler, NotFoundHandler } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'

// Mesej lalai untuk setiap isu Zod yang tiada mesej sendiri - padan
// `friendlyBindError` marc_go (handlers/bind.go). Mesej khusus medan
// ditetapkan dalam schema: z.email({ error: 'Format email tidak sah' }).
z.config({ customError: () => INVALID_DATA })

export const INVALID_DATA = 'Data tidak sah'
export const INVALID_ID = 'id tidak sah'

// Ralat yang dijangka. Dilempar dari mana-mana lapisan; `onError` menukarnya
// kepada envelope `{"error": …}` marc_go. `extra` untuk medan tambahan
// seperti `code: "stale_write"`.
export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message)
  }
}

// Body JSON → data bersih. Medan tak dikenali DIBUANG (strip, bukan strict):
// Gin mengabaikannya, dan klien lama mesti terus berfungsi.
// Hanya isu pertama dilaporkan, seperti marc_go.
export async function parseBody<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    throw new ApiError(400, INVALID_DATA)
  }
  const result = schema.safeParse(raw)
  if (!result.success) throw new ApiError(400, result.error.issues[0]?.message ?? INVALID_DATA)
  return result.data
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function uuidParam(c: Context, name: string): string {
  const value = c.req.param(name) ?? ''
  if (!UUID.test(value)) throw new ApiError(400, INVALID_ID)
  return value.toLowerCase()
}

export const onError: ErrorHandler = (err, c) => {
  if (err instanceof ApiError) return c.json({ error: err.message, ...err.extra }, err.status)
  console.error(JSON.stringify({ level: 'error', request_id: c.get('requestId'), error: String(err), stack: err.stack }))
  return c.json({ error: 'ralat dalaman' }, 500)
}

// Pariti Gin: laluan tidak wujud = teks biasa, bukan JSON.
export const notFound: NotFoundHandler = (c) => c.text('404 page not found', 404)
