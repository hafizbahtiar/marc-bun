// Mesej queue `JOBS`. Setiap jenis baharu = satu ahli kesatuan di sini + satu
// pengendali dalam peta `src/index.ts`. Fail ini tidak mengimport feature.
import { chunk } from './db'

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
  // Push OneSignal. Tiada = baris notifikasi sahaja (pariti marc_go:
  // member_pending/approved/rejected tidak menghantar push).
  push?: { title: string; message: string }
  // Pelaku = penerima sendiri (peringatan sistem; pariti activitylifecycle
  // marc_go). `actorId` diabaikan dan penerima tidak ditapis.
  selfActor?: true
}

export type JobMessage = NotifyMessage

export type JobType = JobMessage['type']

export type Enqueue = (env: CloudflareBindings, message: JobMessage) => Promise<void>

export const enqueue: Enqueue = async (env, message) => {
  await env.JOBS.send(message)
}

// Satu peristiwa kepada ramai penerima: dipecah ≤100 setiap mesej.
export async function enqueueNotify(send: Enqueue, env: CloudflareBindings, msg: Omit<NotifyMessage, 'type' | 'recipientIds'>, recipientIds: string[]) {
  for (const part of chunk(recipientIds, 1)) await send(env, { type: 'notify', ...msg, recipientIds: part })
}

// Satu job cron. Mesti idempoten: dua larian serentak = hasil sama.
export type CronJob = (env: CloudflareBindings, scheduledTime: number) => Promise<void>

export type JobHandler = (env: CloudflareBindings, message: JobMessage) => Promise<void>
