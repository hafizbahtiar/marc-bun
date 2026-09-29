// Sijil - pariti marc_go activity_certificates.go + certificate_templates.go.
// Terbit = metadata + snapshot; PDF dijana setiap muat turun (R7).
import { markCertificatesIssuedStmt } from '../activities'
import { nextSequence } from '../members'
import { isManagement } from '../profile'
import { auditStmt, type Actor } from '../../shared/audit'
import { expectedUpdatedAt, staleWrite } from '../../shared/concurrency'
import { getConfig } from '../../shared/config'
import { uuid } from '../../shared/db'
import { ApiError } from '../../shared/http'
import { enqueueNotify, type Enqueue } from '../../shared/jobs'
import { mytYear, toJson } from '../../shared/time'
import { generatePdf, isEligible, unprintable } from './pdf'
import * as repo from './repo'
import type { Certificate, Template } from './repo'

export type CertificatesDeps = { enqueue: Enqueue }

export type CertificatesCtx = { env: CloudflareBindings; deps: CertificatesDeps; now: number; actor: Actor; userId: string; waitUntil(p: Promise<unknown>): void }

export async function requireManagement(ctx: { env: CloudflareBindings; userId: string }) {
  let ok: boolean
  try {
    ok = await isManagement(ctx.env.DB, ctx.userId)
  } catch {
    throw new ApiError(500, 'gagal semak kebenaran')
  }
  if (!ok) throw new ApiError(403, 'tindakan ini untuk pengurusan sahaja')
}

// Lalai lajur templat (tiada templat aktif) - sama dengan DEFAULT migrasi.
const DEFAULT_STYLE = {
  primary_color: '#E21E28',
  secondary_color: '#223145',
  title: 'Sijil Penyertaan',
  subtitle: 'MARC',
  body_text: 'Diberikan kepada [Nama penerima] atas penyertaan dalam aktiviti MARC.',
  issuer_name: 'MARC',
  signature_name: 'Pengurusan MARC',
  footer_text: 'Sijil ini dijana secara rasmi oleh MARC.',
}

const unprintableError = (field: string, value: string) => new ApiError(422, `medan sijil tidak boleh dicetak: ${field} ${JSON.stringify(value)}`)

// Token legap 24 bait CSPRNG (sama seperti checkin_token).
const token = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

// Tarikh dalam waktu MALAYSIA: aktiviti 00:30 MYT 1 Sep = 31 Ogos UTC.
const mytDate = (ms: number) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10)

export async function issue(ctx: CertificatesCtx, activityId: string) {
  const db = ctx.env.DB
  const a = await repo.activityForIssue(db, activityId)
  if (!a) throw new ApiError(404, 'aktiviti tidak dijumpai')
  // ends_at = MAX(sesi.ends_at): "sesi terakhir sudah tamat".
  if (ctx.now < a.ends_at) throw new ApiError(422, 'sijil hanya boleh diterbitkan selepas sesi terakhir tamat')
  for (const [field, value] of [['ActivityTitle', a.title], ['CategoryName', a.category_name]] as const) if (unprintable(value)) throw unprintableError(field, value)

  const style = (await repo.activeTemplate(db)) ?? DEFAULT_STYLE
  const eligible = (await repo.candidates(db, activityId)).filter((c) => isEligible(c.attended, a.total_sessions, a.attendance_threshold_pct))
  // Pra-terbang: gagal sebelum apa-apa baris atau nombor siri wujud.
  for (const c of eligible) if (unprintable(c.display_name)) throw unprintableError('RecipientName', c.display_name)

  // Satu tempahan julat siri. Batch gagal / kalah perlumbaan = jurang siri (R4, diterima).
  const last = eligible.length ? await nextSequence(db, 'certificate_serial', ctx.now, eligible.length) : 0
  const year = mytYear(a.starts_at)
  const rows = eligible.map((c, i) => ({
    id: uuid(),
    activity_id: activityId,
    user_id: c.user_id,
    serial: `MARC-${year}-${String(last - eligible.length + 1 + i).padStart(6, '0')}`,
    verify_token: token(),
    recipient_name: c.display_name,
    activity_title: a.title,
    category_name: a.category_name,
    activity_date: mytDate(a.starts_at),
    template_primary_color: style.primary_color,
    template_secondary_color: style.secondary_color,
    template_title: style.title,
    template_subtitle: style.subtitle,
    template_body_text: style.body_text,
    template_issuer_name: style.issuer_name,
    template_signature_name: style.signature_name,
    template_footer_text: style.footer_text,
  }))
  // ponytail: 2 statement setiap sijil dalam satu batch - had 1000 query/invocation (Workers Paid) ≈ 490 sijil; pecah batch bila aktiviti sebesar itu wujud.
  const results = await db.batch([
    ...rows.flatMap((r) => [
      repo.insertStmt(db, r, ctx.now),
      auditStmt(
        db,
        { entityType: 'activity_certificate', entityId: r.id, action: 'create', actor: ctx.actor, new: { serial: r.serial, activity_id: activityId, user_id: r.user_id } },
        { sql: 'EXISTS (SELECT 1 FROM activity_certificates WHERE id = ?)', params: [r.id] },
      )!,
    ]),
    markCertificatesIssuedStmt(db, activityId, ctx.now),
  ])
  const issued = rows.filter((_, i) => results[i * 2]!.results.length > 0)

  if (issued.length) {
    ctx.waitUntil(
      enqueueNotify(
        ctx.deps.enqueue,
        ctx.env,
        // Setiap penerima dipautkan kepada sijilnya sendiri oleh consumer; pelaku
        // yang turut menyertai aktiviti juga penerima.
        { kind: 'certificate_ready', actorId: ctx.userId, includeActor: true, activityId, push: { title: 'Sijil Anda Sedia', message: `Sijil untuk ${a.title} sudah boleh dimuat turun.` } },
        issued.map((r) => r.user_id),
      ).catch((err) => console.error(JSON.stringify({ level: 'error', msg: 'notify sijil gagal', activity: activityId, error: String(err) }))),
    )
  }
  return { issued: issued.length, files_ready: issued.length, message: 'sijil siap dimuat turun' }
}

