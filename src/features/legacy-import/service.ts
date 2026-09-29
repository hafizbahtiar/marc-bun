// Import rekod ahli MARC 2026 + tuntutan akaun - pariti marc_go
// handlers/legacy_member_import.go. Transaksi interaktif marc_go diganti dengan
// kiraan dalam app + SATU db.batch (baca dahulu, tulis sekali).
import { createUserStmt, hashPassword } from '../auth'
import { createDepartmentStmt } from '../departments'
import { applyLegacyStmt, atLeastRole, createLegacyStmt } from '../profile'
import { auditStmt, type Actor } from '../../shared/audit'
import type { Config } from '../../shared/config'
import { opaqueToken, sha256Hex } from '../../shared/crypto'
import { uuid } from '../../shared/db'
import { emailEnabled, escapeHtml, type SendEmail } from '../../shared/email'
import { ApiError } from '../../shared/http'
import { toJson } from '../../shared/time'
import { canonicalDepartment, duplicateConflicts, normalizeIdentifier, parse, unknownDepartment, validate, type Conflict, type Report, type Row } from './parse'
import * as repo from './repo'
import type { StagedRow } from './repo'

export type LegacyDeps = { sendEmail: SendEmail }

export type LegacyCtx = { env: CloudflareBindings; config: Config; deps: LegacyDeps; now: number; actor: Actor; userId: string; waitUntil(p: Promise<unknown>): void }

const MAX_BYTES = 1 << 20
const CLAIM_TTL = 3600_000

export async function requireSuperAdmin(ctx: { env: CloudflareBindings; userId: string }) {
  let ok: boolean
  try {
    ok = await atLeastRole(ctx.env.DB, ctx.userId, 'superadmin')
  } catch {
    throw new ApiError(500, 'gagal semak kebenaran')
  }
  if (!ok) throw new ApiError(403, 'tindakan ini untuk superadmin sahaja')
}

const EXISTING_STAFF: Conflict = { code: 'existing_staff_id', message: 'No. ID. sudah digunakan oleh akaun lain.' }
const EXISTING_MEMBER: Conflict = { code: 'existing_member_id', message: 'No. Ahli sudah digunakan oleh akaun lain.' }

// Perlanggaran dengan akaun SEBENAR: pemilik staff_id/member_id bukan akaun
// dengan emel yang sama.
function existingConflicts(a: Awaited<ReturnType<typeof repo.accounts>>, email: string, staffId: string, memberId: string): Conflict[] {
  const self = a.userByEmail.get(email.trim().toLowerCase())
  const out: Conflict[] = []
  const staffOwner = a.staffOwner.get(staffId)
  if (staffOwner && staffOwner !== self) out.push(EXISTING_STAFF)
  const memberOwner = a.memberOwner.get(memberId)
  if (memberOwner && memberOwner !== self) out.push(EXISTING_MEMBER)
  return out
}

// ---- dry-run ----

