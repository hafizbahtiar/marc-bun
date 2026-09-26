// Mesej queue `JOBS`. Setiap jenis baharu = satu ahli kesatuan di sini + satu
// pengendali dalam peta `src/index.ts`. Fail ini tidak mengimport feature.
export type JobMessage = { type: 'notify'; [key: string]: unknown }

export type JobType = JobMessage['type']

export async function enqueue(env: CloudflareBindings, message: JobMessage): Promise<void> {
  await env.JOBS.send(message)
}

// Satu job cron. Mesti idempoten: dua larian serentak = hasil sama.
export type CronJob = (env: CloudflareBindings, scheduledTime: number) => Promise<void>

export type JobHandler = (env: CloudflareBindings, message: JobMessage) => Promise<void>
