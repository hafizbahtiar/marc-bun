// Parser TULEN eksport ahli MARC 2026 - pariti marc_go internal/legacyimport.
// Tiada DB. Buku kerja ada baris tajuk/legenda sebelum header, jadi header dicari.
import { normalizeMY } from '../../shared/phone'

export const HEADER_NAMES = [
  'Bil.', 'Status', 'Kategori', 'Jawatan Kelab', 'Kod Kelab', 'No. ID.', '/', 'Tahun Daftar', '-', 'Bil. Ahli', 'No. Ahli', 'Nama',
  'Telefon', 'Emel', 'Bahagian', 'Alamat', 'Jawatan', 'Nama Waris', 'TelefonWaris', 'Kesihatan', 'Saiz Baju', 'Jenis Baju', 'Lengan', 'Catatan',
] // prettier-ignore

export type Conflict = { code: string; message: string }

export type Row = {
  sourceRow: number
  legacyNumber: string
  status: string
  category: string
  clubPosition: string
  legacyStaffId: string
  registrationYear: string
  memberId: string
  displayName: string
  phone: string
  email: string
  departmentCode: string
  address: string
  position: string
  emergencyName: string
  emergencyPhone: string
  healthNotes: string
}

export type ValidatedRow = Row & { normalizedEmail: string; normalizedPhone: string; conflicts: Conflict[]; warnings: Conflict[] }

export type Report = { headerRow: number; rows: ValidatedRow[]; validRows: number; totalRows: number; warnings: number }

// CSV (RFC 4180 + LazyQuotes Go): petikan dalam medan tidak berpetik = literal;
// bilangan medan boleh berbeza setiap baris.
export function readCsv(text: string): string[][] {
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let quoted = false
  let fieldStart = true
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"' && fieldStart) {
      quoted = true
      fieldStart = false
    } else if (ch === ',') {
      record.push(field)
      field = ''
      fieldStart = true
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      record.push(field)
      records.push(record)
      record = []
      field = ''
      fieldStart = true
    } else {
      field += ch
      fieldStart = false
    }
  }
  if (field !== '' || record.length) {
    record.push(field)
    records.push(record)
  }
  return records
}

// Bentuk kanonik No. ID.: huruf besar, ruang dimampatkan. Dikongsi Parse DAN
// pengiraan semula batch - dua peraturan yang hanyut = pendua hilang.
export const normalizeIdentifier = (v: string) => v.trim().split(/\s+/).filter(Boolean).join(' ').toUpperCase()

// ponytail: semakan alamat asas (mail.ParseAddress Go juga menerima "Nama <a@b>"); cukup untuk eksport ini.
const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+$/

export function validate(row: Row): ValidatedRow {
  const out: ValidatedRow = { ...row, normalizedEmail: row.email.trim().toLowerCase(), normalizedPhone: normalizeMY(row.phone.trim()) ?? '', conflicts: [], warnings: [] }
  const add = (code: string, message: string) => out.conflicts.push({ code, message })
  if (!out.normalizedEmail) add('missing_email', 'Emel diperlukan.')
  else if (!EMAIL.test(out.normalizedEmail)) add('invalid_email', 'Format emel tidak sah.')
  if (!row.displayName.trim()) add('missing_name', 'Nama diperlukan.')
  if (!row.memberId.trim()) add('missing_member_id', 'No. Ahli diperlukan.')
  if (!row.legacyStaffId.trim()) add('missing_staff_id', 'No. ID. diperlukan.')
  const staff = normalizeIdentifier(row.legacyStaffId)
  if (staff === 'XXXX' || staff === 'MS') add('placeholder_staff_id', 'No. ID. ialah placeholder dan perlu disahkan.')
  if (row.phone.trim() && !out.normalizedPhone) out.warnings.push({ code: 'invalid_phone_cleared', message: 'Telefon tidak dapat dinormalisasi dan akan dikosongkan.' })
  if (row.status !== 'Aktif' && row.status !== 'Tidak Aktif') add('invalid_status', 'Status mesti Aktif atau Tidak Aktif.')
  const year = row.registrationYear.trim()
  if (year && !/^[+-]?\d+$/.test(year)) add('invalid_registration_year', 'Tahun daftar tidak sah.')
  return out
}