export async function dryRun(ctx: LegacyCtx, file: File | undefined) {
  if (!file || typeof file === 'string') throw new ApiError(400, 'fail CSV diperlukan')
  if (file.size > MAX_BYTES) throw new ApiError(400, 'fail CSV diperlukan')
  const text = await file.text()
  let report: Report
  try {
    report = parse(text)
  } catch (err) {
    throw new ApiError(400, (err as Error).message)
  }
  const db = ctx.env.DB
  let depts: Map<string, string>
  let a: Awaited<ReturnType<typeof repo.accounts>>
  try {
    depts = await repo.departments(db)
    a = await repo.accounts(db, report.rows.map((r) => r.normalizedEmail), report.rows.map((r) => r.legacyStaffId), report.rows.map((r) => r.memberId))
  } catch {
    throw new ApiError(500, 'gagal semak data sedia ada')
  }
  for (const row of report.rows) {
    const canonical = canonicalDepartment(row.departmentCode, depts)
    if (canonical === null) row.conflicts.push(unknownDepartment(row.departmentCode))
    else row.departmentCode = canonical
    row.conflicts.push(...existingConflicts(a, row.normalizedEmail, row.legacyStaffId, row.memberId))
  }
  const valid = report.rows.filter((r) => !r.conflicts.length).length

  const batchId = uuid()
  try {
    await ctx.env.DB.batch([
      repo.insertBatchStmt(db, { id: batchId, filename: file.name, sha256: await sha256Hex(text), createdBy: ctx.userId, total: report.totalRows, valid, now: ctx.now }),
      repo.insertRowsStmt(
        db,
        batchId,
        report.rows.map((r) => ({
          id: uuid(),
          source_row: r.sourceRow,
          legacy_number: r.legacyNumber,
          status: r.conflicts.length ? 'conflict' : 'valid',
          legacy_staff_id: r.legacyStaffId,
          member_id: r.memberId,
          display_name: r.displayName,
          email: r.normalizedEmail,
          phone: r.normalizedPhone,
          department_code: r.departmentCode,
          position: r.position,
          emergency_name: r.emergencyName,
          emergency_phone: r.emergencyPhone,
          health_notes: r.healthNotes,
          address: r.address,
          category: r.category,
          club_position: r.clubPosition,
          legacy_status: r.status,
          // Sentiasa array JSON (CHECK) - tidak pernah null.
          conflicts: JSON.stringify(r.conflicts),
          warnings: JSON.stringify(r.warnings),
        })),
        ctx.now,
      ),
    ])
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'legacy import dry-run', error: String(err) }))
    throw new ApiError(500, 'gagal simpan laporan import')
  }
  return { id: batchId, source_file: file.name, total_rows: report.totalRows, valid_rows: valid, conflict_rows: report.totalRows - valid, warnings: report.warnings, header_row: report.headerRow }
}

// ---- baca ----

export async function batches(ctx: LegacyCtx) {
  const rows = await repo.listBatches(ctx.env.DB).catch(() => {
    throw new ApiError(500, 'gagal muat batch import')
  })
  return { batches: rows.map((b) => ({ ...b, created_at: toJson(b.created_at) })) }
}

export async function batch(ctx: LegacyCtx, batchId: string) {
  const db = ctx.env.DB
  const depts = await repo.departments(db).catch(() => {
    throw new ApiError(500, 'gagal semak bahagian import')
  })
  const rows = await repo.rowsOf(db, batchId).catch(() => {
    throw new ApiError(500, 'gagal muat baris import')
  })
  return {
    rows: rows.map((r) => {
      const conflicts = JSON.parse(r.conflicts) as Conflict[]
      // Bahagian yang dipadam selepas dry-run muncul sebagai konflik semasa baca.
      if (canonicalDepartment(r.department_code, depts) === null && !conflicts.some((c) => c.code === 'unknown_department')) conflicts.push(unknownDepartment(r.department_code))
      return {
        id: r.id,
        source_row: r.source_row,
        status: r.status,
        legacy_staff_id: r.legacy_staff_id,
        member_id: r.member_id,
        display_name: r.display_name,
        email: r.email,
        phone: r.phone,
        department_code: r.department_code,
        position: r.position,
        legacy_status: r.legacy_status,
        conflicts,
        warnings: JSON.parse(r.warnings) as Conflict[],
        user_id: r.user_id,
      }
    }),
  }
}

// ---- import ----

