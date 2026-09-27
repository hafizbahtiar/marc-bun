// Job `lifecycle` (setiap jam) - pariti internal/activitylifecycle marc_go.
import { enqueue, enqueueNotify, type CronJob } from '../../shared/jobs'
import * as repo from './repo'

export const lifecycle: CronJob = async (env, scheduledTime) => {
  const db = env.DB
  // 1. Peringatan H-1: tuntut dahulu (satu statement), baru gilir. Yang kalah
  //    perlumbaan tidak menghantar. Gagal gilir selepas tuntut = peringatan
  //    hilang (sama seperti marc_go).
  for (const a of await repo.claimReminders(db, scheduledTime)) {
    await enqueueNotify(
      enqueue,
      env,
      { kind: 'activity_reminder', actorId: '', selfActor: true, activityId: a.id, push: { title: 'Peringatan Aktiviti', message: `${a.title} bermula tidak lama lagi. Jangan terlepas!` } },
      await repo.registrantIds(db, a.id),
    ).catch((err) => console.error(JSON.stringify({ level: 'error', msg: 'lifecycle: gilir peringatan gagal', activity: a.id, error: String(err) })))
  }
  // 2. Auto-selesai.
  await repo.completeEnded(db, scheduledTime)
}