export async function revoke(ctx: CertificatesCtx, id: string, rawReason: string) {
  const reason = rawReason.trim()
  if (!reason) throw new ApiError(400, 'sebab tarik balik diperlukan')
  const db = ctx.env.DB
  const before = await repo.getCertificate(db, id)
  if (!before) throw new ApiError(404, 'sijil tidak dijumpai')
  if (before.revoked_at !== null) throw new ApiError(409, 'sijil sudah ditarik balik')
  // Baris TIDAK dipadam: pengesahan mesti boleh berkata "ditarik balik".
  const [res] = await db.batch([
    repo.revokeStmt(db, id, reason, ctx.now),
    auditStmt(
      db,
      { entityType: 'activity_certificate', entityId: id, action: 'delete', actor: ctx.actor, old: { serial: before.serial, activity_id: before.activity_id, user_id: before.user_id, revoked_reason: reason } },
      { sql: 'EXISTS (SELECT 1 FROM activity_certificates WHERE id = ? AND revoked_at = ?)', params: [id, ctx.now] },
    )!,
  ])
  if (!res?.results.length) throw new ApiError(409, 'sijil sudah ditarik balik')
  return { revoked: true }
}

export async function listMine(ctx: { env: CloudflareBindings; userId: string }) {
  const rows = await repo.listMine(ctx.env.DB, ctx.userId)
  return {
    certificates: rows.map((r) => ({
      id: r.id,
      activity_id: r.activity_id,
      serial: r.serial,
      verify_token: r.verify_token,
      recipient_name: r.recipient_name,
      activity_title: r.activity_title,
      category_name: r.category_name,
      activity_date: r.activity_date,
      issued_at: toJson(r.issued_at),
      file_ready: true, // keserasian API lama; PDF sentiasa on-demand
    })),
  }
}

// Awam. Medan terhad; token tidak wujud dan cacat → 404 yang SAMA (bukan oracle).
export async function verify(env: CloudflareBindings, verifyToken: string) {
  const c = await repo.byVerifyToken(env.DB, verifyToken)
  if (!c) throw new ApiError(404, 'sijil tidak dijumpai')
  return {
    serial: c.serial,
    recipient_name: c.recipient_name,
    activity_title: c.activity_title,
    activity_date: c.activity_date,
    issued_at: new Date(c.issued_at).toISOString().replace(/\.\d{3}Z$/, 'Z'), // RFC3339 saat
    status: c.revoked_at === null ? 'sah' : 'ditarik_balik',
  }
}

