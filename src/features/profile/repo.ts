// SQL `profiles`, `member_addresses`, `account_deletion_requests` - HANYA fail
// ini menulis jadual-jadual itu (docs/modules/README.md). Operasi yang perlu
// atomik bersama jadual lain / audit memulangkan STATEMENT untuk db.batch().

// ---- baris penuh (pariti GetProfileByUserID + status bayaran) ----

export type MemberRow = {
  user_id: string
  member_id: string | null
  staff_id: string
  staff_id_verified_at: number | null
  display_name: string | null
  phone: string | null
  avatar_r2_key: string | null
  email_verified: number
  status: string
  approved_by: string | null
  approved_at: number | null
  is_active: number
  department_code: string | null
  department_name: string | null
  position: string | null
  emergency_contact_name: string | null
  emergency_contact_phone: string | null
  health_notes: string | null
  telegram_chat_id: number | null
  telegram_username: string | null
  banned_at: number | null
  ban_expires_at: number | null
  ban_reason: string | null
  banned_by: string | null
  updated_at: number
  email: string
  role_id: number
  role_key: string
  role_name: string
  role_category: string
  role_rank: number
  registration_payment_status: string | null
}

// cross-read: users (emel), roles (peranan), departments (nama),
// registration_payments (status TERKINI - utamakan 'succeeded', pariti
// GetLatestRegistrationPaymentStatus: bayar bil A selepas bil B dicipta)
const FULL = `SELECT p.*, u.email, r.key AS role_key, r.name AS role_name, r.category AS role_category, r.rank AS role_rank,
  d.name AS department_name,
  (SELECT rp.status FROM registration_payments rp WHERE rp.user_id = p.user_id
    ORDER BY (rp.status = 'succeeded') DESC, rp.created_at DESC LIMIT 1) AS registration_payment_status
FROM profiles p
JOIN users u ON u.id = p.user_id
JOIN roles r ON r.id = p.role_id
LEFT JOIN departments d ON d.code = p.department_code`

export const getMember = (db: D1Database, userId: string) => db.prepare(`${FULL} WHERE p.user_id = ?`).bind(userId).first<MemberRow>()

// Tapisan keterlihatan DALAM SQL (baris yang tak layak tidak pernah keluar DB).
// NULL member_id terakhir (pariti susunan Postgres).
export async function listVisible(db: D1Database, f: { maxRank: number; status: string | null; includeAll: boolean; viewerId: string }) {
  const { results } = await db
    .prepare(
      `${FULL} WHERE r.rank <= ? AND (? IS NULL OR p.status = ?) AND (? = 1 OR p.status = 'approved' OR p.user_id = ?)
       ORDER BY p.member_id IS NULL, p.member_id`,
    )
    .bind(f.maxRank, f.status, f.status, f.includeAll ? 1 : 0, f.viewerId)
    .all<MemberRow>()
  return results
}

export async function listManagementUserIds(db: D1Database): Promise<string[]> {
  const { results } = await db
    // cross-read: roles (kategori peranan melalui FK role_id)
    .prepare(`SELECT p.user_id FROM profiles p JOIN roles r ON r.id = p.role_id WHERE r.category = 'management'`)
    .all<{ user_id: string }>()
  return results.map((r) => r.user_id)
}

export async function countByRoleKey(db: D1Database, roleKey: string): Promise<number> {
  // cross-read: roles
  const row = await db.prepare('SELECT COUNT(*) AS n FROM profiles p JOIN roles r ON r.id = p.role_id WHERE r.key = ?').bind(roleKey).first<{ n: number }>()
  return row?.n ?? 0
}

// ---- pendaftaran / auth ----

export function createInitialStmt(db: D1Database, p: { id: string; userId: string; staffId: string; phone: string }) {
  return db
    .prepare(
      // cross-read: roles (id peranan 'ahli' dalam statement yang sama)
      `INSERT INTO profiles (id, user_id, role_id, staff_id, phone)
       VALUES (?, ?, (SELECT id FROM roles WHERE key = 'ahli'), ?, ?)`,
    )
    .bind(p.id, p.userId, p.staffId, p.phone)
}

