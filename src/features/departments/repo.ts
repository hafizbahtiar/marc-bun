// SQL milik features/departments.

export type DepartmentRow = { code: string; name: string; sort_order: number; added_by: string | null; created_at: number }

export async function exists(db: D1Database, code: string): Promise<boolean> {
  return (await db.prepare('SELECT 1 FROM departments WHERE code = ?').bind(code).first()) !== null
}

export async function list(db: D1Database): Promise<DepartmentRow[]> {
  const { results } = await db.prepare('SELECT * FROM departments ORDER BY sort_order ASC, name ASC').all<DepartmentRow>()
  return results
}

export const create = (db: D1Database, d: { code: string; name: string; sortOrder: number; addedBy: string }) =>
  db.prepare('INSERT INTO departments (code, name, sort_order, added_by) VALUES (?, ?, ?, ?) RETURNING *').bind(d.code, d.name, d.sortOrder, d.addedBy).first<DepartmentRow>()

export const update = (db: D1Database, code: string, name: string | null, sortOrder: number | null) =>
  db.prepare('UPDATE departments SET name = COALESCE(?, name), sort_order = COALESCE(?, sort_order) WHERE code = ? RETURNING *').bind(name, sortOrder, code).first<DepartmentRow>()

export async function remove(db: D1Database, code: string): Promise<boolean> {
  const { meta } = await db.prepare('DELETE FROM departments WHERE code = ?').bind(code).run()
  return meta.changes > 0
}
