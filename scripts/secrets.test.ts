import { describe, expect, test } from 'bun:test'
import { parseEnv, planSecrets, secretKeys } from './secrets-lib'

const vars = { EMAIL_FROM: '', PUBLIC_BASE_URL: 'https://x.my' }
const secrets = secretKeys(vars)

describe('secrets', () => {
  test('var wrangler bukan rahsia', () => {
    expect(secrets).toContain('JWT_SECRET')
    expect(secrets).not.toContain('EMAIL_FROM')
  })

  test('parseEnv: komen, petikan, export, baris kosong', () => {
    const env = parseEnv(`# komen\n\nexport JWT_SECRET="${'a'.repeat(32)}"\nRESEND_API_KEY='re_1=2'\nSTRIPE_SECRET_KEY=\n`)
    expect(env.get('JWT_SECRET')).toBe('a'.repeat(32))
    expect(env.get('RESEND_API_KEY')).toBe('re_1=2')
    expect(env.get('STRIPE_SECRET_KEY')).toBe('')
  })

  test('parseEnv: baris rosak ditolak tanpa mencetak nilai', () => {
    expect(() => parseEnv('rahsia-tanpa-kunci')).toThrow('baris tidak sah: rahsia-tanpa-kunci')
    expect(() => parseEnv('bad key=nilai-rahsia')).toThrow(/^baris tidak sah: bad key$/)
  })

  test('planSecrets: tolak, langkau, ralat', () => {
    const plan = planSecrets(
      new Map([
        ['JWT_SECRET', 'a'.repeat(32)],
        ['RESEND_API_KEY', ''],
        ['EMAIL_FROM', 'x@y.my'],
        ['STRIPE_SECRT_KEY', 'typo'],
      ]),
      secrets,
      vars,
    )
    expect(plan.push).toEqual({ JWT_SECRET: 'a'.repeat(32) })
    expect(plan.skipped).toEqual(['RESEND_API_KEY'])
    expect(plan.errors).toHaveLength(2)
  })

  test('ENVIRONMENT (tindihan lokal) dilangkau, bukan ralat', () => {
    const plan = planSecrets(new Map([['ENVIRONMENT', 'development']]), secrets, { ...vars, ENVIRONMENT: 'production' })
    expect(plan).toEqual({ push: {}, skipped: ['ENVIRONMENT'], errors: [] })
  })

  test('JWT_SECRET pendek ditolak', () => {
    expect(planSecrets(new Map([['JWT_SECRET', 'pendek']]), secrets, vars).errors).toHaveLength(1)
  })
})