export async function markEmailVerified(db: D1Database, userId: string): Promise<void> {
  await db.prepare('UPDATE profiles SET email_verified = 1 WHERE user_id = ?').bind(userId).run()
}

export function gateState(db: D1Database, userId: string) {
  return db.prepare('SELECT status, email_verified FROM profiles WHERE user_id = ?').bind(userId).first<{ status: string; email_verified: number }>()
}

export async function isBanned(db: D1Database, userId: string, now: number): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 FROM profiles WHERE user_id = ? AND banned_at IS NOT NULL AND (ban_expires_at IS NULL OR ban_expires_at > ?)')
    .bind(userId, now)
    .first()
  return row !== null
}

// ---- self-service (/me) ----

export type SelfFields = Partial<Record<'display_name' | 'phone' | 'emergency_contact_name' | 'emergency_contact_phone' | 'health_notes', string>>

// Medan tiada = kekal (COALESCE); CAS updated_at.
export function updateSelfStmt(db: D1Database, userId: string, f: SelfFields, expectedUpdatedAt: number, now: number) {
  return db
    .prepare(
      `UPDATE profiles SET
         display_name = COALESCE(?, display_name), phone = COALESCE(?, phone),
         emergency_contact_name = COALESCE(?, emergency_contact_name),
         emergency_contact_phone = COALESCE(?, emergency_contact_phone),
         health_notes = COALESCE(?, health_notes), updated_at = ?
       WHERE user_id = ? AND updated_at = ?
       RETURNING member_id, display_name, phone, avatar_r2_key, updated_at`,
    )
    .bind(f.display_name ?? null, f.phone ?? null, f.emergency_contact_name ?? null, f.emergency_contact_phone ?? null, f.health_notes ?? null, now, userId, expectedUpdatedAt)
}

export const setAvatarStmt = (db: D1Database, userId: string, key: string | null, now: number) =>
  db.prepare('UPDATE profiles SET avatar_r2_key = ?, updated_at = ? WHERE user_id = ? RETURNING member_id, display_name, phone, avatar_r2_key, updated_at').bind(key, now, userId)

// ---- pengurusan (dipanggil oleh features/members, bans) ----

// Guard `status <> ?` → permintaan serentak: yang kalah dapat 0 baris.
export const setStatusStmt = (db: D1Database, userId: string, status: 'approved' | 'rejected', by: string, now: number) =>
  db
    .prepare('UPDATE profiles SET status = ?, approved_by = ?, approved_at = ? WHERE user_id = ? AND status <> ? RETURNING user_id, status, approved_by, approved_at')
    .bind(status, by, now, userId, status)

const RETURN_ALL = 'RETURNING *'

export const setRoleStmt = (db: D1Database, userId: string, roleId: number, expected: number, now: number) =>
  db.prepare(`UPDATE profiles SET role_id = ?, updated_at = ? WHERE user_id = ? AND updated_at = ? ${RETURN_ALL}`).bind(roleId, now, userId, expected)

export const setActiveStmt = (db: D1Database, userId: string, isActive: boolean, expected: number, now: number) =>
  db.prepare(`UPDATE profiles SET is_active = ?, updated_at = ? WHERE user_id = ? AND updated_at = ? ${RETURN_ALL}`).bind(isActive ? 1 : 0, now, userId, expected)

export const setDepartmentStmt = (db: D1Database, userId: string, code: string | null, position: string | null, expected: number, now: number) =>
  db
    .prepare(`UPDATE profiles SET department_code = ?, position = ?, updated_at = ? WHERE user_id = ? AND updated_at = ? ${RETURN_ALL}`)
    .bind(code, position, now, userId, expected)

// Pengesahan pertama sahaja (guard staff_id_verified_at IS NULL); member_id
// sedia ada TIDAK ditulis semula.
export const verifyStaffIdStmt = (db: D1Database, p: { userId: string; staffId: string | null; by: string; memberId: string | null; now: number }) =>
  db
    .prepare(
      `UPDATE profiles SET staff_id = COALESCE(?, staff_id), staff_id_verified_at = ?, staff_id_verified_by = ?,
         member_id = COALESCE(member_id, ?), updated_at = ?
       WHERE user_id = ? AND staff_id_verified_at IS NULL ${RETURN_ALL}`,
    )
    .bind(p.staffId, p.now, p.by, p.memberId, p.now, p.userId)

