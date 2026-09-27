// SQL milik features/members: roles, sequences.

export type RoleRow = { id: number; key: string; name: string; category: string; rank: number }

export async function listRoles(db: D1Database): Promise<RoleRow[]> {
  const { results } = await db.prepare('SELECT id, key, name, category, rank FROM roles ORDER BY rank').all<RoleRow>()
  return results
}

// Pembilang atomik (satu statement). Kunci marc_go: member_seq:ahli,
// member_seq:tester, certificate_serial - dikekalkan supaya nilai import bersambung.
export async function nextSequence(db: D1Database, key: string, now: number): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO sequences (key, current_value, updated_at) VALUES (?, 1, ?)
       ON CONFLICT (key) DO UPDATE SET current_value = current_value + 1, updated_at = excluded.updated_at
       RETURNING current_value`,
    )
    .bind(key, now)
    .first<{ current_value: number }>()
  return row!.current_value
}
