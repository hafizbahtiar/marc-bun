// Resit PDF + emel resit - pariti marc_go internal/{receipt,receiptmail}.
// PDF dijana setiap permintaan (tiada R2). Susun atur = receipt.go (mm, A4 potret).
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { escapeHtml } from '../../shared/email'
import { color, MmPage, PT, winAnsi } from '../../shared/pdf'
import logoBase64 from './logo.png.txt'

const BRAND = [47, 107, 79] as const
const BRAND_DARK = [35, 82, 60] as const
const TINT = [238, 244, 240] as const
const INK = [28, 27, 25] as const
const MUTED = [107, 107, 107] as const
const LINE = [228, 225, 218] as const
const ZEBRA = [250, 249, 246] as const

const PAGE_W = 210
const PAGE_H = 297
const MARGIN = 18
const CONTENT_W = PAGE_W - 2 * MARGIN
const HEADER_H = 40
const LABEL_COL_W = 52
const LOGO_W = 22
const LOGO_GAP = 6

// PENTING: sumbangan pergi kepada pembangun secara peribadi, BUKAN MAIWP.
const DONATION_FOOTER =
  'Sumbangan ini diberikan secara peribadi kepada pembangun aplikasi MARC bagi menampung kos hosting, domain dan penyelenggaraan. ' +
  'Ia BUKAN sumbangan kepada MAIWP atau mana-mana badan amal, dan TIDAK layak untuk pelepasan cukai. ' +
  'Resit ini dijana secara automatik dan sah tanpa tandatangan - sila simpan untuk rekod peribadi anda.'
const FEE_FOOTER = 'Resit ini dijana secara automatik dan sah tanpa tandatangan - sila simpan untuk rekod peribadi anda.'

export type DonationReceipt = { memberId: string; donorName: string; donorEmail: string; amountCents: number; currency: string; gatewayRef: string; paidAt: number | null }

export type FeeReceipt = {
  memberId: string
  payerName: string
  payerEmail: string
  amountCents: number
  currency: string
  gatewayRef: string
  paidAt: number | null
  purpose: string
  gatewayChargeCents: number
}

// ---- format (pariti Go) ----

