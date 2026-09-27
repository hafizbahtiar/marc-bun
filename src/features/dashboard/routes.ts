// GET /dashboard - lapisan approved (bukan verified). Pariti handlers/dashboard.go.
import { Hono } from 'hono'
import { outstandingFeeStmt } from '../payments'
import { requireApproved } from '../profile'
import { getConfig } from '../../shared/config'
import { ApiError } from '../../shared/http'
import { requireAuth, userId } from '../../shared/middleware/auth'
import { mytMonthRange, toJson } from '../../shared/time'
import type { AppEnv } from '../../shared/types'
import * as repo from './repo'

const MAX_DEPARTMENT_ROWS = 6

export function dashboardRoutes() {
  const r = new Hono<AppEnv>()

  r.get('/dashboard', requireAuth, requireApproved, async (c) => {
    const db = c.env.DB
    const uid = userId(c)
    const now = Date.now()
    try {
      const m = await repo.memberBlock(db, uid, now, outstandingFeeStmt(db, uid, getConfig(c.env).REGISTRATION_FEE_CENTS))
      let admin = null
      if (m.me.is_admin) {
        const a = await repo.adminBlock(db, now, mytMonthRange(now)[0], m.me.is_superadmin === 1)
        const top = a.departments.slice(0, MAX_DEPARTMENT_ROWS)
        const lain = a.departments.slice(MAX_DEPARTMENT_ROWS).reduce((s, d) => s + d.count, 0)
        if (lain > 0) top.push({ code: '', name: 'Lain-lain', count: lain })
        admin = {
          pending_approvals: a.pending,
          member_stats: { active: a.active, pending: a.pending, new_this_month: a.newThisMonth, by_department: top },
          activity_stats: {
            upcoming: a.upcoming,
            registrations_this_month: a.registrationsThisMonth,
            attendance_rate: a.expected === 0 ? null : a.attended / a.expected,
          },
          // Derma hanya untuk superadmin (null selainnya); total = apa yang pemanggil layak lihat.
          revenue_this_month: {
            currency: 'MYR',
            registration_cents: a.registrationCents,
            activity_cents: a.activityCents,
            donation_cents: a.donationCents,
            total_cents: a.registrationCents + a.activityCents + (a.donationCents ?? 0),
          },
        }
      }
      return c.json({
        member: {
          membership: {
            status: m.me.status,
            member_id: m.me.member_id,
            staff_id_verified: m.me.staff_id_verified_at !== null,
            outstanding_registration_fee_cents: m.outstandingFeeCents,
          },
          certificates_total: m.certificatesTotal,
          total_members: m.totalMembers,
          open_activities: m.open.map((a) => ({ ...a, starts_at: toJson(a.starts_at) })),
        },
        admin,
      })
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', msg: 'dashboard', error: String(err) }))
      throw new ApiError(500, 'gagal muat dashboard')
    }
  })

  return r
}
