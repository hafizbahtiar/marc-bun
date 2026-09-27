// Composition root: tiga entry point Worker, peta job, dan (kelak) sambungan port.
import { app } from './app'
import { notify } from './features/notifications'
import { reaper } from './features/uploads'
import type { CronJob, JobHandler, JobType } from './shared/jobs'

// Jadual mesti sama dengan `triggers.crons` dalam wrangler.jsonc.
// Tambah job = satu entri: '*/15 * * * *': [uploads.reaper, payments.activitySweep, …]
export const cronJobs: Record<string, CronJob[]> = {
  '*/15 * * * *': [reaper],
  '*/30 * * * *': [],
  '0 * * * *': [],
  '0 19 * * *': [],
}

// Tambah jenis mesej = satu entri: notify: notifications.consume
export const jobHandlers: Partial<Record<JobType, JobHandler>> = { notify }

export default {
  fetch: app.fetch,

  async scheduled(controller, env, ctx) {
    const jobs = cronJobs[controller.cron] ?? []
    // Setiap job bebas: satu yang gagal tidak menghentikan yang lain.
    const results = await Promise.allSettled(jobs.map((job) => job(env, controller.scheduledTime)))
    for (const r of results) {
      if (r.status === 'rejected') console.error(JSON.stringify({ level: 'error', cron: controller.cron, error: String(r.reason) }))
    }
    if (!(controller.cron in cronJobs)) console.error(JSON.stringify({ level: 'error', msg: 'cron tanpa peta', cron: controller.cron }))
    void ctx
  },

  async queue(batch, env) {
    for (const msg of batch.messages) {
      const handler = jobHandlers[msg.body.type]
      if (!handler) {
        // Jenis tidak dikenali tidak akan berjaya dengan retry - buang.
        console.error(JSON.stringify({ level: 'error', msg: 'jenis mesej tidak dikenali', type: msg.body.type }))
        msg.ack()
        continue
      }
      try {
        await handler(env, msg.body)
        msg.ack()
      } catch (err) {
        console.error(JSON.stringify({ level: 'error', type: msg.body.type, error: String(err) }))
        msg.retry()
      }
    }
  },
} satisfies ExportedHandler<CloudflareBindings, import('./shared/jobs').JobMessage>