// Hanya baris bersih yang SUDAH ada akaun dikemas kini; tanpa akaun kekal
// untuk dituntut. Boleh diulang: baris diimport tidak lagi 'valid'.
export async function importBatch(ctx: LegacyCtx, batchId: string) {
  const db = ctx.env.DB
  const depts = await repo.departments(db).catch(() => {
    throw new ApiError(500, 'gagal semak bahagian import')
  })
  const rows = await repo.rowsOf(db, batchId, true).catch(() => {
    throw new ApiError(500, 'gagal baca baris import')
  })
  const blocked: repo.RowUpdate[] = []
  const toImport: (StagedRow & { dept: string })[] = []
  for (const r of rows) {
    const canonical = canonicalDepartment(r.department_code, depts)
    if (canonical === null) {
      blocked.push({ id: r.id, status: 'conflict', conflicts: JSON.stringify([...(JSON.parse(r.conflicts) as Conflict[]), unknownDepartment(r.department_code)]), department_code: r.department_code, legacy_staff_id: r.legacy_staff_id })
    } else if (r.user_id) toImport.push({ ...r, dept: canonical })
  }
  const profiles = await repo.profileIds(db, toImport.map((r) => r.user_id!))

  const stmts: D1PreparedStatement[] = []
  if (blocked.length) stmts.push(repo.updateRowsStmt(db, blocked))
  // ponytail: 2 statement setiap akaun sedia ada - ~490 akaun setiap panggilan (had query); panggil semula untuk baki.
  for (const r of toImport) {
    const fields = {
      displayName: r.display_name,
      phone: r.phone,
      departmentCode: r.dept,
      position: r.position,
      emergencyName: r.emergency_name,
      emergencyPhone: r.emergency_phone,
      healthNotes: r.health_notes,
      staffId: r.legacy_staff_id,
      memberId: r.member_id,
      legacyStatus: r.legacy_status,
    }
    stmts.push(applyLegacyStmt(db, r.user_id!, fields, ctx.now))
    stmts.push(
      auditStmt(db, {
        entityType: 'profile',
        entityId: profiles.get(r.user_id!) ?? r.user_id!,
        action: 'update',
        actor: ctx.actor,
        new: {
          display_name: r.display_name,
          phone: r.phone,
          department_code: r.dept,
          position: r.position,
          emergency_contact_name: r.emergency_name,
          emergency_contact_phone: r.emergency_phone,
          health_notes: r.health_notes,
          staff_id: r.legacy_staff_id,
          member_id: r.member_id,
          is_active: r.legacy_status,
        },
      })!,
    )
  }
  if (toImport.length) stmts.push(repo.markImportedStmt(db, toImport.map((r) => r.id)))
  stmts.push(repo.setBatchStatusStmt(db, batchId, blocked.length ? 'ready' : 'imported'))
  try {
    await db.batch(stmts)
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'legacy import', batch: batchId, error: String(err) }))
    throw new ApiError(500, 'gagal import baris')
  }
  return { imported: toImport.length, blocked: blocked.length, unclaimed: 'baris tanpa akaun kekal untuk claim' }
}

// ---- kira semula batch ----

// Kod yang boleh dijana semula daripada lajur tersimpan. Kod lain (cth
// invalid_registration_year - lajurnya tidak disimpan) DIKEKALKAN.
const RECOMPUTABLE = new Set([
  'missing_email', 'invalid_email', 'duplicate_email', 'missing_name', 'missing_member_id', 'duplicate_member_id', 'existing_member_id',
  'missing_staff_id', 'placeholder_staff_id', 'duplicate_staff_id', 'existing_staff_id', 'invalid_status', 'unknown_department',
]) // prettier-ignore

const BLANK: Row = {
  sourceRow: 0, legacyNumber: '', status: '', category: '', clubPosition: '', legacyStaffId: '', registrationYear: '', memberId: '', displayName: '',
  phone: '', email: '', departmentCode: '', address: '', position: '', emergencyName: '', emergencyPhone: '', healthNotes: '',
} // prettier-ignore

// Seluruh batch, bukan satu baris: pendua ialah sifat PASANGAN. Status juga
// diselaras kerana import memilih `status = 'valid'`.
async function revalidate(db: D1Database, batchId: string, edit: (rows: StagedRow[]) => void, depts: Map<string, string>) {
  const rows = await repo.rowsOf(db, batchId)
  edit(rows)
  const a = await repo.accounts(db, rows.map((r) => r.email.trim().toLowerCase()), rows.map((r) => r.legacy_staff_id), rows.map((r) => r.member_id))
  const dups = duplicateConflicts(rows, [(r) => r.email.trim().toLowerCase(), (r) => normalizeIdentifier(r.legacy_staff_id), (r) => r.member_id.trim()])
  let valid = 0
  const updates = rows.map((r, i): repo.RowUpdate => {
    const preserved = (JSON.parse(r.conflicts) as Conflict[]).filter((c) => !RECOMPUTABLE.has(c.code))
    // Hanya lajur tersimpan (telefon/tahun daftar tidak dikira semula - pariti).
    const v = validate({ ...BLANK, legacyStaffId: r.legacy_staff_id, memberId: r.member_id, displayName: r.display_name, email: r.email, departmentCode: r.department_code, status: r.legacy_status })
    const conflicts = [...preserved, ...v.conflicts]
    let dept = r.department_code
    const canonical = canonicalDepartment(dept, depts)
    if (canonical === null) conflicts.push(unknownDepartment(dept))
    else dept = canonical
    conflicts.push(...dups[i]!, ...existingConflicts(a, r.email, r.legacy_staff_id, r.member_id))
    if (!conflicts.length) valid++
    // imported/claimed = fakta sejarah, tidak diturunkan.
    const status = r.status === 'imported' || r.status === 'claimed' ? r.status : conflicts.length ? 'conflict' : 'valid'
    return { id: r.id, status, conflicts: JSON.stringify(conflicts), department_code: dept, legacy_staff_id: r.legacy_staff_id }
  })
  return [repo.updateRowsStmt(db, updates), repo.setBatchCountsStmt(db, batchId, valid, rows.length - valid)]
}

