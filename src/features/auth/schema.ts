// Pariti mesej friendlyBindError marc_go (handlers/bind.go): ralat pertama
// sahaja, ikut susunan medan struct Go. Panjang dalam AKSARA (rune), bukan
// unit UTF-16/bait - validator Go mengira rune.
import { z } from 'zod'
import { INVALID_DATA } from '../../shared/http'

const runes = (s: string) => [...s].length
const bytes = (s: string) => new TextEncoder().encode(s).length

// `required` Go: tiada / null / "" → mesej medan; jenis salah → Data tidak sah.
const required = (message: string) => z.string({ error: (i) => (i.input == null ? message : INVALID_DATA) }).min(1, message)

const email = required('Email diperlukan').email('Format email tidak sah')

const TOO_LONG = 'Kata laluan terlalu panjang (maksimum 72 aksara)'
// bcrypt memotong senyap selepas 72 BAIT - tolak, jangan simpan hash yang
// tidak mewakili kata laluan penuh (marc_go: bcrypt Go membaling ralat).
const passwordMax = (s: z.ZodString) => s.refine((v) => runes(v) <= 72 && bytes(v) <= 72, TOO_LONG)
const newPassword = passwordMax(required('Kata laluan diperlukan').refine((v) => runes(v) >= 6, 'Kata laluan diperlukan (minimum 6 aksara)'))

const upTo = (n: number) => z.string().min(1).refine((v) => runes(v) <= n)

export const registerSchema = z.object({
  email,
  password: newPassword,
  phone: upTo(30),
  staff_id: upTo(64),
})

export const loginSchema = z.object({
  email,
  password: passwordMax(required('Kata laluan diperlukan')),
})

export const refreshSchema = z.object({ refresh_token: required('Refresh token diperlukan') })

export const tokenSchema = z.object({ token: required('Token diperlukan') })

export const passwordResetRequestSchema = z.object({ email })

export const passwordResetConfirmSchema = z.object({ token: required('Token diperlukan'), password: newPassword })

export const revokeSessionsSchema = z.object({ ids: z.array(z.uuid()).min(1).max(50) })
