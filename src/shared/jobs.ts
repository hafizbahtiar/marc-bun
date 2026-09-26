// Mesej queue `JOBS`. Setiap jenis baharu = satu ahli kesatuan di sini + satu
// pengendali dalam peta `src/index.ts`. Fail ini tidak mengimport feature.

// Sama dengan CHECK notifications.type (migrasi notifications).
export type NotificationKind =
  | 'post_like'
  | 'post_comment'
  | 'comment_like'
  | 'member_pending'
  | 'member_approved'
  | 'member_rejected'
  | 'activity_published'
  | 'activity_cancelled'
  | 'certificate_ready'
  | 'activity_reminder'

// Satu mesej = satu peristiwa, ≤100 penerima (pengeluar memecah). Consumer
// (features/notifications) menulis baris + menghantar push.
export type NotifyMessage = {
  type: 'notify'
  kind: NotificationKind
  actorId: string
  recipientIds: string[]
  postId?: string
  commentId?: string
  activityId?: string
  certificateId?: string
}

export type JobMessage = NotifyMessage

export type JobType = JobMessage['type']

export type Enqueue = (env: CloudflareBindings, message: JobMessage) => Promise<void>

export const enqueue: Enqueue = async (env, message) => {
  await env.JOBS.send(message)
}

// Satu job cron. Mesti idempoten: dua larian serentak = hasil sama.
export type CronJob = (env: CloudflareBindings, scheduledTime: number) => Promise<void>

export type JobHandler = (env: CloudflareBindings, message: JobMessage) => Promise<void>
