// SQL milik features/uploads: pending_uploads, deleted_uploads. Fasa 3 hanya
// perlukan gilir padam; presign/pengesahan/reaper datang dalam Fasa 4.

// Gilir satu kunci untuk dipadam oleh reaper (satu-satunya pemadam objek R2).
export const enqueueDeleteStmt = (db: D1Database, key: string, reason: string) =>
  db.prepare('INSERT INTO deleted_uploads (r2_key, reason) VALUES (?, ?) ON CONFLICT (r2_key) DO NOTHING').bind(key, reason)

// Gilir SEMUA objek R2 milik pengguna dalam SATU statement (tiada had
// parameter). `guard` = syarat SQL batch pemanggil.
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
