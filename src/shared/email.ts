// Resend melalui fetch (pariti marc_go internal/email). Tidak dikonfigur =
// no-op senyap, sama seperti asal. Disuntik sebagai kebergantungan (AppDeps)
// supaya ujian boleh menangkap emel tanpa rangkaian.
import type { Config } from './config'

export type Email = { to: string; subject: string; html: string; attachments?: { filename: string; content: Uint8Array }[] }

export type SendEmail = (config: Config, email: Email) => Promise<void>

export const emailEnabled = (config: Config): boolean => config.RESEND_API_KEY !== '' && config.EMAIL_FROM !== ''

const base64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''))

export const resendEmail: SendEmail = async (config, email) => {
  if (!emailEnabled(config)) return
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.RESEND_API_KEY}` },
    body: JSON.stringify({
      from: config.EMAIL_FROM,
      to: [email.to],
      subject: email.subject,
      html: email.html,
      attachments: email.attachments?.map((a) => ({ filename: a.filename, content: base64(a.content) })),
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 200)}`)
}

export const escapeHtml = (s: string): string =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&#34;').replaceAll("'", '&#39;')
