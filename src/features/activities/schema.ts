// Pariti binding marc_go handlers/activities.go. Ralat bind = `Data tidak sah`
// (lalai shared/http); mesej khusus datang daripada service.
import { z } from 'zod'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// time.Time Go = RFC3339 ketat.
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

const runes = (max: number) => z.string().refine((s) => [...s].length <= max)
const time = z
  .string()
  .regex(RFC3339)
  .transform((s) => Date.parse(s))
  .refine((n) => !Number.isNaN(n))
const id = z.string().regex(UUID).transform((s) => s.toLowerCase())
const int32 = z.number().int().min(-(2 ** 31)).max(2 ** 31 - 1)
const int16 = z.number().int().min(-32768).max(32767)
// `required` Go: nilai sifar ditolak.
const required = z.string().min(1)

export const session = z.object({
  seq: int32.min(1),
  title: runes(200).default(''),
  starts_at: time,
  ends_at: time,
})
export type SessionInput = z.infer<typeof session>

export const sessions = z.object({ sessions: z.array(session).min(1) })

export const createActivity = z.object({
  category_id: id,
  title: required.pipe(runes(200)),
  description: runes(2000).default(''),
  location_name: required.pipe(runes(300)),
  location_address: runes(500).default(''),
  registration_opens_at: time.nullish(),
  registration_closes_at: time,
  capacity: int32.nullish(),
  fee_cents: int32.default(0),
  attendance_threshold_pct: int16.default(0),
  sessions: z.array(session).min(1),
})
export type CreateActivity = z.infer<typeof createActivity>

// PATCH: tiada = kekal; null = "kosongkan" (lajur nullable) atau ralat (NOT NULL).
export const updateActivity = z.object({
  category_id: id.nullish(),
  title: z.string().nullish(),
  description: z.string().nullish(),
  location_name: z.string().nullish(),
  location_address: z.string().nullish(),
  registration_opens_at: time.nullish(),
  registration_closes_at: time.nullish(),
  capacity: int32.nullish(),
  fee_cents: int32.nullish(),
  attendance_threshold_pct: int16.nullish(),
})
export type UpdateActivity = z.infer<typeof updateActivity>

export const cancel = z.object({ reason: required.pipe(runes(500)) })

export const createCategory = z.object({ key: required, name: required, sort_order: int32.default(0) })
export const updateCategory = z.object({ name: z.string().nullish(), sort_order: int32.nullish(), is_active: z.boolean().nullish(), updated_at: required })
