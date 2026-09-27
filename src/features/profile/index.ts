// API awam features/profile. SATU-SATUNYA penulis `profiles` - feature lain
// memanggil operasi di sini (kebanyakannya statement untuk db.batch mereka).
export { requireApproved, requireMinRole, requireVerified } from './middleware'
export {
  banStmt,
  clearTelegram,
  correctMemberIdStmt,
  correctStaffIdStmt,
  countByRoleKey,
  createInitialStmt,
  getDeletionRequest,
  getMember,
  isBanned,
  isManagement,
  listAddresses,
  listBanned,
  listDeletionRequests,
  listDeletionTargets,
  listManagementUserIds,
  listVisible,
  markEmailVerified,
  PENDING_DELETION_REQUEST_SQL,
  setActiveStmt,
  setDepartmentStmt,
  setRoleStmt,
  setStatusStmt,
  setTelegram,
  unbanStmt,
  userIdByTelegramChat,
  verifyStaffIdStmt,
  type AddressRow,
  type MemberRow,
} from './repo'
export { addressDto } from './dto'
export { profileRoutes } from './routes'