export const DUPLICATES = [
  ['duplicate_email', 'Emel muncul lebih daripada sekali dalam fail.'],
  ['duplicate_staff_id', 'No. ID. muncul lebih daripada sekali dalam fail.'],
  ['duplicate_member_id', 'No. Ahli muncul lebih daripada sekali dalam fail.'],
] as const

// Pendua ialah sifat PASANGAN - dikira atas seluruh set.
export function duplicateConflicts<T>(items: T[], keys: [(t: T) => string, (t: T) => string, (t: T) => string]): Conflict[][] {
  const counts = keys.map((key) => {
    const m = new Map<string, number>()
    for (const it of items) {
      const v = key(it)
      if (v) m.set(v, (m.get(v) ?? 0) + 1)
    }
    return m
  })
  return items.map((it) =>
    keys.flatMap((key, k) => {
      const v = key(it)
      return v && counts[k]!.get(v)! > 1 ? [{ code: DUPLICATES[k]![0], message: DUPLICATES[k]![1] }] : []
    }),
  )
}

export function parse(text: string): Report {
  const records = readCsv(text)
  const headerIndex = records.findIndex((r) => r.length >= HEADER_NAMES.length && r[0]!.trim() === HEADER_NAMES[0] && r[1]!.trim() === HEADER_NAMES[1] && r[10]!.trim() === HEADER_NAMES[10])
  if (headerIndex < 0) throw new Error('header CSV MARC tidak ditemui')
  const headerRow = headerIndex + 1
  const index = new Map(records[headerIndex]!.map((name, i) => [name.trim(), i]))

  const rows: ValidatedRow[] = []
  for (const record of records.slice(headerIndex + 1)) {
    if (record.every((v) => !v.trim())) continue
    // Legenda selepas baris ahli: hanya baris dengan Bil. numerik ialah ahli.
    if (!/^[+-]?\d+$/.test(record[0]!.trim())) continue
    const get = (name: string) => {
      const i = index.get(name)
      return i === undefined || i >= record.length ? '' : record[i]!.trim()
    }
    rows.push(
      validate({
        sourceRow: headerRow + rows.length + 1,
        legacyNumber: get('Bil.'),
        status: get('Status'),
        category: get('Kategori'),
        clubPosition: get('Jawatan Kelab'),
        legacyStaffId: get('No. ID.'),
        registrationYear: get('Tahun Daftar'),
        memberId: get('No. Ahli'),
        displayName: get('Nama'),
        phone: get('Telefon'),
        email: get('Emel'),
        departmentCode: get('Bahagian'),
        address: get('Alamat'),
        position: get('Jawatan'),
        emergencyName: get('Nama Waris'),
        emergencyPhone: get('TelefonWaris'),
        healthNotes: get('Kesihatan'),
      }),
    )
  }
  duplicateConflicts(rows, [(r) => r.normalizedEmail, (r) => normalizeIdentifier(r.legacyStaffId), (r) => r.memberId]).forEach((c, i) => rows[i]!.conflicts.push(...c))
  return summarize(headerRow, rows)
}

export function summarize(headerRow: number, rows: ValidatedRow[]): Report {
  return {
    headerRow,
    rows,
    totalRows: rows.length,
    validRows: rows.filter((r) => !r.conflicts.length).length,
    warnings: rows.reduce((n, r) => n + r.warnings.length, 0),
  }
}

// Kod bahagian CSV tidak peka huruf → kod tepat yang tersimpan (untuk FK).
export function canonicalDepartment(value: string, departments: Map<string, string>): string | null {
  const key = value.trim().toLowerCase()
  if (!key) return ''
  return departments.get(key) ?? null
}

export const unknownDepartment = (value: string): Conflict => ({ code: 'unknown_department', message: `Kod bahagian tidak wujud: ${value.trim()}.` })
