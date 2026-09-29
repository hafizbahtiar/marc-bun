// Port legacyimport_test.go baris-demi-baris + pembaca CSV.
import { describe, expect, test } from 'bun:test'
import { canonicalDepartment, HEADER_NAMES, parse, readCsv, validate } from './parse'

const codes = (r: { conflicts: { code: string }[] }) => r.conflicts.map((c) => c.code).sort()

describe('parse', () => {
  test('header dicari selepas mukadimah buku kerja', () => {
    const input = [
      ',,,,,',
      'SENARAI DAFTAR AHLI,,,,,',
      HEADER_NAMES.join(','),
      '1,Aktif,LAMA,Tiada,MARC-,1234,/,2026,-,1,MARC-1234/2026-1,Nama Ahli,0123456789,nama@example.com,BPI,,Pegawai,,,,,,',
    ].join('\n')
    const report = parse(input)
    expect([report.headerRow, report.totalRows, report.validRows, report.rows[0]!.normalizedEmail, report.rows[0]!.sourceRow]).toEqual([3, 1, 1, 'nama@example.com', 4])
  })

  test('placeholder dan pendua ditanda pada kedua-dua baris', () => {
    const input = [
      HEADER_NAMES.join(','),
      '1,Aktif,LAMA,Tiada,MARC-,XXXX,/,2026,-,1,MARC-0001/2026-1,Nama Satu,0123456789,a@example.com,BPI,,,,,,,,',
      '2,Aktif,LAMA,Tiada,MARC-,XXXX,/,2026,-,2,MARC-0002/2026-2,Nama Dua,0123456789,a@example.com,BPI,,,,,,,,',
      'Petunjuk:,warna merah = konflik', // legenda (Bil. bukan nombor) dilangkau
    ].join('\n')
    const report = parse(input)
    expect(report.validRows).toBe(0)
    expect(report.rows.map(codes)).toEqual([
      ['duplicate_email', 'duplicate_staff_id', 'placeholder_staff_id'],
      ['duplicate_email', 'duplicate_staff_id', 'placeholder_staff_id'],
    ])
  })

  test('validate: emel & status tidak sah; telefon tidak sah = amaran', () => {
    const row = validate({
      sourceRow: 1, legacyNumber: '', status: 'Unknown', category: '', clubPosition: '', legacyStaffId: '1234', registrationYear: 'dua ribu',
      memberId: 'MARC-1234/2026-1', displayName: 'Nama', phone: 'not-a-phone', email: 'bad', departmentCode: '', address: '', position: '',
      emergencyName: '', emergencyPhone: '', healthNotes: '',
    }) // prettier-ignore
    expect(codes(row)).toEqual(['invalid_email', 'invalid_registration_year', 'invalid_status'])
    expect(row.warnings.map((w) => w.code)).toEqual(['invalid_phone_cleared'])
  })

  test('kod bahagian kanonik tidak peka huruf', () => {
    const depts = new Map([['bpi', 'BPI']])
    expect([canonicalDepartment(' bpi ', depts), canonicalDepartment('UNKNOWN', depts), canonicalDepartment('', depts)]).toEqual(['BPI', null, ''])
  })

  test('tiada header → ralat', () => {
    expect(() => parse('a,b,c\n1,2,3')).toThrow('header CSV MARC tidak ditemui')
  })
})

describe('readCsv', () => {
  test('petikan: koma, baris baharu, "" dan petikan malas; CRLF', () => {
    expect(readCsv('a,"b,c","d\r\ne",f\r\n"x ""y""",z"q,\n')).toEqual([
      ['a', 'b,c', 'd\r\ne', 'f'],
      ['x "y"', 'z"q', ''],
    ])
  })
})
