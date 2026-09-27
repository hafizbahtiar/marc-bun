// Baris → JSON eksplisit (pariti struct respons marc_go). Tiada spread.
import { toJson, toJsonNullable } from '../../shared/time'
import type { AddressRow, MemberRow } from './repo'

export function meDto(r: MemberRow, avatarUrl: string | null, feeCents: number) {
  const pending = r.status !== 'approved'
  return {
    member_id: r.member_id,
    email: r.email,
    email_verified: r.email_verified === 1,
    status: r.status,
    display_name: r.display_name,
    phone: r.phone,
    role_key: r.role_key,
    role_name: r.role_name,
    category: r.role_category,
    role_rank: r.role_rank,
    avatar_url: avatarUrl,
    // Hanya untuk ahli belum diluluskan (sudah lepas gate = tak relevan).
    registration_payment_status: pending ? r.registration_payment_status : null,
    registration_fee_cents: pending ? feeCents : null,
    telegram_linked: r.telegram_chat_id !== null,
    telegram_username: r.telegram_username,
    emergency_contact_name: r.emergency_contact_name,
    emergency_contact_phone: r.emergency_contact_phone,
    health_notes: r.health_notes,
    is_active: r.is_active === 1,
    department_code: r.department_code,
    department_name: r.department_name,
    position: r.position,
    staff_id: r.staff_id,
    staff_id_verified_at: toJsonNullable(r.staff_id_verified_at),
    updated_at: toJson(r.updated_at),
  }
}

export const updatedMeDto = (r: { member_id: string | null; display_name: string | null; phone: string | null; updated_at: number }, avatarUrl: string | null) => ({
  member_id: r.member_id,
  display_name: r.display_name,
  phone: r.phone,
  avatar_url: avatarUrl,
  updated_at: toJson(r.updated_at),
})

export const addressDto = (a: AddressRow) => ({
  id: a.id,
  label: a.label,
  is_default: a.is_default === 1,
  address_type: a.address_type,
  unit_number: a.unit_number,
  floor: a.floor,
  block: a.block,
  street: a.street,
  township: a.township,
  city: a.city,
  postcode: a.postcode,
  state: a.state,
  created_at: toJson(a.created_at),
  updated_at: toJson(a.updated_at),
})
