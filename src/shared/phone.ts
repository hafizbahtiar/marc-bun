// Pariti marc_go internal/phone (dan shared/phone.dart di Flutter - kedua-dua
// mesti membersihkan input yang SAMA). Malaysia sahaja.
//   01[0,2-4,6-9] + 7 digit (10 digit) · 011 + 8 digit (11 digit)
const MY_MOBILE = /^(01[02-46-9]\d{7}|011\d{8})$/
const CLEAN = /[\s\-()]/g

// Terima +60 / 60 / 0; pulang bentuk tempatan `0XXXXXXXXX`, atau null.
export function normalizeMY(raw: string): string | null {
  let s = raw.trim().replace(CLEAN, '')
  if (s.startsWith('+60')) s = '0' + s.slice(3)
  else if (s.startsWith('60') && s.length >= 11) s = '0' + s.slice(2)
  return MY_MOBILE.test(s) ? s : null
}