export async function updateRow(ctx: LegacyCtx, rowId: string, rawStaffId: string | undefined) {
  if (rawStaffId === undefined) throw new ApiError(400, 'tiada medan untuk dikemas kini')
  const staffId = rawStaffId.trim()
  if (!staffId) throw new ApiError(400, 'No. ID. tidak boleh kosong')
  const db = ctx.env.DB
  const row = await repo.getRow(db, rowId)
  if (!row) throw new ApiError(404, 'baris import tidak ditemui')
  // Sudah menyentuh akaun sebenar - suntingan hanya memesongkan staging.
  if (row.status === 'imported' || row.status === 'claimed') throw new ApiError(409, 'baris ini sudah diimport atau dituntut')
  try {
    const depts = await repo.departments(db)
    await db.batch(await revalidate(db, row.batch_id, (rows) => void (rows.find((r) => r.id === rowId)!.legacy_staff_id = staffId), depts))
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'legacy import revalidate', error: String(err) }))
    throw new ApiError(500, 'gagal kira semula konflik import')
  }
  return { batch_id: row.batch_id }
}

// Cipta bahagian yang hilang DAN tulis semula rujukan baris kepada kod itu,
// serentak (kod tidak boleh ada '/' - ia memecahkan /admin/departments/:code).
export async function resolveDepartment(ctx: LegacyCtx, batchId: string, input: { from: string; code: string; name: string }) {
  const from = input.from.trim()
  const code = input.code.trim()
  const name = input.name.trim()
  if (!from || !code) throw new ApiError(400, 'nilai asal dan kod bahagian diperlukan')
  if (code.includes('/')) throw new ApiError(400, "kod bahagian tidak boleh mengandungi '/'")
  const db = ctx.env.DB
  const depts = await repo.departments(db).catch(() => {
    throw new ApiError(500, 'gagal semak bahagian')
  })
  // Tidak peka huruf: "bkp" bila "BKP" wujud = gabung, bukan pendua.
  let canonical = depts.get(code.toLowerCase())
  const stmts: D1PreparedStatement[] = []
  if (!canonical) {
    if (!name) throw new ApiError(400, 'nama diperlukan untuk bahagian baharu')
    stmts.push(createDepartmentStmt(db, { code, name, sortOrder: 0, addedBy: ctx.userId }))
    canonical = code
    depts.set(code.toLowerCase(), code)
  }
  const target = canonical
  try {
    stmts.push(...(await revalidate(db, batchId, (rows) => rows.forEach((r) => r.department_code.trim().toLowerCase() === from.toLowerCase() && (r.department_code = target)), depts)))
    await db.batch(stmts)
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'legacy resolve department', error: String(err) }))
    throw new ApiError(500, 'gagal kira semula konflik import')
  }
  return { code: target }
}

// ---- tuntutan akaun (awam) ----

