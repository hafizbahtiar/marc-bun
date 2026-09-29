// SQL milik features/legacy-import: legacy_member_import_batches,
// legacy_member_import_rows, legacy_member_claim_tokens.
// Operasi berbilang baris = SATU statement atas json_each (had 100 parameter
// dan had query setiap invokasi D1 tidak pernah dilanggar walau 1,000 baris).

export type StagedRow = {
  id: string
  batch_id: string
  source_row: number
  status: string
  legacy_staff_id: string
  member_id: string
  display_name: string
  email: string
  phone: string
  department_code: string
  position: string
  emergency_name: string
  emergency_phone: string
  health_notes: string
  address: string
  legacy_status: string
  conflicts: string
  warnings: string
  user_id: string | null
}

// cross-read: departments (kunci huruf kecil → kod tersimpan)
export async function departments(db: D1Database): Promise<Map<string, string>> {
  const { results } = await db.prepare('SELECT code FROM departments').all<{ code: string }>()
  return new Map(results.map((r) => [r.code.trim().toLowerCase(), r.code]))
}

// cross-read: users, profiles - akaun SEBENAR yang berlanggar, dalam tiga query.
export async function accounts(db: D1Database, emails: string[], staffIds: string[], memberIds: string[]) {
  const [u, s, m] = await db.batch([
    db.prepare('SELECT lower(email) AS k, id AS v FROM users WHERE lower(email) IN (SELECT value FROM json_each(?))').bind(JSON.stringify(emails)),
    db.prepare('SELECT staff_id AS k, user_id AS v FROM profiles WHERE staff_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(staffIds)),
    db.prepare('SELECT member_id AS k, user_id AS v FROM profiles WHERE member_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(memberIds)),
  ])
  const map = (r: D1Result | undefined) => new Map((r!.results as { k: string; v: string }[]).map((x) => [x.k, x.v]))
  return { userByEmail: map(u), staffOwner: map(s), memberOwner: map(m) }
}

export const insertBatchStmt = (db: D1Database, b: { id: string; filename: string; sha256: string; createdBy: string; total: number; valid: number; now: number }) =>
  db
    .prepare('INSERT INTO legacy_member_import_batches (id, source_filename, source_sha256, created_by, total_rows, valid_rows, conflict_rows, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(b.id, b.filename, b.sha256, b.createdBy, b.total, b.valid, b.total - b.valid, b.now)

export type NewRow = Omit<StagedRow, 'batch_id' | 'user_id'> & { category: string; club_position: string; legacy_number: string }

// user_id = akaun sedia ada dengan emel yang sama (cross-read: users).
export const insertRowsStmt = (db: D1Database, batchId: string, rows: NewRow[], now: number) =>
  db
    .prepare(
      `INSERT INTO legacy_member_import_rows (id, batch_id, source_row, legacy_number, status, legacy_staff_id, member_id, display_name, email, phone,
         department_code, position, emergency_name, emergency_phone, health_notes, address, category, club_position, legacy_status, conflicts, warnings, user_id, created_at)
       SELECT j.value ->> '$.id', ?1, j.value ->> '$.source_row', j.value ->> '$.legacy_number', j.value ->> '$.status', j.value ->> '$.legacy_staff_id',
         j.value ->> '$.member_id', j.value ->> '$.display_name', j.value ->> '$.email', j.value ->> '$.phone', j.value ->> '$.department_code',
         j.value ->> '$.position', j.value ->> '$.emergency_name', j.value ->> '$.emergency_phone', j.value ->> '$.health_notes', j.value ->> '$.address',
         j.value ->> '$.category', j.value ->> '$.club_position', j.value ->> '$.legacy_status', j.value ->> '$.conflicts', j.value ->> '$.warnings',
         (SELECT id FROM users WHERE j.value ->> '$.email' <> '' AND lower(email) = lower(j.value ->> '$.email')), ?2
       FROM json_each(?3) j`,
    )
    .bind(batchId, now, JSON.stringify(rows))

export async function listBatches(db: D1Database) {
  const { results } = await db
    .prepare('SELECT id, source_filename, status, total_rows, valid_rows, conflict_rows, created_at FROM legacy_member_import_batches ORDER BY created_at DESC LIMIT 50')
    .all<{ id: string; source_filename: string; status: string; total_rows: number; valid_rows: number; conflict_rows: number; created_at: number }>()
  return results
}

export async function rowsOf(db: D1Database, batchId: string, onlyValid = false): Promise<StagedRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM legacy_member_import_rows WHERE batch_id = ? ${onlyValid ? "AND status = 'valid'" : ''} ORDER BY source_row`)
    .bind(batchId)
    .all<StagedRow>()
  return results
}

export const getRow = (db: D1Database, id: string) => db.prepare('SELECT batch_id, status FROM legacy_member_import_rows WHERE id = ?').bind(id).first<{ batch_id: string; status: string }>()

export type RowUpdate = { id: string; status: string; conflicts: string; department_code: string; legacy_staff_id: string }

export const updateRowsStmt = (db: D1Database, updates: RowUpdate[]) =>
  db
    .prepare(
      `UPDATE legacy_member_import_rows SET status = j.value ->> '$.status', conflicts = j.value ->> '$.conflicts',
         department_code = j.value ->> '$.department_code', legacy_staff_id = j.value ->> '$.legacy_staff_id'
       FROM json_each(?) j WHERE legacy_member_import_rows.id = j.value ->> '$.id'`,
    )
    .bind(JSON.stringify(updates))

export const markImportedStmt = (db: D1Database, ids: string[]) =>
  db.prepare("UPDATE legacy_member_import_rows SET status = 'imported' WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ids))

export const setBatchCountsStmt = (db: D1Database, id: string, valid: number, conflict: number) =>
  db.prepare('UPDATE legacy_member_import_batches SET valid_rows = ?, conflict_rows = ? WHERE id = ?').bind(valid, conflict, id)

export const setBatchStatusStmt = (db: D1Database, id: string, status: string) => db.prepare('UPDATE legacy_member_import_batches SET status = ? WHERE id = ?').bind(status, id)

// cross-read: profiles (id profil untuk entity_id audit)
export async function profileIds(db: D1Database, userIds: string[]): Promise<Map<string, string>> {
  const { results } = await db.prepare('SELECT user_id, id FROM profiles WHERE user_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(userIds)).all<{ user_id: string; id: string }>()
  return new Map(results.map((r) => [r.user_id, r.id]))
}

// ---- tuntutan ----

export const findClaimRow = (db: D1Database, email: string, staffId: string) =>
  db
    .prepare(
      `SELECT r.id, r.email FROM legacy_member_import_rows r JOIN legacy_member_import_batches b ON b.id = r.batch_id
       WHERE r.status IN ('valid', 'imported') AND r.user_id IS NULL AND lower(r.email) = lower(?) AND r.legacy_staff_id = ?
       ORDER BY b.created_at DESC LIMIT 1`,
    )
    .bind(email, staffId)
    .first<{ id: string; email: string }>()

// Satu token hidup setiap baris (UNIQUE row_id): ganti yang lama.
export const replaceTokenStmts = (db: D1Database, t: { id: string; rowId: string; hash: string; expiresAt: number; now: number }) => [
  db.prepare('DELETE FROM legacy_member_claim_tokens WHERE row_id = ?').bind(t.rowId),
  db.prepare('INSERT INTO legacy_member_claim_tokens (id, row_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)').bind(t.id, t.rowId, t.hash, t.expiresAt, t.now),
]

export const claimLookup = (db: D1Database, hash: string, now: number) =>
  db
    .prepare(
      `SELECT t.id AS token_id, r.id, b.created_by, r.email, r.legacy_staff_id, r.member_id, r.display_name, r.phone, r.department_code, r.position,
         r.emergency_name, r.emergency_phone, r.health_notes, r.user_id
       FROM legacy_member_claim_tokens t JOIN legacy_member_import_rows r ON r.id = t.row_id JOIN legacy_member_import_batches b ON b.id = r.batch_id
       WHERE t.token_hash = ? AND t.consumed_at IS NULL AND t.expires_at > ?`,
    )
    .bind(hash, now)
    .first<Omit<StagedRow, 'batch_id' | 'status' | 'source_row' | 'address' | 'legacy_status' | 'conflicts' | 'warnings'> & { token_id: string; created_by: string | null }>()

// Sekali-guna: guard `consumed_at IS NULL`. Statement berikutnya dalam batch
// bersyarat pada token ini baru digunakan (`consumed_at = now`).
export const consumeTokenStmt = (db: D1Database, tokenId: string, now: number) =>
  db.prepare('UPDATE legacy_member_claim_tokens SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL').bind(now, tokenId)

export const CONSUMED_GUARD = 'EXISTS (SELECT 1 FROM legacy_member_claim_tokens WHERE id = ? AND consumed_at = ?)'

export const markClaimedStmt = (db: D1Database, rowId: string, userId: string, tokenId: string, now: number) =>
  db.prepare(`UPDATE legacy_member_import_rows SET status = 'claimed', user_id = ? WHERE id = ? AND ${CONSUMED_GUARD}`).bind(userId, rowId, tokenId, now)
