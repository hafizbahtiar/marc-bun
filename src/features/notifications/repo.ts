// SQL milik features/notifications: notifications, device_tokens.
// Semua pertanyaan diskop recipient_id/user_id daripada token.
import type { NotifyMessage } from '../../shared/jobs'

export type NotificationRow = {
  id: string
  actor_id: string
  type: string
  post_id: string | null
  comment_id: string | null
  activity_id: string | null
  certificate_id: string | null
  read_at: number | null
  created_at: number
}

const IN = 'IN (SELECT value FROM json_each(?))'

export async function list(db: D1Database, recipientId: string, limit: number, after: { createdAt: number; id: string } | null): Promise<NotificationRow[]> {
  const where = after ? 'AND (created_at, id) < (?, ?)' : ''
  const params = after ? [recipientId, after.createdAt, after.id, limit] : [recipientId, limit]
  const { results } = await db
    .prepare(
      `SELECT id, actor_id, type, post_id, comment_id, activity_id, certificate_id, read_at, created_at
       FROM notifications WHERE recipient_id = ? ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .bind(...params)
    .all<NotificationRow>()
  return results
}

export const markRead = (db: D1Database, id: string, recipientId: string, now: number) =>
  db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND recipient_id = ? AND read_at IS NULL').bind(now, id, recipientId).run()

export const markAllRead = (db: D1Database, recipientId: string, now: number) =>
  db.prepare('UPDATE notifications SET read_at = ? WHERE recipient_id = ? AND read_at IS NULL').bind(now, recipientId).run()

export const remove = (db: D1Database, id: string, recipientId: string) => db.prepare('DELETE FROM notifications WHERE id = ? AND recipient_id = ?').bind(id, recipientId).run()

export const removeRead = (db: D1Database, recipientId: string) => db.prepare('DELETE FROM notifications WHERE recipient_id = ? AND read_at IS NOT NULL').bind(recipientId).run()

export const removeSelected = (db: D1Database, recipientId: string, ids: string[]) =>
  db.prepare(`DELETE FROM notifications WHERE recipient_id = ? AND id ${IN}`).bind(recipientId, JSON.stringify(ids)).run()

// Satu kenyataan untuk ≤100 penerima (pasangan [id, penerima] sebagai JSON).
// cross-read: users - penerima/pelaku yang sudah dipadam dilangkau, bukan
// melanggar FK dan membuat mesej di-retry selama-lamanya.
export function insertMany(db: D1Database, msg: NotifyMessage, recipientIds: string[], now: number) {
  const pairs = JSON.stringify(recipientIds.map((r) => [crypto.randomUUID(), r]))
  return db
    .prepare(
      `INSERT INTO notifications (id, recipient_id, actor_id, type, post_id, comment_id, activity_id, certificate_id, created_at)
       SELECT j.value ->> '$[0]', u.id, ?, ?, ?, ?, ?, ?, ?
       FROM json_each(?) j JOIN users u ON u.id = j.value ->> '$[1]'
       WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)`,
    )
    .bind(msg.actorId, msg.kind, msg.postId ?? null, msg.commentId ?? null, msg.activityId ?? null, msg.certificateId ?? null, now, pairs, msg.actorId)
    .run()
}

// ---- device_tokens ----

// Konflik onesignal_id milik pengguna LAIN: WHERE gagal → tiada baris → 409.
export async function upsertToken(db: D1Database, userId: string, onesignalId: string, platform: string | null, now: number): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO device_tokens (id, user_id, onesignal_id, platform, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (onesignal_id) DO UPDATE SET platform = excluded.platform, updated_at = excluded.updated_at
       WHERE device_tokens.user_id = excluded.user_id
       RETURNING id`,
    )
    .bind(crypto.randomUUID(), userId, onesignalId, platform, now, now)
    .first()
  return row !== null
}

export const removeToken = (db: D1Database, id: string, userId: string) => db.prepare('DELETE FROM device_tokens WHERE id = ? AND user_id = ?').bind(id, userId).run()

export const removeTokenByOnesignal = (db: D1Database, onesignalId: string, userId: string) =>
  db.prepare('DELETE FROM device_tokens WHERE onesignal_id = ? AND user_id = ?').bind(onesignalId, userId).run()

export async function playerIds(db: D1Database, userIds: string[]): Promise<string[]> {
  const { results } = await db.prepare(`SELECT onesignal_id FROM device_tokens WHERE user_id ${IN}`).bind(JSON.stringify(userIds)).all<{ onesignal_id: string }>()
  return results.map((r) => r.onesignal_id)
}
