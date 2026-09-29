// Job bayaran - pariti internal/{paymentreconcile,activitysweep,registrationsweep}.
// Setiap satu idempoten melalui guard lajur (dua larian serentak = hasil sama).
import { cancelStaleUnpaid, markPaidByRef } from '../registrations'
import { getConfig } from '../../shared/config'
import type { CronJob } from '../../shared/jobs'
import { gatewaysFor, type Gateway, type Gateways } from './gateways'
import * as repo from './repo'

const MIN = 60_000
const logError = (msg: string, extra: Record<string, unknown>) => console.error(JSON.stringify({ level: 'error', msg, ...extra }))

// ---- reconcile (30m) ----

// Tetingkap: cukup tua (webhook sepatutnya sudah tiba), tidak terlalu tua.
const MIN_AGE = 15 * MIN
const MAX_AGE = 7 * 24 * 60 * MIN
// ponytail: 50 setiap jenis (bukan 200 marc_go) - satu larian kekal di bawah had
// subrequest/D1 Workers; baki disambung pusingan seterusnya.
const RECONCILE_BATCH = 50

export type ReconcileSummary = { checked: number; mismatches_fixed: number; errors: number }

export async function runReconcile(db: D1Database, gateways: Gateways, now: number): Promise<ReconcileSummary> {
  const s: ReconcileSummary = { checked: 0, mismatches_fixed: 0, errors: 0 }
  const staleBefore = now - MIN_AGE
  const oldest = now - MAX_AGE
  const byName = gateways as Record<string, Gateway | undefined>

  // Yuran pendaftaran
  for (const row of await repo.pendingRegPayments(db, staleBefore, oldest, RECONCILE_BATCH).catch(() => (s.errors++, []))) {
    s.checked++
    const ref = row.gateway_ref!
    const base = { module: 'registration_fee' as const, gateway: row.gateway, gatewayRef: ref, amountCents: row.amount_cents, userId: row.user_id, relatedId: row.id }
    const gw = byName[row.gateway]
    if (!gw?.enabled) {
      s.errors++
      continue
    }
    let status
    try {
      status = await gw.checkStatus(ref)
    } catch (e) {
      s.errors++
      await repo.log(db, { ...base, event: 'reconcile_check', status: 'error', message: String(e) })
      continue
    }
    if (status === row.status) {
      await repo.log(db, { ...base, event: 'reconcile_check', status })
      continue
    }
    await repo.log(db, { ...base, event: 'reconcile_mismatch_fixed', status: 'mismatch', message: `DB=${row.status}, gateway=${status}, dikemas kini` })
    // Tiada baris = webhook menang dahulu; jangan kira dua kali.
    if (await repo.updateRegPaymentStatus(db, row.gateway, ref, status).catch(() => (s.errors++, null))) s.mismatches_fixed++
  }

  // Yuran aktiviti
  const actRows = await repo.pendingActivityPayments(db, staleBefore, oldest, RECONCILE_BATCH).catch(() => (s.errors++, []))
  const actGw = gateways['toyyibpay-activity']
  if (actRows.length && !actGw.enabled) s.errors++
  else
    for (const row of actRows) {
      s.checked++
      const base = { module: 'activity_fee' as const, gateway: actGw.name, gatewayRef: row.payment_ref, userId: row.user_id, relatedId: row.id }
      let status
      try {
        status = await actGw.checkStatus(row.payment_ref)
      } catch (e) {
        s.errors++
        await repo.log(db, { ...base, event: 'reconcile_check', status: 'error', message: String(e) })
        continue
      }
      if (status === 'pending') {
        await repo.log(db, { ...base, event: 'reconcile_check', status: 'pending' })
        continue
      }
      if (status === 'failed') {
        // Tiada 'failed' dalam payment_status - dilog, sweep membersihkan.
        await repo.log(db, { ...base, event: 'reconcile_mismatch_fixed', status: 'failed', message: `DB=${row.payment_status}, gateway=failed, TIADA tulisan DB (payment_status tiada nilai 'failed'), tinggal untuk activitysweep bersihkan` })
        continue
      }
      await repo.log(db, { ...base, event: 'reconcile_mismatch_fixed', status: 'mismatch', message: `DB=${row.payment_status}, gateway=succeeded, dikemas kini ke paid` })
      const reg = await markPaidByRef(db, row.payment_ref).catch(() => (s.errors++, null))
      if (!reg) continue
      if (reg.status === 'cancelled') logError('paymentreconcile: ahli BAYAR tapi pendaftaran SUDAH DIBATAL oleh sapuan - perlukan semakan manual', { ref: row.payment_ref, registration: reg.id })
      s.mismatches_fixed++
    }

  // Derma (Stripe)
  for (const row of await repo.pendingStripeDonations(db, staleBefore, RECONCILE_BATCH).catch(() => (s.errors++, []))) {
    s.checked++
    const base = { module: 'donation' as const, gateway: row.gateway, gatewayRef: row.gateway_ref, amountCents: row.amount_cents, userId: row.user_id, relatedId: row.id }
    const gw = byName[row.gateway]
    if (!gw?.enabled) {
      s.errors++
      continue
    }
    let status
    try {
      status = await gw.checkStatus(row.gateway_ref)
    } catch (e) {
      s.errors++
      await repo.log(db, { ...base, event: 'reconcile_check', status: 'error', message: String(e) })
      continue
    }
    if (status === row.status) {
      await repo.log(db, { ...base, event: 'reconcile_check', status })
      continue
    }
    await repo.log(db, { ...base, event: 'reconcile_mismatch_fixed', status: 'mismatch', message: `DB=${row.status}, gateway=${status}, dikemas kini` })
    if (await repo.updateDonationStatus(db, row.gateway, row.gateway_ref, status).catch(() => (s.errors++, null))) s.mismatches_fixed++
  }
  return s
}

