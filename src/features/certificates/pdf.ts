// Logik sijil TULEN - tiada DB, tiada rangkaian (pariti marc_go
// internal/certificate). Susun atur = certificate.go (mm, A4 landskap).
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { encode } from 'uqr'
import { color, MmPage, PT, unprintable } from '../../shared/pdf'

// Integer, bukan float: 2/3 @ 66 layak, @ 67 tidak - sama di setiap platform.
export function isEligible(attended: number, totalSessions: number, thresholdPct: number): boolean {
  if (totalSessions <= 0) return false
  return attended * 100 >= totalSessions * thresholdPct
}

export { unprintable }

export type TemplateStyle = {
  primary_color: string
  secondary_color: string
  title: string
  subtitle: string
  body_text: string
  issuer_name: string
  signature_name: string
  footer_text: string
}

export type CertificateData = {
  serial: string
  recipientName: string
  activityTitle: string
  categoryName: string
  activityDate: string // YYYY-MM-DD (MYT)
  verifyUrl: string
  template: TemplateStyle
}

const BRAND = [16, 94, 74] as const
const BRAND_DARK = [9, 61, 48] as const
const MUTED = [110, 116, 122] as const

function hex(value: string, fallback: readonly number[]) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value)
  return color(m ? m.slice(1).map((h) => parseInt(h, 16)) : fallback)
}

const BULAN = ['Januari', 'Februari', 'Mac', 'April', 'Mei', 'Jun', 'Julai', 'Ogos', 'September', 'Oktober', 'November', 'Disember']
export function formatTarikh(date: string) {
  const [y, m, d] = date.split('-').map(Number)
  return `${d} ${BULAN[m! - 1]} ${y}`
}

// A4 landskap, mm → pt, asal kiri-atas (fpdf) → kiri-bawah (PDF).
const PAGE_W = 297
const PAGE_H = 210
const MARGIN = 20
const CONTENT_W = PAGE_W - 2 * MARGIN

function withDefaults(t: TemplateStyle): TemplateStyle {
  return {
    ...t,
    primary_color: t.primary_color || '#105e4a',
    secondary_color: t.secondary_color || '#093d30',
    title: t.title || 'SIJIL PENYERTAAN',
    subtitle: t.subtitle || 'Dengan ini disahkan bahawa',
    body_text: t.body_text || 'telah menyertai',
  }
}

export async function generatePdf(d: CertificateData): Promise<Uint8Array> {
  const style = withDefaults(d.template)
  // Setiap medan yang dicetak sebagai teks (VerifyUrl masuk ke QR sahaja).
  const fields: [string, string][] = [
    ['Serial', d.serial],
    ['RecipientName', d.recipientName],
    ['ActivityTitle', d.activityTitle],
    ['CategoryName', d.categoryName],
    ['TemplateTitle', style.title],
    ['TemplateSubtitle', style.subtitle],
    ['TemplateBodyText', style.body_text],
    ['TemplateIssuerName', style.issuer_name],
    ['TemplateSignatureName', style.signature_name],
    ['TemplateFooterText', style.footer_text],
  ]
  for (const [name, value] of fields) {
    const bad = unprintable(value)
    if (bad) throw new Error(`medan ${name} mengandungi aksara yang tidak boleh dicetak ('${bad}'): ${JSON.stringify(value)}`)
  }

  const doc = await PDFDocument.create()
  doc.setTitle(`Sijil Penyertaan ${d.serial}`)
  doc.setAuthor('MARC')
  const page = doc.addPage([PAGE_W * PT, PAGE_H * PT])
  const regular = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const primary = hex(style.primary_color, BRAND)
  const secondary = hex(style.secondary_color, BRAND_DARK)
  const muted = hex('', MUTED)

  const p = new MmPage(page, { heightMm: PAGE_H, marginMm: MARGIN })
  // Sel pada kedudukan mutlak (setiap baris sijil diletak dengan SetXY dalam marc_go).
  const cell = (text: string, x: number, y: number, w: number, h: number, align: 'L' | 'C' | 'R', font: typeof bold, size: number, ink: ReturnType<typeof rgb>) => {
    p.font(font, size)
    p.ink(ink)
    p.x = x
    p.y = y
    p.cell(w, h, text, 0, align)
  }
  const clip = (text: string, font: typeof bold, size: number, maxW: number) => {
    p.font(font, size)
    return p.clip(text, maxW)
  }

  // Bingkai
  p.rect(0, 0, PAGE_W, 14, primary)
  p.rect(0, 14, PAGE_W, 1.6, secondary)
  p.rect(10, 22, PAGE_W - 20, PAGE_H - 32, undefined, { color: primary, widthMm: 0.6 })

  // Tajuk
  cell('MARC', MARGIN, 3, CONTENT_W, 8, 'L', bold, 15, rgb(1, 1, 1))
  cell(style.title, MARGIN, 42, CONTENT_W, 14, 'C', bold, 30, primary)
  cell(style.subtitle, MARGIN, 56, CONTENT_W, 8, 'C', regular, 11, muted)

  // Penerima
  cell(clip(d.recipientName, bold, 26, CONTENT_W), MARGIN, 78, CONTENT_W, 14, 'C', bold, 26, secondary)
  cell(style.body_text, MARGIN, 92, CONTENT_W, 8, 'C', regular, 11, muted)
  cell(clip(d.activityTitle, bold, 16, CONTENT_W), MARGIN, 100, CONTENT_W, 10, 'C', bold, 16, primary)
  cell(clip(`${d.categoryName}  •  ${formatTarikh(d.activityDate)}`, regular, 11, CONTENT_W), MARGIN, 110, CONTENT_W, 7, 'C', regular, 11, muted)

  // QR (28 mm, zon senyap 4 modul) + kaki
  const qr = encode(d.verifyUrl, { ecc: 'M', border: 4 })
  const mod = 28 / qr.data.length
  const qx = PAGE_W - MARGIN - 28
  const qy = PAGE_H - 58
  qr.data.forEach((row, r) => row.forEach((dark, c) => dark && p.rect(qx + c * mod, qy + r * mod, mod, mod, rgb(0, 0, 0))))

  const footY = PAGE_H - 44
  cell(`No. Sijil  ${d.serial}`, MARGIN, footY, CONTENT_W / 2, 5, 'L', regular, 9, muted)
  cell(style.footer_text, MARGIN, footY + 5, CONTENT_W / 2, 5, 'L', regular, 9, muted)
  // Berakhir sebelum QR (marc_go: sel sampai x=277 dan bertindih dengan QR).
  const signW = qx - 4 - PAGE_W / 2
  cell(style.signature_name, PAGE_W / 2, footY, signW, 5, 'R', regular, 9, muted)
  cell(style.issuer_name, PAGE_W / 2, footY + 5, signW, 5, 'R', regular, 9, muted)

  return doc.save()
}
