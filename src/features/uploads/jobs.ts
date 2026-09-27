// Cron 15 minit: satu-satunya kod yang MEMADAM objek R2. Tiada kunci teragih:
// R2 delete idempoten, jadi dua larian bertindih = hasil sama.
import type { CronJob } from '../../shared/jobs'
import * as repo from './repo'

const BATCH = 50 // kecil sengaja - pembersihan tidak mendesak
const ABANDONED_AFTER = 6 * 60 * 60 * 1000 // jauh lebih lama daripada masa mengarang post

export const reaper: CronJob = async (env, now) => {
  await repo.enqueueOrphanedPostImages(env.DB, BATCH)
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
