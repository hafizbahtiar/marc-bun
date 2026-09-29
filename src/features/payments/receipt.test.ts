import { describe, expect, test } from 'bun:test'
import { amountInWords, donationPdf, feePdf, filename, formatAmount, formatDateTime, receiptEmail } from './receipt'

describe('resit', () => {
  test('format pariti Go', () => {
    expect(amountInWords(123456, 'myr')).toBe('Ringgit Malaysia Seribu Dua Ratus Tiga Puluh Empat Dan Lima Puluh Enam Sen sahaja')
    expect([amountInWords(6000, 'MYR'), amountInWords(1100, ''), amountInWords(50, 'myr'), amountInWords(100, 'usd')]).toEqual([
      'Ringgit Malaysia Enam Puluh sahaja',
      'Ringgit Malaysia Sebelas sahaja',
      'Ringgit Malaysia Lima Puluh Sen sahaja',
      '',
    ])
    expect([formatAmount(123456, 'myr'), formatAmount(5, 'usd'), formatAmount(-100, 'myr')]).toEqual(['RM1,234.56', 'USD 0.05', '-RM1.00'])
    expect([formatDateTime(Date.UTC(2026, 0, 1, 16, 30)), formatDateTime(Date.UTC(2026, 0, 1, 4, 5)), formatDateTime(null)]).toEqual(['2 Jan 2026, 12:30 AM (MYT)', '1 Jan 2026, 12:05 PM (MYT)', '-'])
    expect([filename('Sokongan', 'pi_1/x', 'id'), filename('Aktiviti', '  ', 'abc-1'), filename('X', '///', '')]).toEqual(['Resit-Sokongan-MARC-pi_1-x.pdf', 'Resit-Aktiviti-MARC-abc-1.pdf', 'Resit-X-MARC-MARC.pdf'])
  })

  test('PDF dijana; nama bukan-WinAnsi tidak menggagalkan resit (pariti fpdf: diganti)', async () => {
    const fee = await feePdf({ memberId: '', payerName: '锦标赛', payerEmail: 'a@b', amountCents: 6000, currency: 'myr', gatewayRef: 'b1', paidAt: 1, purpose: 'Yuran', gatewayChargeCents: 100 })
    const don = await donationPdf({ memberId: '', donorName: '', donorEmail: '', amountCents: 100, currency: 'myr', gatewayRef: 'pi', paidAt: null })
    expect([fee, don].map((b) => new TextDecoder().decode(b.slice(0, 5)))).toEqual(['%PDF-', '%PDF-'])
    const mail = receiptEmail({ kind: 'activity_fee', payerName: '<b>Ali</b>', purpose: 'Hiking & Kem', amountCents: 1500, currency: 'myr', gatewayRef: 'b1', fallbackId: '', paidAt: 1, pdf: fee })
    expect(mail.subject).toBe('Resit Yuran Aktiviti MARC')
    expect(mail.html).toContain('Terima kasih, &lt;b&gt;Ali&lt;/b&gt;.')
    expect(mail.html).toContain('<strong>Hiking &amp; Kem</strong>')
    expect(mail.html).toContain('RM15.00')
    expect(mail.attachments![0]!.filename).toBe('Resit-Aktiviti-MARC-b1.pdf')
  })
})
