// Peraturan /me, alamat, permintaan pemadaman - pariti marc_go
// handlers/profile.go (Me, UpdateMe, RequestAccountDeletion) + addresses.go.
// Susunan semakan & mesej = marc_go.
import { enqueueDeleteStmt, signedUrl } from '../uploads'
import { auditStmt, ENTITY, type Actor } from '../../shared/audit'
import { expectedUpdatedAt, staleWrite } from '../../shared/concurrency'
import { uuid } from '../../shared/db'
import { ApiError } from '../../shared/http'
import { normalizeMY } from '../../shared/phone'
import { toJson } from '../../shared/time'
import { addressDto, meDto, updatedMeDto } from './dto'
import * as repo from './repo'

export type ProfileCtx = { env: CloudflareBindings; now: number; actor: Actor; feeCents: number }

const runes = (s: string) => [...s].length
const tooLong = (v: string | null | undefined, max: number) => v != null && runes(v) > max

// ---- /me ----

export async function me(ctx: ProfileCtx, userId: string) {
  const row = await repo.getMember(ctx.env.DB, userId)
  if (!row) throw new ApiError(404, 'profil tidak dijumpai')
  return meDto(row, await signedUrl(ctx.env, row.avatar_r2_key), ctx.feeCents)
}

type UpdateMe = {
  display_name?: string | null
  phone?: string | null
  avatar_r2_key?: string | null
  emergency_contact_name?: string | null
  emergency_contact_phone?: string | null
  health_notes?: string | null
  updated_at: string
}

// Nilai "" dibenarkan (buang); nombor bukan kosong mesti format Malaysia.
function phoneField(raw: string | null | undefined, message: string): string | undefined {
  if (raw == null) return undefined
  const trimmed = raw.trim()
  if (!trimmed) return ''
  const normalized = normalizeMY(trimmed)
  if (!normalized) throw new ApiError(400, message)
  return normalized
}

export async function updateMe(ctx: ProfileCtx, userId: string, input: UpdateMe) {
  if (tooLong(input.display_name, 100)) throw new ApiError(400, 'nama paparan terlalu panjang (maksimum 100 aksara)')
  if (tooLong(input.phone, 30)) throw new ApiError(400, 'nombor telefon terlalu panjang (maksimum 30 aksara)')
  if (tooLong(input.emergency_contact_name, 100)) throw new ApiError(400, 'nama waris terlalu panjang (maksimum 100 aksara)')
  if (tooLong(input.emergency_contact_phone, 30)) throw new ApiError(400, 'nombor telefon waris terlalu panjang (maksimum 30 aksara)')
  if (tooLong(input.health_notes, 500)) throw new ApiError(400, 'nota kesihatan terlalu panjang (maksimum 500 aksara)')
  const phone = phoneField(input.phone, 'format nombor telefon tidak sah')
  const emergencyPhone = phoneField(input.emergency_contact_phone, 'format nombor telefon waris tidak sah')
  const expected = expectedUpdatedAt(input.updated_at)

  const avatarKey = input.avatar_r2_key == null ? undefined : input.avatar_r2_key.trim()
  // Gambar baharu memerlukan pengesahan R2 (features/uploads, Fasa 4). Sehingga
  // itu: pariti marc_go bila R2 belum dikonfigur. Ditolak SEBELUM kemas kini
  // supaya permintaan gagal tidak separuh berlaku.
  if (avatarKey) throw new ApiError(400, 'gambar tidak sah atau belum diupload')

  const db = ctx.env.DB
  const updated = await repo
    .updateSelfStmt(
      db,
      userId,
      {
        display_name: input.display_name?.trim(),
        phone,
        emergency_contact_name: input.emergency_contact_name?.trim(),
        emergency_contact_phone: emergencyPhone,
        health_notes: input.health_notes?.trim(),
      },
      expected,
      ctx.now,
    )
    .first<{ member_id: string | null; display_name: string | null; phone: string | null; avatar_r2_key: string | null; updated_at: number }>()
  if (!updated) throw staleWrite('profil telah berubah. Muat semula sebelum menyunting lagi.')

  if (avatarKey !== '') return updatedMeDto(updated, await signedUrl(ctx.env, updated.avatar_r2_key))

  // Buang avatar: kosongkan + gilir objek lama + audit, SATU batch.
  const before = updated.avatar_r2_key
  const stmts = [repo.setAvatarStmt(db, userId, null, ctx.now)]
  if (before) stmts.push(enqueueDeleteStmt(db, before, 'avatar_replaced'))
  const audit = auditStmt(db, { entityType: ENTITY.profile, entityId: userId, action: 'update', actor: ctx.actor, old: { avatar_r2_key: before }, new: { avatar_r2_key: null } })
  if (audit) stmts.push(audit)
  const [cleared] = await db.batch(stmts)
  return updatedMeDto(cleared!.results[0] as typeof updated, null)
}

// ---- permintaan pemadaman (keperluan Google Play) ----