export const correctStaffIdStmt = (db: D1Database, userId: string, staffId: string, now: number) =>
  db.prepare(`UPDATE profiles SET staff_id = ?, updated_at = ? WHERE user_id = ? ${RETURN_ALL}`).bind(staffId, now, userId)

// Hanya member_id yang SUDAH wujud (bukan laluan pintas pengesahan).
export const correctMemberIdStmt = (db: D1Database, userId: string, memberId: string, now: number) =>
  db.prepare(`UPDATE profiles SET member_id = ?, updated_at = ? WHERE user_id = ? AND member_id IS NOT NULL ${RETURN_ALL}`).bind(memberId, now, userId)

// Ban baharu dibenarkan bila tiada ban AKTIF (ban tamat boleh diganti -
// marc_go menolak kerana guard `banned_at IS NULL` sahaja).
export const banStmt = (db: D1Database, p: { userId: string; expiresAt: number | null; reason: string; by: string; now: number }) =>
  db
    .prepare(
      `UPDATE profiles SET banned_at = ?, ban_expires_at = ?, ban_reason = ?, banned_by = ?, updated_at = ?
       WHERE user_id = ? AND (banned_at IS NULL OR (ban_expires_at IS NOT NULL AND ban_expires_at <= ?)) ${RETURN_ALL}`,
    )
    .bind(p.now, p.expiresAt, p.reason, p.by, p.now, p.userId, p.now)

export const unbanStmt = (db: D1Database, userId: string, now: number) =>
  db
    .prepare('UPDATE profiles SET banned_at = NULL, ban_expires_at = NULL, ban_reason = NULL, banned_by = NULL, updated_at = ? WHERE user_id = ? AND banned_at IS NOT NULL RETURNING user_id')
    .bind(now, userId)

export async function listBanned(db: D1Database, now: number) {
  const { results } = await db
    .prepare(
      `${FULL} WHERE p.banned_at IS NOT NULL AND (p.ban_expires_at IS NULL OR p.ban_expires_at > ?)
       ORDER BY p.ban_expires_at IS NOT NULL, p.ban_expires_at, p.banned_at DESC`,
    )
    .bind(now)
    .all<MemberRow>()
  return results
}

// ---- telegram ----

export async function userIdByTelegramChat(db: D1Database, chatId: number): Promise<string | null> {
  const row = await db.prepare('SELECT user_id FROM profiles WHERE telegram_chat_id = ?').bind(chatId).first<{ user_id: string }>()
  return row?.user_id ?? null
}

export async function setTelegram(db: D1Database, userId: string, chatId: number, username: string | null, now: number): Promise<void> {
  await db.prepare('UPDATE profiles SET telegram_chat_id = ?, telegram_username = ?, telegram_linked_at = ? WHERE user_id = ?').bind(chatId, username, now, userId).run()
}

export async function clearTelegram(db: D1Database, userId: string): Promise<void> {
  await db.prepare('UPDATE profiles SET telegram_chat_id = NULL, telegram_username = NULL, telegram_linked_at = NULL WHERE user_id = ?').bind(userId).run()
}

// ---- member_addresses ----

export type AddressRow = {
  id: string
  user_id: string
  label: string | null
  is_default: number
  address_type: string
  unit_number: string | null
  floor: string | null
  block: string | null
  street: string | null
  township: string | null
  city: string
  postcode: string
  state: string
  created_at: number
  updated_at: number
}

export type AddressFields = {
  label: string | null
  address_type: string
  unit_number: string | null
  floor: string | null
  block: string | null
  street: string | null
  township: string | null
  city: string
  postcode: string
  state: string
}

export const MAX_ADDRESSES = 3

