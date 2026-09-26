// Pariti marc_go internal/disposableemail. Senarai statik (8,201 domain,
// github.com/disposable-email-domains) ialah pertahanan utama; jadual
// blocked_email_domains (features/blocked-email-domains) pelengkap.
import domainsFile from './disposable-domains.txt'

const staticDomains = new Set(
  domainsFile
    .split('\n')
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l && !l.startsWith('#')),
)

// Akaun tester review Google Play / App Store SENGAJA guna yopmail.com.
// Alamat PENUH, bukan domain. Dihormati juga oleh semakan jadual DB.
const allowedEmails = new Set(['google@yopmail.com', 'apple@yopmail.com'])

export const isAllowed = (email: string): boolean => allowedEmails.has(email)

// `email` mesti sudah huruf kecil + trim.
export function domainOf(email: string): string {
  const at = email.lastIndexOf('@')
  return at < 0 || at === email.length - 1 ? '' : email.slice(at + 1).toLowerCase()
}

export function isDisposable(email: string): boolean {
  if (allowedEmails.has(email)) return false
  const domain = domainOf(email)
  return domain !== '' && staticDomains.has(domain)
}
