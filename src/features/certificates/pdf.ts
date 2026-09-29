// Logik sijil TULEN - tiada DB, tiada rangkaian (pariti marc_go
// internal/certificate). Susun atur = certificate.go (mm, A4 landskap).
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import { encode } from 'uqr'

// Integer, bukan float: 2/3 @ 66 layak, @ 67 tidak - sama di setiap platform.
export function isEligible(attended: number, totalSessions: number, thresholdPct: number): boolean {
  if (totalSessions <= 0) return false
  return attended * 100 >= totalSessions * thresholdPct
}

// Set WinAnsi (cp1252) - pengekodan font standard PDF. Aksara di luar set
// dikesan SEBELUM melukis dan medannya dinamakan (R11), bukan hilang senyap.
const WIN_ANSI = new Set<number>([
  ...Array.from({ length: 0x7f - 0x20 }, (_, i) => 0x20 + i),
  ...Array.from({ length: 0x100 - 0xa0 }, (_, i) => 0xa0 + i),
  ...[...'€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'].map((c) => c.codePointAt(0)!),
])

export const unprintable = (s: string): string | null => [...s].find((c) => !WIN_ANSI.has(c.codePointAt(0)!)) ?? null

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
  const [r, g, b] = m ? m.slice(1).map((h) => parseInt(h, 16)) : fallback
  return rgb(r! / 255, g! / 255, b! / 255)
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
const PT = 72 / 25.4
const C_MARGIN = 1 // padding sel fpdf

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

  const rect = (x: number, y: number, w: number, h: number, o: { fill?: ReturnType<typeof rgb>; stroke?: ReturnType<typeof rgb> }) =>
    page.drawRectangle({
      x: x * PT,
      y: (PAGE_H - y - h) * PT,
      width: w * PT,
      height: h * PT,
      ...(o.fill && { color: o.fill }),
      ...(o.stroke && { borderColor: o.stroke, borderWidth: 0.6 * PT }),
    })

  // Pariti CellFormat fpdf: baseline = y + h/2 + 0.3 × saiz fon.
  const cell = (p: PDFPage, text: string, x: number, y: number, w: number, h: number, align: 'L' | 'C' | 'R', font: PDFFont, size: number, color: ReturnType<typeof rgb>) => {
    const width = font.widthOfTextAtSize(text, size) / PT
    const tx = align === 'L' ? x + C_MARGIN : align === 'C' ? x + (w - width) / 2 : x + w - C_MARGIN - width
    const baseline = y + h / 2 + 0.3 * (size / PT)
    p.drawText(text, { x: tx * PT, y: (PAGE_H - baseline) * PT, size, font, color })
  }

  // Potong teks yang melebihi sel (fpdf/pdf-lib tidak memotong sendiri).
  const clip = (s: string, font: PDFFont, size: number, maxW: number) => {
    maxW -= 2
    const fits = (t: string) => font.widthOfTextAtSize(t, size) / PT <= maxW
    if (fits(s)) return s
    const chars = [...s]
    while (chars.length > 1) {
      chars.pop()
      if (fits(chars.join('') + '...')) return chars.join('') + '...'
    }
    return s
  }

  // Bingkai
  rect(0, 0, PAGE_W, 14, { fill: primary })
  rect(0, 14, PAGE_W, 1.6, { fill: secondary })
  rect(10, 22, PAGE_W - 20, PAGE_H - 32, { stroke: primary })

  // Tajuk
  cell(page, 'MARC', MARGIN, 3, CONTENT_W, 8, 'L', bold, 15, rgb(1, 1, 1))
  cell(page, style.title, MARGIN, 42, CONTENT_W, 14, 'C', bold, 30, primary)
  cell(page, style.subtitle, MARGIN, 56, CONTENT_W, 8, 'C', regular, 11, muted)

  // Penerima
  cell(page, clip(d.recipientName, bold, 26, CONTENT_W), MARGIN, 78, CONTENT_W, 14, 'C', bold, 26, secondary)
  cell(page, style.body_text, MARGIN, 92, CONTENT_W, 8, 'C', regular, 11, muted)
  cell(page, clip(d.activityTitle, bold, 16, CONTENT_W), MARGIN, 100, CONTENT_W, 10, 'C', bold, 16, primary)
  cell(page, clip(`${d.categoryName}  •  ${formatTarikh(d.activityDate)}`, regular, 11, CONTENT_W), MARGIN, 110, CONTENT_W, 7, 'C', regular, 11, muted)

  // QR (28 mm, zon senyap 4 modul) + kaki
  const qr = encode(d.verifyUrl, { ecc: 'M', border: 4 })
  const mod = 28 / qr.data.length
  const qx = PAGE_W - MARGIN - 28
  const qy = PAGE_H - 58
  qr.data.forEach((row, r) => row.forEach((dark, c) => dark && rect(qx + c * mod, qy + r * mod, mod, mod, { fill: rgb(0, 0, 0) })))

  const footY = PAGE_H - 44
  cell(page, `No. Sijil  ${d.serial}`, MARGIN, footY, CONTENT_W / 2, 5, 'L', regular, 9, muted)
  cell(page, style.footer_text, MARGIN, footY + 5, CONTENT_W / 2, 5, 'L', regular, 9, muted)
  // Berakhir sebelum QR (marc_go: sel sampai x=277 dan bertindih dengan QR).
  const signW = qx - 4 - PAGE_W / 2
  cell(page, style.signature_name, PAGE_W / 2, footY, signW, 5, 'R', regular, 9, muted)
  cell(page, style.issuer_name, PAGE_W / 2, footY + 5, signW, 5, 'R', regular, 9, muted)

  return doc.save()
}