export async function listAddresses(db: D1Database, userId: string): Promise<AddressRow[]> {
  const { results } = await db.prepare('SELECT * FROM member_addresses WHERE user_id = ? ORDER BY is_default DESC, created_at ASC').bind(userId).all<AddressRow>()
  return results
}

// SATU batch, guard kiraan dalam setiap statement: had 3 dan "tepat satu
// default" kekal walaupun permintaan serentak (marc_go: kira-dahulu dalam
// transaksi READ COMMITTED - dua permintaan boleh lulus bersama).
// Alamat pertama sentiasa default.
export async function createAddress(db: D1Database, p: { id: string; userId: string; isDefault: boolean; f: AddressFields; now: number }): Promise<AddressRow | null> {
  const count = `(SELECT COUNT(*) FROM member_addresses WHERE user_id = ?)`
  const [, inserted] = await db.batch([
    db
      .prepare(`UPDATE member_addresses SET is_default = 0, updated_at = ? WHERE user_id = ? AND is_default = 1 AND ? = 1 AND ${count} < ?`)
      .bind(p.now, p.userId, p.isDefault ? 1 : 0, p.userId, MAX_ADDRESSES),
    db
      .prepare(
        `INSERT INTO member_addresses (id, user_id, label, is_default, address_type, unit_number, floor, block, street, township, city, postcode, state, created_at, updated_at)
         SELECT ?, ?, ?, CASE WHEN ${count} = 0 THEN 1 ELSE ? END, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE ${count} < ? RETURNING *`,
      )
      .bind(p.id, p.userId, p.f.label, p.userId, p.isDefault ? 1 : 0, p.f.address_type, p.f.unit_number, p.f.floor, p.f.block, p.f.street, p.f.township, p.f.city, p.f.postcode, p.f.state, p.now, p.now, p.userId, MAX_ADDRESSES),
  ])
  return (inserted?.results[0] as AddressRow | undefined) ?? null
}

// Medan tiada = kekal. makeDefault: nyahtetap yang lama DAHULU (indeks unik
// separa), semua dalam satu batch.
export async function updateAddress(db: D1Database, p: { id: string; userId: string; f: Partial<AddressFields>; makeDefault: boolean; now: number }): Promise<AddressRow | null> {
  const owned = 'EXISTS (SELECT 1 FROM member_addresses WHERE id = ? AND user_id = ?)'
  const stmts = [
    db
      .prepare(
        `UPDATE member_addresses SET label = COALESCE(?, label), address_type = COALESCE(?, address_type),
           unit_number = COALESCE(?, unit_number), floor = COALESCE(?, floor), block = COALESCE(?, block),
           street = COALESCE(?, street), township = COALESCE(?, township), city = COALESCE(?, city),
           postcode = COALESCE(?, postcode), state = COALESCE(?, state), updated_at = ?
         WHERE id = ? AND user_id = ? RETURNING *`,
      )
      .bind(p.f.label ?? null, p.f.address_type ?? null, p.f.unit_number ?? null, p.f.floor ?? null, p.f.block ?? null, p.f.street ?? null, p.f.township ?? null, p.f.city ?? null, p.f.postcode ?? null, p.f.state ?? null, p.now, p.id, p.userId),
  ]
  if (p.makeDefault) {
    stmts.push(
      db.prepare(`UPDATE member_addresses SET is_default = 0, updated_at = ? WHERE user_id = ? AND id <> ? AND is_default = 1 AND ${owned}`).bind(p.now, p.userId, p.id, p.id, p.userId),
      db.prepare('UPDATE member_addresses SET is_default = 1, updated_at = ? WHERE id = ? AND user_id = ? RETURNING *').bind(p.now, p.id, p.userId),
    )
  }
  const results = await db.batch(stmts)
  return (results.at(-1)?.results[0] as AddressRow | undefined) ?? null
}

