// SQL milik features/uploads: pending_uploads, deleted_uploads.

export async function createPending(db: D1Database, key: string, userId: string, now: number): Promise<void> {
  await db.prepare('INSERT INTO pending_uploads (r2_key, user_id, created_at) VALUES (?, ?, ?)').bind(key, userId, now).run()
}

export async function ownsPending(db: D1Database, key: string, userId: string): Promise<boolean> {
  return (await db.prepare('SELECT 1 FROM pending_uploads WHERE r2_key = ? AND user_id = ?').bind(key, userId).first()) !== null
}

// Kunci sudah dilampir (post/avatar) - keluarkan dari "belum dilampir" supaya
// reaper tidak memadamnya. Untuk db.batch() pemanggil.
export const deletePendingStmt = (db: D1Database, key: string, userId: string) =>
  db.prepare('DELETE FROM pending_uploads WHERE r2_key = ? AND user_id = ?').bind(key, userId)

// Gilir satu kunci untuk dipadam oleh reaper.
export const enqueueDeleteStmt = (db: D1Database, key: string, reason: string) =>
  db.prepare('INSERT INTO deleted_uploads (r2_key, reason) VALUES (?, ?) ON CONFLICT (r2_key) DO NOTHING').bind(key, reason)

// Gilir SEMUA gambar sebuah post (padam lembut) - satu statement.
export const enqueuePostImagesStmt = (db: D1Database, postId: string, guard: { sql: string; params: unknown[] }) =>
  db
    .prepare(
      // cross-read: post_images
      `INSERT INTO deleted_uploads (r2_key, reason)
       SELECT r2_key, 'post_deleted' FROM post_images WHERE post_id = ? AND ${guard.sql}
       ON CONFLICT (r2_key) DO NOTHING`,
    )
    .bind(postId, ...guard.params)

// Gilir SEMUA objek R2 milik pengguna dalam SATU statement (tiada had parameter).
export const enqueueUserObjectsStmt = (db: D1Database, userId: string, reason: string, guard: { sql: string; params: unknown[] }) =>
  db
    .prepare(
      // cross-read: profiles (avatar), post_images + posts (gambar post)
      `INSERT INTO deleted_uploads (r2_key, reason)
       SELECT k, ? FROM (
         SELECT avatar_r2_key AS k FROM profiles WHERE user_id = ? AND avatar_r2_key IS NOT NULL
         UNION SELECT r2_key FROM pending_uploads WHERE user_id = ?
         UNION SELECT pi.r2_key FROM post_images pi JOIN posts p ON p.id = pi.post_id WHERE p.author_id = ?
       ) WHERE ${guard.sql}
       ON CONFLICT (r2_key) DO NOTHING`,
    )
    .bind(reason, userId, userId, userId, ...guard.params)

// ---- reaper ----

// Gambar post yang sudah dipadam lembut tetapi belum digilir (termasuk data lama).
export async function enqueueOrphanedPostImages(db: D1Database, limit: number): Promise<number> {
  const { meta } = await db
    .prepare(
      // cross-read: post_images, posts
      `INSERT INTO deleted_uploads (r2_key, reason)
       SELECT pi.r2_key, 'post_deleted' FROM post_images pi JOIN posts p ON p.id = pi.post_id
       WHERE p.deleted_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM deleted_uploads d WHERE d.r2_key = pi.r2_key)
       LIMIT ?
       ON CONFLICT (r2_key) DO NOTHING`,
    )
    .bind(limit)
    .run()
  return meta.changes
}

// Upload yang tidak pernah dilampir selepas `cutoff` → gilir padam + keluarkan.
export async function sweepAbandoned(db: D1Database, cutoff: number, limit: number): Promise<number> {
  const stale = `SELECT pu.r2_key FROM pending_uploads pu
    WHERE pu.created_at < ?
      AND NOT EXISTS (SELECT 1 FROM post_images pi WHERE pi.r2_key = pu.r2_key)
      AND NOT EXISTS (SELECT 1 FROM profiles pr WHERE pr.avatar_r2_key = pu.r2_key)
    ORDER BY pu.created_at LIMIT ?`
  const [queued] = await db.batch([
    // cross-read: post_images, profiles (kunci yang sudah dilampir tidak disentuh)
    db.prepare(`INSERT INTO deleted_uploads (r2_key, reason) SELECT r2_key, 'upload_abandoned' FROM (${stale}) WHERE 1 ON CONFLICT (r2_key) DO NOTHING`).bind(cutoff, limit),
    db.prepare(`DELETE FROM pending_uploads WHERE r2_key IN (SELECT r2_key FROM deleted_uploads WHERE reason = 'upload_abandoned' AND deleted_at IS NULL)`),
  ])
  return queued?.meta.changes ?? 0
}

export async function dueDeletes(db: D1Database, now: number, limit: number) {
  const { results } = await db
    .prepare('SELECT r2_key, attempts FROM deleted_uploads WHERE deleted_at IS NULL AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?')
    .bind(now, limit)
    .all<{ r2_key: string; attempts: number }>()
  return results
}

export async function markDeleted(db: D1Database, key: string, now: number): Promise<void> {
  await db.prepare('UPDATE deleted_uploads SET deleted_at = ? WHERE r2_key = ?').bind(now, key).run()
}

// Backoff 2^attempts minit, maks 60 minit (pariti marc_go).
export async function markFailed(db: D1Database, key: string, error: string, now: number): Promise<void> {
  await db
    .prepare('UPDATE deleted_uploads SET attempts = attempts + 1, last_error = ?, next_attempt_at = ? + MIN(1 << attempts, 60) * 60000 WHERE r2_key = ?')
    .bind(error.slice(0, 500), now, key)
    .run()
}
