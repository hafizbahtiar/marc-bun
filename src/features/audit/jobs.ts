// Job `retention` (harian, 03:00 MYT) - pariti internal/retention marc_go.
// `0` hari = sapuan dimatikan. Redaksi PII didahulukan.
import { prunePaymentLogsStmt } from '../payments'
import { pruneTombstonesStmt } from '../uploads'
import { getConfig } from '../../shared/config'
import type { CronJob } from '../../shared/jobs'
import * as repo from './repo'

const DAY = 86_400_000
export const CHUNK = 1000
// ponytail: had pusingan setiap sapuan setiap larian; baki disambung esok.
const MAX_ROUNDS = 20

type Sweep = (db: D1Database, before: number, limit: number) => D1PreparedStatement

async function sweep(db: D1Database, name: string, stmt: Sweep, days: number, now: number): Promise<number> {
  if (days <= 0) return 0
  let total = 0
  try {
    for (let i = 0; i < MAX_ROUNDS; i++) {
      const n = (await stmt(db, now - days * DAY, CHUNK).run()).meta.changes
      total += n
      if (n < CHUNK) break
    }
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: `retention: ${name} gagal`, error: String(err) }))
  }
  if (total) console.log(JSON.stringify({ level: 'info', msg: `retention: ${name}`, rows: total }))
  return total
}

export const retention: CronJob = async (env, now) => {
  const c = getConfig(env)
  const db = env.DB
  await sweep(db, 'redaksi PII audit', repo.redactPiiStmt, c.AUDIT_PII_RETENTION_DAYS, now)
  await sweep(db, 'padam audit', repo.pruneStmt, c.AUDIT_RECORD_RETENTION_DAYS, now)
  await sweep(db, 'batu nisan upload', pruneTombstonesStmt, c.UPLOAD_TOMBSTONE_RETENTION_DAYS, now)
  await sweep(db, 'payment_logs', prunePaymentLogsStmt, c.PAYMENT_LOG_RETENTION_DAYS, now)
}
