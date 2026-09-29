// Cron 15 minit: satu-satunya kod yang MEMADAM objek R2. Tiada kunci teragih:
// R2 delete idempoten, jadi dua larian bertindih = hasil sama.
import type { CronJob } from '../../shared/jobs'
import * as repo from './repo'
import { MAX_IMAGE_BYTES } from './service'

const BATCH = 50 // kecil sengaja - pembersihan tidak mendesak
const ABANDONED_AFTER = 6 * 60 * 60 * 1000 // jauh lebih lama daripada masa mengarang post
const MIN = 60_000
// URL presign luput dalam 5 min - selepas 10 min upload sudah selesai. Tetingkap
// 15 min (= selang cron) → setiap upload tertunggak di-head tepat sekali.
const SIZE_CHECK_FROM = 25 * MIN
const SIZE_CHECK_TO = 10 * MIN

export const reaper: CronJob = async (env, now) => {
  await repo.enqueueOrphanedPostImages(env.DB, BATCH)
  // URL presign tidak mengehadkan saiz: objek > 5 MB yang belum dilampir digilir
  // pada larian pertama selepas 10 min dan dipadam larian berikutnya (~40 min,
  // bukan 6 j). (Kitaran hayat R2 pada `posts/` TIDAK
  // selamat - gambar yang sudah dilampir juga di bawah prefix itu.)
  for (const key of await repo.pendingBetween(env.DB, now - SIZE_CHECK_FROM, now - SIZE_CHECK_TO, BATCH)) {
    const obj = await env.BUCKET.head(key).catch(() => null)
    if (obj && obj.size > MAX_IMAGE_BYTES) await env.DB.batch(repo.discardPendingStmts(env.DB, key, 'upload_oversized'))
  }
  await repo.sweepAbandoned(env.DB, now - ABANDONED_AFTER, BATCH)
  for (const item of await repo.dueDeletes(env.DB, now, BATCH)) {
    try {
      await env.BUCKET.delete(item.r2_key)
      await repo.markDeleted(env.DB, item.r2_key, now)
    } catch (err) {
      await repo.markFailed(env.DB, item.r2_key, String(err), now)
    }
  }
}