export const reconcile: CronJob = async (env, t) => void (await runReconcile(env.DB, gatewaysFor(getConfig(env)), t))

// ---- activitysweep (15m) - lepaskan slot yang tidak dibayar ----
// Pariti marc_go: tiada semakan gateway di sini (webhook lewat pada baris
// dibatal tetap ditulis sebagai cancelled+paid dan boleh dikesan).

export const activitySweep: CronJob = async (env, t) => {
  const unstarted = await cancelStaleUnpaid(env.DB, false, t - 45 * MIN, t)
  const unpaid = await cancelStaleUnpaid(env.DB, true, t - 24 * 60 * MIN, t)
  if (unstarted || unpaid) console.log(JSON.stringify({ level: 'info', msg: 'activitysweep', unstarted, unpaid }))
}

// ---- registrationsweep (15m) - bil pendaftaran pending yang tamat tempoh ----
// Gateway disemak DAHULU: bayaran lewat tidak hilang senyap.

export async function runRegistrationSweep(db: D1Database, gateways: Gateways, now: number, staleMinutes: number): Promise<number> {
  let expired = 0
  const byName = gateways as Record<string, Gateway | undefined>
  for (const row of await repo.stalePendingRegPayments(db, now - staleMinutes * MIN, 100)) {
    const base = { module: 'registration_fee' as const, gateway: row.gateway, gatewayRef: row.gateway_ref ?? '', amountCents: row.amount_cents, userId: row.user_id, relatedId: row.id }
    if (!row.gateway_ref) {
      // Tiada bil - selamat ditanda gagal terus.
      if ((await repo.markRegPaymentFailedNoRef(db, row.id).run()).meta.changes) expired++
      continue
    }
    const gw = byName[row.gateway]
    if (!gw?.enabled) continue
    let status
    try {
      status = await gw.checkStatus(row.gateway_ref)
    } catch (e) {
      logError('registrationsweep: CheckStatus gagal', { ref: row.gateway_ref, error: String(e) })
      continue
    }
    if (status === 'succeeded') {
      await repo.updateRegPaymentStatus(db, row.gateway, row.gateway_ref, 'succeeded')
      await repo.log(db, { ...base, event: 'reconcile_mismatch_fixed', status: 'succeeded', message: 'sapuan: gateway succeeded, DB dikemas kini' })
      continue
    }
    if (status === 'failed') {
      await repo.updateRegPaymentStatus(db, row.gateway, row.gateway_ref, 'failed')
      continue
    }
    // Masih pending di gateway - bil sepatutnya sudah tamat tempoh (billExpiryDate).
    if ((await repo.expireRegPaymentStmt(db, row.id).first()) === null) continue
    await repo.log(db, { ...base, event: 'reconcile_check', status: 'failed', message: 'sapuan: bil pending lapuk ditandakan failed' })
    expired++
  }
  return expired
}

export const registrationSweep: CronJob = async (env, t) => {
  const config = getConfig(env)
  const n = await runRegistrationSweep(env.DB, gatewaysFor(config), t, config.REGISTRATION_BILL_EXPIRY_MINUTES)
  if (n) console.log(JSON.stringify({ level: 'info', msg: 'registrationsweep', expired: n }))
}
