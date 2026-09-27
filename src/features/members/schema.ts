import { z } from 'zod'

export const roleSchema = z.object({ role_key: z.string().min(1), updated_at: z.string().min(1) })

export const activeSchema = z.object({ is_active: z.boolean().default(false), updated_at: z.string().min(1) })

// Ganti PENUH: null/"" = kosongkan.
export const departmentSchema = z.object({
  department_code: z.string().nullish(),
  position: z.string().nullish(),
  updated_at: z.string().min(1),
})

// Body pilihan (approve / verify-staff-id): kosong = {}; cacat = 400.
export const approveSchema = z.object({ bypass_payment: z.boolean().default(false), bypass_reason: z.string().max(500).default('') })
export const verifyStaffSchema = z.object({ staff_id: z.string().nullish() })

export const correctStaffSchema = z.object({ staff_id: z.string().default('') })
export const correctMemberIdSchema = z.object({ member_id: z.string().default('') })
