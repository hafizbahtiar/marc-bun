// SQL milik features/certificates: activity_certificates, certificate_templates.
import type { TemplateStyle } from './pdf'

export type Template = TemplateStyle & { id: string; name: string; is_active: number; logo_url: string; updated_at: number; created_at: number }

export type Certificate = {
  id: string
  activity_id: string
  user_id: string
  serial: string
  verify_token: string
  recipient_name: string
  activity_title: string
  category_name: string
  activity_date: string
  issued_at: number
  revoked_at: number | null
  revoked_reason: string | null
  template_primary_color: string
  template_secondary_color: string
  template_title: string
  template_subtitle: string
  template_body_text: string
  template_issuer_name: string
  template_signature_name: string
  template_footer_text: string
}

// ---- templat ----

export async function listTemplates(db: D1Database): Promise<Template[]> {
  const { results } = await db.prepare('SELECT * FROM certificate_templates ORDER BY is_active DESC, updated_at DESC, name ASC').all<Template>()
  return results
}

export const getTemplate = (db: D1Database, id: string) => db.prepare('SELECT * FROM certificate_templates WHERE id = ?').bind(id).first<Template>()

export const activeTemplate = (db: D1Database) => db.prepare('SELECT * FROM certificate_templates WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 1').first<Template>()

export const updateTemplateStmt = (db: D1Database, id: string, t: Omit<Template, 'id' | 'is_active' | 'updated_at' | 'created_at'>, expected: number, now: number) =>
  db
    .prepare(
      `UPDATE certificate_templates SET name = ?, primary_color = ?, secondary_color = ?, logo_url = ?, title = ?, subtitle = ?, body_text = ?,
         issuer_name = ?, signature_name = ?, footer_text = ?, updated_at = ?
       WHERE id = ? AND updated_at = ? RETURNING *`,
    )
    .bind(t.name, t.primary_color, t.secondary_color, t.logo_url, t.title, t.subtitle, t.body_text, t.issuer_name, t.signature_name, t.footer_text, now, id, expected)

// Terbit = nyahaktif yang lain + aktifkan sasaran, satu batch. Nyahaktif
// berguard CAS sasaran (marc_go: CTE nyahaktif tetap jalan walau CAS gagal).
export const publishTemplateStmts = (db: D1Database, id: string, expected: number, now: number) => [
  db
    .prepare('UPDATE certificate_templates SET is_active = 0, updated_at = ?1 WHERE is_active = 1 AND id <> ?2 AND EXISTS (SELECT 1 FROM certificate_templates WHERE id = ?2 AND updated_at = ?3)')
    .bind(now, id, expected),
  db.prepare('UPDATE certificate_templates SET is_active = 1, updated_at = ? WHERE id = ? AND updated_at = ? RETURNING *').bind(now, id, expected),
]

// ---- sijil ----

export type ActivityForIssue = { id: string; title: string; category_name: string; starts_at: number; ends_at: number; attendance_threshold_pct: number; total_sessions: number }

// cross-read: activities, activity_categories, activity_sessions
export const activityForIssue = (db: D1Database, id: string) =>
  db
    .prepare(
      `SELECT a.id, a.title, c.name AS category_name, a.starts_at, a.ends_at, a.attendance_threshold_pct,
         (SELECT COUNT(*) FROM activity_sessions s WHERE s.activity_id = a.id) AS total_sessions
       FROM activities a JOIN activity_categories c ON c.id = a.category_id WHERE a.id = ? AND a.deleted_at IS NULL`,
    )
    .bind(id)
    .first<ActivityForIssue>()

// Calon yang BELUM bersijil (nombor siri hanya ditempah untuk baris baharu).
// cross-read: activity_registrations, activity_attendances, profiles
export async function candidates(db: D1Database, activityId: string) {
  const { results } = await db
    .prepare(
      `SELECT r.user_id, COALESCE(pr.display_name, pr.member_id, '') AS display_name,
         (SELECT COUNT(*) FROM activity_attendances at WHERE at.registration_id = r.id) AS attended
       FROM activity_registrations r JOIN profiles pr ON pr.user_id = r.user_id JOIN activities a ON a.id = r.activity_id
       WHERE r.activity_id = ? AND r.status = 'registered' AND (a.fee_cents = 0 OR r.payment_status = 'paid')
         AND NOT EXISTS (SELECT 1 FROM activity_certificates ac WHERE ac.activity_id = r.activity_id AND ac.user_id = r.user_id)
       ORDER BY COALESCE(pr.display_name, pr.member_id)`,
    )
    .bind(activityId)
    .all<{ user_id: string; display_name: string; attended: number }>()
  return results
}

export const insertStmt = (db: D1Database, c: Omit<Certificate, 'issued_at' | 'revoked_at' | 'revoked_reason'>, now: number) =>
  db
    .prepare(
      `INSERT INTO activity_certificates (id, activity_id, user_id, serial, verify_token, recipient_name, activity_title, activity_date, category_name,
         template_primary_color, template_secondary_color, template_title, template_subtitle, template_body_text, template_issuer_name,
         template_signature_name, template_footer_text, issued_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (activity_id, user_id) DO NOTHING RETURNING id`,
    )
    .bind(
      c.id, c.activity_id, c.user_id, c.serial, c.verify_token, c.recipient_name, c.activity_title, c.activity_date, c.category_name,
      c.template_primary_color, c.template_secondary_color, c.template_title, c.template_subtitle, c.template_body_text, c.template_issuer_name,
      c.template_signature_name, c.template_footer_text, now,
    )

export const getCertificate = (db: D1Database, id: string) => db.prepare('SELECT * FROM activity_certificates WHERE id = ?').bind(id).first<Certificate>()

export const byVerifyToken = (db: D1Database, token: string) => db.prepare('SELECT * FROM activity_certificates WHERE verify_token = ?').bind(token).first<Certificate>()

export async function listMine(db: D1Database, userId: string): Promise<Certificate[]> {
  const { results } = await db.prepare('SELECT * FROM activity_certificates WHERE user_id = ? AND revoked_at IS NULL ORDER BY issued_at DESC').bind(userId).all<Certificate>()
  return results
}

export const revokeStmt = (db: D1Database, id: string, reason: string, now: number) =>
  db.prepare('UPDATE activity_certificates SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL RETURNING *').bind(now, reason, id)