export function verifyLink(env: CloudflareBindings, c: Certificate) {
  const config = getConfig(env)
  if (config.CERTIFICATE_VERIFY_URL) return `${config.CERTIFICATE_VERIFY_URL}?token=${c.verify_token}`
  return `${config.PUBLIC_BASE_URL.replace(/\/+$/, '')}/verify/certificates/${c.verify_token}`
}

export async function download(ctx: { env: CloudflareBindings; userId: string }, id: string): Promise<Uint8Array> {
  const c = await repo.getCertificate(ctx.env.DB, id)
  // 404, bukan 403: mengesahkan kewujudan kepada bukan pemilik pun kebocoran.
  if (!c || c.user_id !== ctx.userId) throw new ApiError(404, 'sijil tidak dijumpai')
  if (c.revoked_at !== null) throw new ApiError(410, 'sijil ini telah ditarik balik')
  try {
    return await generatePdf({
      serial: c.serial,
      recipientName: c.recipient_name,
      activityTitle: c.activity_title,
      categoryName: c.category_name,
      activityDate: c.activity_date,
      verifyUrl: verifyLink(ctx.env, c),
      template: {
        primary_color: c.template_primary_color,
        secondary_color: c.template_secondary_color,
        title: c.template_title,
        subtitle: c.template_subtitle,
        body_text: c.template_body_text,
        issuer_name: c.template_issuer_name,
        signature_name: c.template_signature_name,
        footer_text: c.template_footer_text,
      },
    })
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'jana PDF sijil', certificate: id, error: String(err) }))
    throw new ApiError(500, 'gagal jana fail sijil')
  }
}

// ---- templat ----

export const templateDto = (t: Template) => ({
  id: t.id,
  name: t.name,
  is_active: t.is_active === 1,
  primary_color: t.primary_color,
  secondary_color: t.secondary_color,
  logo_url: t.logo_url,
  title: t.title,
  subtitle: t.subtitle,
  body_text: t.body_text,
  issuer_name: t.issuer_name,
  signature_name: t.signature_name,
  footer_text: t.footer_text,
  updated_at: toJson(t.updated_at),
})

export type TemplateInput = {
  name: string
  primary_color: string
  secondary_color: string
  logo_url?: string | null
  title: string
  subtitle: string
  body_text: string
  issuer_name: string
  signature_name: string
  footer_text: string
  updated_at: string
}

const bytes = (s: string) => new TextEncoder().encode(s).length
const HEX = /^#[0-9a-fA-F]{6}$/

export async function updateTemplate(ctx: CertificatesCtx, id: string, r: TemplateInput) {
  const required: [string, string][] = [
    ['nama', r.name],
    ['tajuk', r.title],
    ['subtajuk', r.subtitle],
    ['teks utama', r.body_text],
    ['nama penerbit', r.issuer_name],
    ['nama penandatangan', r.signature_name],
  ]
  for (const [label, value] of required) if (!value.trim()) throw new ApiError(400, `${label} diperlukan`)
  if (!HEX.test(r.primary_color) || !HEX.test(r.secondary_color)) throw new ApiError(400, 'format warna tidak sah')
  // Bait, bukan aksara (pariti len() Go).
  if (bytes(r.name) > 120 || bytes(r.title) > 200 || bytes(r.body_text) > 2000 || bytes(r.footer_text) > 500) throw new ApiError(400, 'teks template terlalu panjang')
  const expected = expectedUpdatedAt(r.updated_at)
  const row = await repo.updateTemplateStmt(ctx.env.DB, id, { ...r, logo_url: (r.logo_url ?? '').trim() }, expected, ctx.now).first<Template>()
  // Tidak wujud juga 409 (pariti marc_go).
  if (!row) throw staleWrite('template sijil telah berubah. Muat semula sebelum menyunting lagi.')
  return templateDto(row)
}

export async function publishTemplate(ctx: CertificatesCtx, id: string, rawUpdatedAt: string) {
  const expected = expectedUpdatedAt(rawUpdatedAt)
  const [, res] = await ctx.env.DB.batch(repo.publishTemplateStmts(ctx.env.DB, id, expected, ctx.now))
  const row = res!.results[0] as Template | undefined
  if (!row) throw staleWrite('template sijil telah berubah. Muat semula sebelum menerbitkan lagi.')
  return templateDto(row)
}