export async function requestDeletion(ctx: ProfileCtx, userId: string) {
  const db = ctx.env.DB
  // Audit hanya bila baris BARU dicipta dalam permintaan ini (requested_at = now).
  const audit = auditStmt(
    db,
    { entityType: ENTITY.accountDeletionRequest, entityId: userId, action: 'create', actor: ctx.actor, new: { status: 'pending' } },
    { sql: 'EXISTS (SELECT 1 FROM account_deletion_requests WHERE user_id = ? AND requested_at = ?)', params: [userId, ctx.now] },
  )!
  await db.batch([repo.createDeletionRequestStmt(db, uuid(), userId, ctx.now), audit])
  const row = await repo.getDeletionRequest(db, userId)
  if (!row) throw new ApiError(500, 'gagal rekod permintaan pemadaman akaun')
  return { status: row.status, requested_at: toJson(row.requested_at) }
}

// ---- alamat ----

const STATES = [
  'Johor', 'Kedah', 'Kelantan', 'Melaka', 'Negeri Sembilan', 'Pahang', 'Perak', 'Perlis', 'Pulau Pinang', 'Sabah', 'Sarawak',
  'Selangor', 'Terengganu', 'Wilayah Persekutuan Kuala Lumpur', 'Wilayah Persekutuan Labuan', 'Wilayah Persekutuan Putrajaya',
]
const validType = (t: string) => t === 'landed' || t === 'highrise'
const validPostcode = (p: string) => /^\d{5}$/.test(p)
const cityInvalid = (c: string) => c.trim() === '' || runes(c) > 100
const trimOrNull = (v: string | null | undefined) => (v == null ? null : v.trim())

type AddressInput = {
  label?: string | null
  address_type: string
  unit_number?: string | null
  floor?: string | null
  block?: string | null
  street?: string | null
  township?: string | null
  city: string
  postcode: string
  state: string
  is_default: boolean
}

export async function listAddresses(ctx: ProfileCtx, userId: string) {
  return (await repo.listAddresses(ctx.env.DB, userId)).map(addressDto)
}

export async function createAddress(ctx: ProfileCtx, userId: string, input: AddressInput) {
  if (!validType(input.address_type)) throw new ApiError(400, "jenis alamat mesti 'landed' atau 'highrise'")
  if (!validPostcode(input.postcode.trim())) throw new ApiError(400, 'poskod mesti 5 digit')
  if (!STATES.includes(input.state.trim())) throw new ApiError(400, 'negeri tidak sah')
  if (cityInvalid(input.city)) throw new ApiError(400, 'bandar diperlukan (maksimum 100 aksara)')
  if (tooLong(input.label, 100)) throw new ApiError(400, 'label terlalu panjang (maksimum 100 aksara)')

  const created = await repo.createAddress(ctx.env.DB, {
    id: uuid(),
    userId,
    isDefault: input.is_default,
    now: ctx.now,
    f: {
      label: trimOrNull(input.label),
      address_type: input.address_type,
      unit_number: trimOrNull(input.unit_number),
      floor: trimOrNull(input.floor),
      block: trimOrNull(input.block),
      street: trimOrNull(input.street),
      township: trimOrNull(input.township),
      city: input.city.trim(),
      postcode: input.postcode.trim(),
      state: input.state.trim(),
    },
  })
  if (!created) throw new ApiError(400, `had maksimum ${repo.MAX_ADDRESSES} alamat setiap ahli`)
  return addressDto(created)
}

type AddressPatch = Partial<Record<'label' | 'address_type' | 'unit_number' | 'floor' | 'block' | 'street' | 'township' | 'city' | 'postcode' | 'state', string | null>> & { is_default?: boolean | null }

export async function updateAddress(ctx: ProfileCtx, userId: string, id: string, input: AddressPatch) {
  if (input.address_type != null && !validType(input.address_type)) throw new ApiError(400, "jenis alamat mesti 'landed' atau 'highrise'")
  if (input.postcode != null && !validPostcode(input.postcode.trim())) throw new ApiError(400, 'poskod mesti 5 digit')
  if (input.state != null && !STATES.includes(input.state.trim())) throw new ApiError(400, 'negeri tidak sah')
  if (input.city != null && cityInvalid(input.city)) throw new ApiError(400, 'bandar diperlukan (maksimum 100 aksara)')
  if (tooLong(input.label, 100)) throw new ApiError(400, 'label terlalu panjang (maksimum 100 aksara)')

  const f: Record<string, string | undefined> = {}
  for (const k of ['label', 'address_type', 'unit_number', 'floor', 'block', 'street', 'township', 'city', 'postcode', 'state'] as const) {
    const v = input[k]
    if (v != null) f[k] = v.trim()
  }
  const updated = await repo.updateAddress(ctx.env.DB, { id, userId, f, makeDefault: input.is_default === true, now: ctx.now })
  if (!updated) throw new ApiError(404, 'alamat tidak dijumpai')
  return addressDto(updated)
}

export async function deleteAddress(ctx: ProfileCtx, userId: string, id: string) {
  if (!(await repo.deleteAddress(ctx.env.DB, id, userId, ctx.now))) throw new ApiError(404, 'alamat tidak dijumpai')
}
