// Zod strip. Medan "pointer" Go: tiada ATAU null = jangan ubah; "" = kosongkan.
// Semakan panjang/format dengan mesej Melayu marc_go ada dalam service.ts
// (susunan semakan marc_go dipelihara).
import { z } from 'zod'

const opt = z.string().nullish()

export const updateMeSchema = z.object({
  display_name: opt,
  phone: opt,
  avatar_r2_key: opt,
  emergency_contact_name: opt,
  emergency_contact_phone: opt,
  health_notes: opt,
  updated_at: z.string().min(1),
})

export const createAddressSchema = z.object({
  label: opt,
  address_type: z.string().min(1),
  unit_number: opt,
  floor: opt,
  block: opt,
  street: opt,
  township: opt,
  city: z.string().min(1),
  postcode: z.string().min(1),
  state: z.string().min(1),
  is_default: z.boolean().default(false),
})

export const updateAddressSchema = z.object({
  label: opt,
  address_type: opt,
  unit_number: opt,
  floor: opt,
  block: opt,
  street: opt,
  township: opt,
  city: opt,
  postcode: opt,
  state: opt,
  is_default: z.boolean().nullish(),
})
