// Lapisan nipis pdf-lib yang meniru semantik fpdf marc_go (mm, asal kiri-atas,
// Cell/MultiCell/Ln, cMargin 1 mm, baseline y + h/2 + 0.3·saiz) supaya susun
// atur sijil & resit boleh disalin terus daripada kod Go.
import { rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib'

export const PT = 72 / 25.4

// Set WinAnsi (cp1252) - pengekodan font standard PDF.
const WIN_ANSI = new Set<number>([
  ...Array.from({ length: 0x7f - 0x20 }, (_, i) => 0x20 + i),
  ...Array.from({ length: 0x100 - 0xa0 }, (_, i) => 0xa0 + i),
  ...[...'€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'].map((c) => c.codePointAt(0)!),
])

// Aksara pertama di luar set, atau null.
export const unprintable = (s: string): string | null => [...s].find((c) => !WIN_ANSI.has(c.codePointAt(0)!)) ?? null

// Pariti penterjemah fpdf: aksara di luar set jadi '.' secara senyap (resit).
export const winAnsi = (s: string): string => [...s].map((c) => (WIN_ANSI.has(c.codePointAt(0)!) ? c : '.')).join('')

export const color = ([r, g, b]: readonly number[]): RGB => rgb(r! / 255, g! / 255, b! / 255)

type Align = 'L' | 'C' | 'R'

const C_MARGIN = 1 // padding sel fpdf

export class MmPage {
  x: number
  y: number
  private lastH = 0
  private f!: PDFFont
  private size = 10
  private inkColor = rgb(0, 0, 0)

  constructor(
    private page: PDFPage,
    private o: { heightMm: number; marginMm: number },
  ) {
    this.x = o.marginMm
    this.y = o.marginMm
  }

  font(f: PDFFont, pt: number) {
    this.f = f
    this.size = pt
  }

  ink(c: RGB) {
    this.inkColor = c
  }

  width(text: string) {
    return this.f.widthOfTextAtSize(text, this.size) / PT
  }

  rect(x: number, y: number, w: number, h: number, fill?: RGB, stroke?: { color: RGB; widthMm: number }) {
    this.page.drawRectangle({
      x: x * PT,
      y: (this.o.heightMm - y - h) * PT,
      width: w * PT,
      height: h * PT,
      ...(fill && { color: fill }),
      ...(stroke && { borderColor: stroke.color, borderWidth: stroke.widthMm * PT }),
    })
  }

  line(x1: number, y1: number, x2: number, y2: number, c: RGB, widthMm: number) {
    const H = this.o.heightMm
    this.page.drawLine({ start: { x: x1 * PT, y: (H - y1) * PT }, end: { x: x2 * PT, y: (H - y2) * PT }, color: c, thickness: widthMm * PT })
  }

  // CellFormat fpdf. ln: 0 = ke kanan, 1 = baris baharu dari margin, 2 = ke bawah.
  cell(w: number, h: number, text: string, ln: 0 | 1 | 2 = 0, align: Align = 'L', fill?: RGB) {
    if (fill) this.rect(this.x, this.y, w, h, fill)
    if (text) {
      const tw = this.width(text)
      const tx = align === 'L' ? this.x + C_MARGIN : align === 'C' ? this.x + (w - tw) / 2 : this.x + w - C_MARGIN - tw
      const baseline = this.y + h / 2 + 0.3 * (this.size / PT)
      this.page.drawText(text, { x: tx * PT, y: (this.o.heightMm - baseline) * PT, size: this.size, font: this.f, color: this.inkColor })
    }
    this.lastH = h
    if (ln === 0) this.x += w
    else if (ln === 1) this.ln(h)
    else this.y += h
  }

  // MultiCell fpdf: bungkus ikut perkataan dalam lebar sel, x kembali ke margin.
  multiCell(w: number, h: number, text: string) {
    const max = w - 2 * C_MARGIN
    const lines: string[] = []
    let cur = ''
    for (const word of text.split(/\s+/)) {
      const next = cur ? `${cur} ${word}` : word
      if (cur && this.width(next) > max) {
        lines.push(cur)
        cur = word
      } else cur = next
    }
    if (cur) lines.push(cur)
    const x = this.x
    for (const l of lines) {
      this.x = x
      this.cell(w, h, l, 2)
    }
    this.x = this.o.marginMm
  }

  ln(h = this.lastH) {
    this.x = this.o.marginMm
    this.y += h
  }

  // Potong teks melebihi lebar sel (fpdf/pdf-lib tidak memotong sendiri).
  clip(text: string, maxW: number) {
    maxW -= 2
    if (this.width(text) <= maxW) return text
    const chars = [...text]
    while (chars.length > 1) {
      chars.pop()
      if (this.width(chars.join('') + '...') <= maxW) return chars.join('') + '...'
    }
    return text
  }
}