// Respons SAMA untuk padan / tidak padan / akaun sudah wujud - tiada enumerasi.
export async function requestClaim(ctx: Omit<LegacyCtx, 'userId' | 'actor'>, email: string, rawStaffId: string) {
  const db = ctx.env.DB
  const row = await repo.findClaimRow(db, email.trim().toLowerCase(), rawStaffId.trim()).catch(() => null)
  if (!row?.email) return
  const token = opaqueToken()
  try {
    await db.batch(repo.replaceTokenStmts(db, { id: uuid(), rowId: row.id, hash: await sha256Hex(token), expiresAt: ctx.now + CLAIM_TTL, now: ctx.now }))
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'legacy claim token', error: String(err) }))
    return
  }
  // Halaman frontend (marc_next). Kosong = PUBLIC_BASE_URL/claim-account (marc_go:
  // backend tiada laluan itu - pautan emel 404).
  const base = ctx.config.CLAIM_ACCOUNT_URL || `${ctx.config.PUBLIC_BASE_URL.replace(/\/+$/, '')}/claim-account`
  const link = `${base}?token=${token}`
  if (!emailEnabled(ctx.config)) {
    // Pautan = kelayakan: dilog di development sahaja.
    if (ctx.config.ENVIRONMENT !== 'production') console.log(JSON.stringify({ level: 'info', msg: 'legacy claim link (emel belum dikonfigurasi)', link }))
    return
  }
  const html = `<html><body><p>Gunakan pautan ini untuk menuntut akaun MARC anda:</p><p><a href="${escapeHtml(link)}">Tuntut akaun MARC</a></p><p>Pautan ini sah selama 1 jam.</p></body></html>`
  ctx.waitUntil(ctx.deps.sendEmail(ctx.config, { to: row.email, subject: 'Tuntut akaun MARC', html }).catch((err) => console.error(JSON.stringify({ level: 'error', msg: 'gagal hantar claim email', error: String(err) }))))
}

export async function completeClaim(ctx: Omit<LegacyCtx, 'userId' | 'actor'>, token: string, password: string) {
  const db = ctx.env.DB
  let passwordHash: string
  try {
    passwordHash = await hashPassword(password)
  } catch {
    throw new ApiError(500, 'gagal sediakan kata laluan')
  }
  const c = await repo.claimLookup(db, await sha256Hex(token), ctx.now).catch(() => {
    throw new ApiError(500, 'gagal semak pautan claim')
  })
  if (!c) throw new ApiError(400, 'pautan claim tidak sah atau sudah luput')
  if (c.user_id) throw new ApiError(409, 'akaun untuk rekod ini sudah wujud')
  const depts = await repo.departments(db).catch(() => {
    throw new ApiError(500, 'gagal semak bahagian tuntutan')
  })
  const dept = canonicalDepartment(c.department_code, depts)
  if (dept === null) throw new ApiError(409, `Kod bahagian tidak wujud: ${c.department_code}.`)

  const userId = uuid()
  // Semua bersyarat pada token INI baru digunakan: tuntutan serentak = satu akaun.
  const guard = { sql: repo.CONSUMED_GUARD, params: [c.token_id, ctx.now] }
  let consumed: D1Result | undefined
  try {
    ;[consumed] = await db.batch([
      repo.consumeTokenStmt(db, c.token_id, ctx.now),
      createUserStmt(db, { id: userId, email: c.email, passwordHash }, guard),
      createLegacyStmt(
        db,
        {
          id: uuid(),
          userId,
          displayName: c.display_name,
          phone: c.phone,
          departmentCode: dept,
          position: c.position,
          emergencyName: c.emergency_name,
          emergencyPhone: c.emergency_phone,
          healthNotes: c.health_notes,
          staffId: c.legacy_staff_id,
          memberId: c.member_id,
          legacyStatus: '',
          verifiedBy: c.created_by,
          now: ctx.now,
        },
        guard,
      ),
      repo.markClaimedStmt(db, c.id, userId, c.token_id, ctx.now),
    ])
  } catch (err) {
    if (String(err).includes('UNIQUE constraint failed: users.email')) throw new ApiError(409, 'akaun dengan emel ini sudah wujud')
    console.error(JSON.stringify({ level: 'error', msg: 'legacy claim complete', error: String(err) }))
    throw new ApiError(500, 'gagal cipta akaun')
  }
  // Tuntutan serentak lain menggunakan token dahulu: tiada apa ditulis di sini.
  if (!consumed?.meta.changes) throw new ApiError(400, 'pautan claim tidak sah atau sudah luput')
}
