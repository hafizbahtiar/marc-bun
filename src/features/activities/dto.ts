// Pariti bentuk sqlc marc_go (Activity/GetActivityByIDRow/ActivitySession/ActivityCategory).
import { toJson, toJsonNullable } from '../../shared/time'
import type { ActivityRow, Category, SessionRow } from './repo'

export const categoryDto = (c: Category) => ({
  id: c.id,
  key: c.key,
  name: c.name,
  sort_order: c.sort_order,
  is_active: c.is_active === 1,
  created_at: toJson(c.created_at),
  updated_at: toJson(c.updated_at),
})

export const sessionDto = (s: SessionRow) => ({ id: s.id, activity_id: s.activity_id, seq: s.seq, title: s.title, starts_at: toJson(s.starts_at), ends_at: toJson(s.ends_at) })

export const activityDto = (a: ActivityRow) => ({
  id: a.id,
  category_id: a.category_id,
  title: a.title,
  description: a.description,
  location_name: a.location_name,
  location_address: a.location_address,
  starts_at: toJson(a.starts_at),
  ends_at: toJson(a.ends_at),
  registration_opens_at: toJsonNullable(a.registration_opens_at),
  registration_closes_at: toJson(a.registration_closes_at),
  capacity: a.capacity,
  fee_cents: a.fee_cents,
  currency: a.currency,
  attendance_threshold_pct: a.attendance_threshold_pct,
  status: a.status,
  cancelled_reason: a.cancelled_reason,
  certificates_issued_at: toJsonNullable(a.certificates_issued_at),
  created_by: a.created_by,
  created_at: toJson(a.created_at),
  updated_at: toJson(a.updated_at),
  deleted_at: toJsonNullable(a.deleted_at),
  reminder_sent_at: toJsonNullable(a.reminder_sent_at),
  category_key: a.category_key,
  category_name: a.category_name,
})

// Snapshot audit (pariti activitySnapshot marc_go).
export function activitySnapshot(a: ActivityRow) {
  const snap: Record<string, unknown> = {
    category_id: a.category_id,
    title: a.title,
    description: a.description,
    location_name: a.location_name,
    location_address: a.location_address,
    starts_at: toJson(a.starts_at),
    ends_at: toJson(a.ends_at),
    registration_closes_at: toJson(a.registration_closes_at),
    fee_cents: a.fee_cents,
    attendance_threshold_pct: a.attendance_threshold_pct,
    status: a.status,
  }
  if (a.registration_opens_at !== null) snap.registration_opens_at = toJson(a.registration_opens_at)
  if (a.capacity !== null) snap.capacity = a.capacity
  if (a.cancelled_reason !== null) snap.cancelled_reason = a.cancelled_reason
  return snap
}

export const sessionsSnapshot = (list: { seq: number; title: string; starts_at: number; ends_at: number }[]) =>
  list.map((s) => ({ seq: s.seq, title: s.title, starts_at: toJson(s.starts_at), ends_at: toJson(s.ends_at) }))