export function filename(label: string, ref: string, fallbackId: string) {
  const r = (ref.trim() || fallbackId).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'MARC'
  return `Resit-${label}-MARC-${r}.pdf`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
// "2 Jan 2006, 3:04 PM (MYT)"
export function formatDateTime(ms: number | null) {
  if (!ms) return '-'
  const d = new Date(ms + 8 * 3600_000)
  const h = d.getUTCHours()
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${h % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'} (MYT)`
}

export function formatAmount(cents: number, currency: string) {
  const c = currency.toLowerCase()
  const prefix = !c || c === 'myr' ? 'RM' : `${currency.toUpperCase()} `
  const neg = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${neg}${prefix}${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`
}

const UNITS = ['kosong', 'satu', 'dua', 'tiga', 'empat', 'lima', 'enam', 'tujuh', 'lapan', 'sembilan']
function malayNumber(n: number): string {
  const join = (head: string, rest: number) => (rest === 0 ? head : `${head} ${malayNumber(rest)}`)
  if (n < 10) return UNITS[n]!
  if (n === 10) return 'sepuluh'
  if (n === 11) return 'sebelas'
  if (n < 20) return `${UNITS[n - 10]} belas`
  if (n < 100) return join(`${UNITS[Math.floor(n / 10)]} puluh`, n % 10)
  if (n < 200) return join('seratus', n % 100)
  if (n < 1000) return join(`${UNITS[Math.floor(n / 100)]} ratus`, n % 100)
  if (n < 2000) return join('seribu', n % 1000)
  if (n < 1e6) return join(`${malayNumber(Math.floor(n / 1000))} ribu`, n % 1000)
  if (n < 1e9) return join(`${malayNumber(Math.floor(n / 1e6))} juta`, n % 1e6)
  return join(`${malayNumber(Math.floor(n / 1e9))} bilion`, n % 1e9)
}

export function amountInWords(cents: number, currency: string) {
  const c = currency.toLowerCase()
  if ((c && c !== 'myr') || cents <= 0) return ''
  const ringgit = Math.floor(cents / 100)
  const sen = cents % 100
  const parts: string[] = []
  if (ringgit > 0) parts.push(malayNumber(ringgit))
  if (sen > 0) parts.push(...(parts.length ? ['dan'] : []), malayNumber(sen), 'sen')
  const title = parts
    .join(' ')
    .split(' ')
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ')
  return `Ringgit Malaysia ${title} sahaja`
}

const or = (s: string, def: string) => (s.trim() ? s : def)

// ---- PDF ----

type Doc = { doc: PDFDocument; p: MmPage; regular: Awaited<ReturnType<PDFDocument['embedFont']>>; bold: Awaited<ReturnType<PDFDocument['embedFont']>>; italic: Awaited<ReturnType<PDFDocument['embedFont']>> }

async function newDoc(title: string, author: string): Promise<Doc> {
  const doc = await PDFDocument.create()
  doc.setTitle(winAnsi(title))
  doc.setAuthor(author)
  const page = doc.addPage([PAGE_W * PT, PAGE_H * PT])
  const [regular, bold, italic] = await Promise.all([doc.embedFont(StandardFonts.Helvetica), doc.embedFont(StandardFonts.HelveticaBold), doc.embedFont(StandardFonts.HelveticaOblique)])
  return { doc, p: new MmPage(page, { heightMm: PAGE_H, marginMm: MARGIN }), regular, bold, italic }
}

function label(d: Doc, text: string, w: number) {
  d.p.font(d.bold, 8)
  d.p.ink(color(MUTED))
  d.p.cell(w, 5, text, 2)
}

function header(d: Doc, left: { title: string; tagline: string; x: number; w: number }, right: { title: string; ref: string }) {
  const p = d.p
  p.rect(0, 0, PAGE_W, HEADER_H, color(BRAND))
  p.rect(0, HEADER_H, PAGE_W, 1.6, color(BRAND_DARK))
  p.ink(color([255, 255, 255]))
  p.x = left.x
  p.y = 11
  p.font(d.bold, 24)
  p.cell(left.w, 10, 'MARC', 2)
  p.x = left.x
  p.font(d.regular, 9)
  p.cell(left.w, 5, winAnsi(left.tagline), 0)
  p.x = PAGE_W / 2
  p.y = 12
  p.font(d.bold, 13)
  p.cell(PAGE_W / 2 - MARGIN, 7, right.title, 2, 'R')
  p.font(d.regular, 9)
  p.cell(PAGE_W / 2 - MARGIN, 5, winAnsi(`No. Rujukan  ${or(right.ref, '-')}`), 0, 'R')
  p.x = MARGIN
  p.y = HEADER_H + 12
}

function partyBlock(d: Doc, heading: string, name: string, email: string, paidAt: number | null) {
  const p = d.p
  const top = p.y
  const colW = CONTENT_W / 2
  label(d, heading, colW)
  p.font(d.bold, 13)
  p.ink(color(INK))
  p.cell(colW, 7, p.clip(winAnsi(name), colW), 2)
  p.font(d.regular, 10)
  p.ink(color(MUTED))
  p.cell(colW, 5.5, p.clip(winAnsi(email), colW), 2)
  let bottom = p.y
  p.x = MARGIN + colW
  p.y = top
  label(d, 'TARIKH', colW)
  p.x = MARGIN + colW
  p.font(d.bold, 11)
  p.ink(color(INK))
  p.cell(colW, 7, formatDateTime(paidAt), 2)
  // Resit hanya bagi bayaran berjaya - lencana sentiasa BERJAYA.
  p.x = MARGIN + colW
  p.font(d.bold, 8)
  p.ink(color([255, 255, 255]))
  p.cell(28, 6, 'BERJAYA', 1, 'C', color(BRAND))
  bottom = Math.max(bottom, p.y)
  p.x = MARGIN
  p.y = bottom + 8
}

function amountPanel(d: Doc, heading: string, cents: number, currency: string) {
  const p = d.p
  const words = amountInWords(cents, currency)
  const panelH = words ? 32 : 24
  const top = p.y
  p.rect(MARGIN, top, CONTENT_W, panelH, color(TINT))
  p.rect(MARGIN, top, 2, panelH, color(BRAND))
  p.x = MARGIN + 8
  p.y = top + 5
  label(d, heading, CONTENT_W - 16)
  p.x = MARGIN + 8
  p.font(d.bold, 24)
  p.ink(color(BRAND))
  p.cell(CONTENT_W - 16, 11, formatAmount(cents, currency), 2)
  if (words) {
    p.x = MARGIN + 8
    p.font(d.italic, 9)
    p.ink(color(MUTED))
    p.multiCell(CONTENT_W - 16, 4.5, words)
  }
  p.x = MARGIN
  p.y = top + panelH + 10
}

function detailsTable(d: Doc, rows: [string, string][]) {
  const p = d.p
  label(d, 'BUTIRAN TRANSAKSI', CONTENT_W)
  p.ln(1)
  const rowH = 8.5
  rows.forEach(([k, v], i) => {
    if (i % 2 === 1) p.rect(MARGIN, p.y, CONTENT_W, rowH, color(ZEBRA))
    p.x = MARGIN
    p.font(d.regular, 10)
    p.ink(color(MUTED))
    p.cell(LABEL_COL_W, rowH, winAnsi(k), 0)
    p.font(d.bold, 10)
    p.ink(color(INK))
    const valueW = CONTENT_W - LABEL_COL_W
    p.cell(valueW, rowH, p.clip(winAnsi(v), valueW), 1)
    p.line(MARGIN, p.y, MARGIN + CONTENT_W, p.y, color(LINE), 0.2)
  })
  p.ln(10)
}

function footer(d: Doc, thanks: string, note: string, now: number) {
  const p = d.p
  p.font(d.bold, 10)
  p.ink(color(BRAND))
  p.cell(CONTENT_W, 6, thanks, 1)
  p.font(d.regular, 8.5)
  p.ink(color(MUTED))
  p.multiCell(CONTENT_W, 4.5, note)
  p.ln(4)
  p.line(MARGIN, p.y, MARGIN + CONTENT_W, p.y, color(LINE), 0.2)
  p.ln(3)
  p.font(d.regular, 8)
  p.cell(CONTENT_W, 4, `Dijana pada ${formatDateTime(now)} | MARC`, 1)
}

export async function donationPdf(r: DonationReceipt, now = Date.now()): Promise<Uint8Array> {
  const d = await newDoc(`Resit Sokongan MARC ${r.gatewayRef}`, 'Hafiz - Pembangun MARC')
  header(d, { title: 'MARC', tagline: 'Sokongan penyelenggaraan aplikasi', x: MARGIN, w: CONTENT_W / 2 }, { title: 'RESIT SOKONGAN', ref: r.gatewayRef })
  partyBlock(d, 'DITERIMA DARIPADA', or(r.donorName, 'Penyumbang Awanama'), or(r.donorEmail, '-'), r.paidAt)
  amountPanel(d, 'JUMLAH SOKONGAN', r.amountCents, r.currency)
  detailsTable(d, [
    ['No. Rujukan Transaksi', or(r.gatewayRef, '-')],
    ['No. Ahli MARC', or(r.memberId, 'Tiada (penyumbang awam)')],
    ['Penerima', 'Hafiz - Pembangun MARC'],
    ['Tujuan', 'Penyelenggaraan aplikasi'],
    ['Kaedah Pembayaran', 'Dalam talian'],
    ['Mata Wang', or(r.currency, 'MYR').toUpperCase()],
    ['Status Pembayaran', 'Berjaya'],
  ])
  footer(d, 'Terima kasih kerana menyokong MARC.', DONATION_FOOTER, now)
  return d.doc.save()
}

const logo = () => Uint8Array.from(atob(logoBase64), (c) => c.charCodeAt(0))

export async function feePdf(r: FeeReceipt, now = Date.now()): Promise<Uint8Array> {
  const d = await newDoc(`Resit Yuran MARC ${r.gatewayRef}`, 'MARC')
  header(d, { title: 'MARC', tagline: 'Bukti pembayaran yuran kelab', x: MARGIN + LOGO_W + LOGO_GAP, w: CONTENT_W / 2 - LOGO_W - LOGO_GAP }, { title: 'RESIT YURAN', ref: r.gatewayRef })
  // Crest kelab di atas latar header, tengah menegak.
  const img = await d.doc.embedPng(logo())
  d.doc.getPage(0).drawImage(img, { x: MARGIN * PT, y: (PAGE_H - (HEADER_H - LOGO_W) / 2 - LOGO_W) * PT, width: LOGO_W * PT, height: LOGO_W * PT })
  partyBlock(d, 'DIBAYAR OLEH', or(r.payerName, 'Ahli MARC'), or(r.payerEmail, '-'), r.paidAt)
  amountPanel(d, 'JUMLAH DIBAYAR', r.amountCents, r.currency)
  const rows: [string, string][] = [
    ['No. Rujukan Transaksi', or(r.gatewayRef, '-')],
    ['No. Ahli MARC', or(r.memberId, '-')],
    ['Jenis Yuran', or(r.purpose, 'Yuran')],
  ]
  // Pecahan hanya bila amaun > caj (`>` ketat, pariti CheckoutPage).
  if (r.amountCents > r.gatewayChargeCents && r.gatewayChargeCents > 0) {
    rows.push(['Yuran', formatAmount(r.amountCents - r.gatewayChargeCents, r.currency)], ['Caj Pemprosesan Pembayaran', formatAmount(r.gatewayChargeCents, r.currency)])
  }
  rows.push(['Penerima', 'MARC (Kelab)'], ['Kaedah Pembayaran', 'Dalam talian'], ['Mata Wang', or(r.currency, 'MYR').toUpperCase()], ['Status Pembayaran', 'Berjaya'])
  detailsTable(d, rows)
  footer(d, 'Terima kasih.', FEE_FOOTER, now)
  return d.doc.save()
}

// ---- emel resit (receiptmail) ----

export type ReceiptKind = 'registration_fee' | 'activity_fee' | 'donation'

const KINDS: Record<ReceiptKind, { label: string; subject: string; tagline: string; intro: (purpose: string) => string; amountLabel: string; footer: string; defaultName: string }> = {
  registration_fee: {
    label: 'Pendaftaran',
    subject: 'Resit Yuran Pendaftaran MARC',
    tagline: 'Bukti pembayaran yuran kelab',
    intro: (p) => `Pembayaran anda untuk <strong>${p}</strong> dah disahkan berjaya.`,
    amountLabel: 'Jumlah Dibayar',
    footer: 'fee',
    defaultName: 'Ahli MARC',
  },
  activity_fee: {
    label: 'Aktiviti',
    subject: 'Resit Yuran Aktiviti MARC',
    tagline: 'Bukti pembayaran yuran kelab',
    intro: (p) => `Pembayaran anda untuk <strong>${p}</strong> dah disahkan berjaya.`,
    amountLabel: 'Jumlah Dibayar',
    footer: 'fee',
    defaultName: 'Ahli MARC',
  },
  donation: {
    label: 'Sokongan',
    subject: 'Terima kasih kerana menyokong MARC',
    tagline: 'Resit sokongan penyelenggaraan',
    intro: () => `Sokongan anda untuk MARC dah selamat diterima. Duit ni pergi
            terus kepada saya untuk menampung kos hosting, domain dan masa
            penyelenggaraan supaya app ni kekal berjalan dan percuma untuk
            semua ahli.`,
    amountLabel: 'Jumlah Sokongan',
    footer: 'donation',
    defaultName: 'Penyumbang',
  },
}

const FEE_FOOTER_HTML = `<p style="margin:0;font-size:12px;color:#6B6B6B;line-height:1.5;">
            Emel ini dihantar automatik oleh sistem MARC. Sila simpan resit
            PDF terlampir untuk rekod anda.
          </p>`
const DONATION_FOOTER_HTML = `<p style="margin:0 0 10px;font-size:12px;color:#6B6B6B;line-height:1.5;">
            Sumbangan ini diberikan secara peribadi kepada pembangun MARC.
            Ia <strong>bukan</strong> sumbangan kepada MAIWP atau mana-mana
            badan amal, dan tidak layak untuk pelepasan cukai.
          </p>
          <p style="margin:0;font-size:12px;color:#6B6B6B;line-height:1.5;">
            Emel ini dihantar automatik oleh sistem MARC. Sila simpan resit
            PDF terlampir untuk rekod anda.<br>
            &mdash; Hafiz, pembangun MARC
          </p>`

export type ReceiptEmail = { kind: ReceiptKind; payerName: string; purpose: string; amountCents: number; currency: string; gatewayRef: string; fallbackId: string; paidAt: number | null; pdf: Uint8Array | null }

export function receiptEmail(r: ReceiptEmail) {
  const k = KINDS[r.kind]
  const name = escapeHtml(r.payerName || k.defaultName)
  const c = r.currency.toLowerCase()
  const amount = `${!c || c === 'myr' ? 'RM' : r.currency.toUpperCase()}${(r.amountCents / 100).toFixed(2)}`
  const html = `<!doctype html>
<html>
<body style="margin:0;padding:0;background-color:#FAF9F6;font-family:Helvetica,Arial,sans-serif;color:#1C1B19;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#FAF9F6;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:480px;background-color:#FFFFFF;border-radius:12px;overflow:hidden;">
        <tr><td style="background-color:#2F6B4F;padding:24px 32px;">
          <span style="font-size:20px;font-weight:700;color:#FFFFFF;letter-spacing:0.5px;">MARC</span>
          <div style="margin-top:4px;font-size:12px;color:#D7E5DC;">${k.tagline}</div>
        </td></tr>
        <tr><td style="padding:32px;">
          <p style="margin:0 0 16px;font-size:15px;">Terima kasih, ${name}.</p>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.5;">
            ${k.intro(escapeHtml(r.purpose))}
          </p>
          <p style="margin:0 0 24px;font-size:15px;line-height:1.5;">
            Resit (PDF) dilampirkan bersama emel ini.
          </p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#FAF9F6;border-radius:10px;margin-bottom:24px;">
            <tr><td style="padding:20px 24px;">
              <p style="margin:0 0 4px;font-size:12px;color:#6B6B6B;text-transform:uppercase;letter-spacing:0.5px;">${k.amountLabel}</p>
              <p style="margin:0;font-size:28px;font-weight:700;color:#1C1B19;">${amount}</p>
            </td></tr>
          </table>
          <p style="margin:0 0 4px;font-size:12px;color:#6B6B6B;">No. Rujukan</p>
          <p style="margin:0 0 16px;font-size:14px;color:#1C1B19;">${escapeHtml(r.gatewayRef)}</p>
          <p style="margin:0 0 4px;font-size:12px;color:#6B6B6B;">Tarikh</p>
          <p style="margin:0;font-size:14px;color:#1C1B19;">${formatDateTime(r.paidAt)}</p>
        </td></tr>
        <tr><td style="padding:20px 32px;border-top:1px solid #E4E1DA;">
          ${k.footer === 'fee' ? FEE_FOOTER_HTML : DONATION_FOOTER_HTML}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
  return {
    subject: k.subject,
    html,
    attachments: r.pdf ? [{ filename: filename(k.label, r.gatewayRef, r.fallbackId), content: r.pdf }] : undefined,
  }
}
