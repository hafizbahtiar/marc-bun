import { describe, expect, test } from 'bun:test'
import { formatTarikh, generatePdf, isEligible, unprintable, type CertificateData } from './pdf'

const template = { primary_color: '#E21E28', secondary_color: '#223145', title: 'Sijil Penyertaan', subtitle: 'MARC', body_text: 'x', issuer_name: 'MARC', signature_name: 'Pengurusan MARC', footer_text: 'f' }
const data = (over: Partial<CertificateData> = {}): CertificateData => ({
  serial: 'MARC-2026-000001',
  recipientName: 'Ali',
  activityTitle: 'Hiking',
  categoryName: 'Hiking',
  activityDate: '2026-09-01',
  verifyUrl: 'https://marc.test/sahkan-sijil?token=abc',
  template,
  ...over,
})

describe('pdf', () => {
  test('isEligible: integer, sempadan 66/67, 0 sesi', () => {
    expect([isEligible(2, 3, 66), isEligible(2, 3, 67), isEligible(0, 0, 1), isEligible(3, 3, 100)]).toEqual([true, false, false, true])
  })

  test('WinAnsi: set semakan = apa yang pdf-lib boleh lukis', async () => {
    const all = String.fromCodePoint(...[...Array(0x100).keys()].filter((c) => !unprintable(String.fromCodePoint(c))), ...[...'€’“”•–—™'].map((c) => c.codePointAt(0)!))
    const pdf = await generatePdf(data({ recipientName: all.slice(0, 60), activityTitle: all.slice(60) }))
    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe('%PDF-')
    expect([unprintable('Nur Aisyah’s'), unprintable('锦标赛'), unprintable('Ali 😀')]).toEqual([null, '锦', '😀'])
  })

  test('medan tidak boleh dicetak dinamakan', async () => {
    await expect(generatePdf(data({ recipientName: '锦标赛' }))).rejects.toThrow(`medan RecipientName mengandungi aksara yang tidak boleh dicetak ('锦'): "锦标赛"`)
    expect(formatTarikh('2026-09-01')).toBe('1 September 2026')
  })
})
