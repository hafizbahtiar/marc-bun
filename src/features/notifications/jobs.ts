// Consumer queue `notify`: baris DB dahulu, kemudian push OneSignal.
import { getConfig } from '../../shared/config'
import type { JobHandler } from '../../shared/jobs'
import * as repo from './repo'

const ONESIGNAL_URL = 'https://onesignal.com/api/v1/notifications'

export const notify: JobHandler = async (env, msg) => {
  const recipients = [...new Set(msg.recipientIds)].filter((id) => msg.selfActor || msg.includeActor || id !== msg.actorId)
  if (!recipients.length) return
  // Gagal DB = lempar → queue retry (kenyataan tunggal: tiada separuh tulis).
  await repo.insertMany(env.DB, msg, recipients, Date.now())

  const config = getConfig(env)
  if (!msg.push || !config.ONESIGNAL_APP_ID || !config.ONESIGNAL_API_KEY) return
  // Gagal push = log sahaja; retry akan menduplikasi baris notifikasi.
  try {
    const players = await repo.playerIds(env.DB, recipients)
    if (!players.length) return
    const res = await fetch(ONESIGNAL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${config.ONESIGNAL_API_KEY}` },
      body: JSON.stringify({ app_id: config.ONESIGNAL_APP_ID, include_player_ids: players, headings: { en: msg.push.title }, contents: { en: msg.push.message } }),
    })
    if (!res.ok) throw new Error(`onesignal: status ${res.status}`)
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'push gagal', kind: msg.kind, error: String(err) }))
  }
}
