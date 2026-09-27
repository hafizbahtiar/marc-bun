// Respons bertingkat - dibina di SERVER; medan yang tidak layak = null
// (hadir dalam JSON), supaya klien bezakan "disembunyikan" daripada "tiada".
import type { AddressRow, MemberRow } from '../profile'
import { addressDto } from '../profile'
import { toJson, toJsonNullable } from '../../shared/time'

export function memberDto(r: MemberRow, v: { email: boolean; payment: boolean; staffId: boolean }, avatarUrl: string | null) {
  return {
    user_id: r.user_id,
    member_id: r.member_id,
    display_name: r.display_name,
    email: v.email ? r.email : null,
    role_key: r.role_key,
    role_name: r.role_name,
    role_rank: r.role_rank,
    category: r.role_category,
    status: r.status,
    avatar_url: avatarUrl,
    registration_payment_status: v.payment ? r.registration_payment_status : null,
    is_active: r.is_active === 1,
    department_code: r.department_code,
    department_name: r.department_name,
    position: r.position,
    staff_id: v.staffId ? r.staff_id : null,
    staff_id_verified_at: toJsonNullable(r.staff_id_verified_at),
    updated_at: toJson(r.updated_at),
  }
}

// T1 semua dalam siling · T2 management · T3 superadmin sahaja.
export function memberDetailDto(r: MemberRow, tier: { management: boolean; superadmin: boolean }, avatarUrl: string | null, addresses: AddressRow[] | null) {
  const t2 = tier.management
  const t3 = tier.superadmin
  return {
    user_id: r.user_id,
    member_id: r.member_id,
    display_name: r.display_name,
    avatar_url: avatarUrl,
    role_key: r.role_key,
    role_name: r.role_name,
    role_rank: r.role_rank,
    category: r.role_category,
    status: r.status,
    is_active: r.is_active === 1,
    department_code: r.department_code,
    department_name: r.department_name,
    position: r.position,
    staff_id_verified_at: toJsonNullable(r.staff_id_verified_at),
    email: t2 ? r.email : null,
    phone: t2 ? r.phone : null,
    registration_payment_status: t2 ? r.registration_payment_status : null,
    staff_id: t2 ? r.staff_id : null,
    updated_at: toJson(r.updated_at),
    emergency_contact_name: t3 ? r.emergency_contact_name : null,
    emergency_contact_phone: t3 ? r.emergency_contact_phone : null,
    health_notes: t3 ? r.health_notes : null,
    telegram_linked: t3 ? r.telegram_chat_id !== null : null,
    telegram_username: t3 ? r.telegram_username : null,
    addresses: t3 && addresses ? addresses.map(addressDto) : null,
  }
}