// Padam + promosi alamat TERTUA bila tiada default tinggal (invarian, bukan
// "adakah yang dipadam itu default") - satu batch.
export async function deleteAddress(db: D1Database, id: string, userId: string, now: number): Promise<boolean> {
  const [deleted] = await db.batch([
    db.prepare('DELETE FROM member_addresses WHERE id = ? AND user_id = ? RETURNING id').bind(id, userId),
    db
      .prepare(
        `UPDATE member_addresses SET is_default = 1, updated_at = ?
         WHERE id = (SELECT id FROM member_addresses WHERE user_id = ? ORDER BY created_at ASC LIMIT 1)
           AND NOT EXISTS (SELECT 1 FROM member_addresses WHERE user_id = ? AND is_default = 1)`,
      )
      .bind(now, userId, userId),
  ])
  return (deleted?.results.length ?? 0) > 0
}

// ---- account_deletion_requests ----

export type DeletionRequestRow = { status: string; requested_at: number }

// Idempoten: INSERT OR IGNORE; baris baharu = RETURNING, sedia ada = tiada.
export const createDeletionRequestStmt = (db: D1Database, id: string, userId: string, now: number) =>
  db.prepare('INSERT INTO account_deletion_requests (id, user_id, requested_at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO NOTHING RETURNING status, requested_at').bind(id, userId, now)

export const getDeletionRequest = (db: D1Database, userId: string) =>
  db.prepare('SELECT status, requested_at FROM account_deletion_requests WHERE user_id = ?').bind(userId).first<DeletionRequestRow>()

export type DeletionListRow = { user_id: string; member_id: string | null; display_name: string | null; email: string; role_key: string; account_status: string; status: string; requested_at: number; completed_at: number | null }

export async function listDeletionRequests(db: D1Database): Promise<DeletionListRow[]> {
  const { results } = await db
    .prepare(
      // cross-read: users, roles
      `SELECT adr.user_id, p.member_id, p.display_name, u.email, r.key AS role_key, p.status AS account_status,
         adr.status, adr.requested_at, adr.completed_at
       FROM account_deletion_requests adr JOIN users u ON u.id = adr.user_id
       JOIN profiles p ON p.user_id = u.id JOIN roles r ON r.id = p.role_id
       ORDER BY adr.requested_at ASC`,
    )
    .all<DeletionListRow>()
  return results
}

// Sasaran pemadaman terus: semua kecuali superadmin; NULL nama terakhir.
export async function listDeletionTargets(db: D1Database): Promise<DeletionListRow[]> {
  const { results } = await db
    .prepare(
      // cross-read: users, roles
      `SELECT u.id AS user_id, p.member_id, p.display_name, u.email, r.key AS role_key, p.status AS account_status,
         '' AS status, u.created_at AS requested_at, NULL AS completed_at
       FROM users u JOIN profiles p ON p.user_id = u.id JOIN roles r ON r.id = p.role_id
       WHERE r.key <> 'superadmin'
       ORDER BY p.display_name IS NULL, p.display_name, u.email`,
    )
    .all<DeletionListRow>()
  return results
}

// Syarat SQL untuk guard batch pemadaman (features/account-lifecycle).
export const PENDING_DELETION_REQUEST_SQL = "EXISTS (SELECT 1 FROM account_deletion_requests WHERE user_id = ? AND status = 'pending')"

export async function isManagement(db: D1Database, userId: string): Promise<boolean> {
  // cross-read: roles
  const row = await db.prepare(`SELECT r.category FROM profiles p JOIN roles r ON r.id = p.role_id WHERE p.user_id = ?`).bind(userId).first<{ category: string }>()
  return row?.category === 'management'
}

// rank(pengguna) >= rank(peranan `roleKey`) - pariti authz.IsAtLeastRole.
export async function atLeastRole(db: D1Database, userId: string, roleKey: string): Promise<boolean> {
  // cross-read: roles
  const row = await db
    .prepare('SELECT r.rank >= (SELECT rank FROM roles WHERE key = ?) AS ok FROM profiles p JOIN roles r ON r.id = p.role_id WHERE p.user_id = ?')
    .bind(roleKey, userId)
    .first<{ ok: number }>()
  return row?.ok === 1
}

// Penerima siaran seluruh kelab (aktiviti diterbitkan).
export async function listApprovedUserIds(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare("SELECT user_id FROM profiles WHERE status = 'approved'").all<{ user_id: string }>()
  return results.map((r) => r.user_id)
}
