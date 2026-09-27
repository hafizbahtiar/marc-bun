// Pariti marc_go handlers/departments.go. Tiada audit (marc_go juga tiada).
import { Hono } from 'hono'
import { z } from 'zod'
import { requireApproved, requireMinRole } from '../profile'
import { ApiError, parseBody } from '../../shared/http'
import { requireAuth, userId } from '../../shared/middleware/auth'
import { toJson } from '../../shared/time'
import type { AppEnv } from '../../shared/types'
import * as repo from './repo'

const dto = (d: repo.DepartmentRow) => ({ code: d.code, name: d.name, sort_order: d.sort_order, added_by: d.added_by, created_at: toJson(d.created_at) })

const createSchema = z.object({ code: z.string().min(1).max(50), name: z.string().min(1).max(200), sort_order: z.number().int().default(0) })
const updateSchema = z.object({ name: z.string().nullish(), sort_order: z.number().int().nullish() })

export function departmentsRoutes() {
  const r = new Hono<AppEnv>()
  const superadmin = requireMinRole('superadmin', 'tindakan ini untuk superadmin sahaja')
  r.use('/departments', requireAuth, requireApproved)
  r.use('/admin/departments', requireAuth, requireApproved, superadmin)
  r.use('/admin/departments/*', requireAuth, requireApproved, superadmin)

  const list = async (db: D1Database) => ({ departments: (await repo.list(db)).map(dto) })

  // Baca sahaja, manager ke atas - pemilih bahagian untuk PATCH /members/:id/department.
  r.get('/departments', requireMinRole('manager', 'tindakan ini untuk manager ke atas sahaja'), async (c) => c.json(await list(c.env.DB)))
  r.get('/admin/departments', async (c) => c.json(await list(c.env.DB)))

  r.post('/admin/departments', async (c) => {
    const body = await parseBody(c, createSchema)
    const code = body.code.trim()
    const name = body.name.trim()
    if (!code || !name) throw new ApiError(400, 'kod dan nama bahagian diperlukan')
    if (code.includes('/')) throw new ApiError(400, "kod bahagian tidak boleh mengandungi '/'")
    try {
      return c.json(dto((await repo.create(c.env.DB, { code, name, sortOrder: body.sort_order, addedBy: userId(c) }))!), 201)
    } catch (err) {
      if (String(err).includes('UNIQUE constraint failed') || String(err).includes('PRIMARY KEY')) throw new ApiError(409, 'kod bahagian sudah wujud')
      throw err
    }
  })

  r.patch('/admin/departments/:code', async (c) => {
    const body = await parseBody(c, updateSchema)
    if (body.name != null && !body.name.trim()) throw new ApiError(400, 'nama bahagian tidak boleh kosong')
    const row = await repo.update(c.env.DB, c.req.param('code'), body.name?.trim() ?? null, body.sort_order ?? null)
    if (!row) throw new ApiError(404, 'bahagian tidak dijumpai')
    return c.json(dto(row))
  })

  r.delete('/admin/departments/:code', async (c) => {
    if (!(await repo.remove(c.env.DB, c.req.param('code')))) throw new ApiError(404, 'bahagian tidak dijumpai')
    return c.json({ ok: true })
  })

  return r
}
