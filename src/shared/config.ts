import { z } from 'zod'

// Satu-satunya tempat env dibaca sebagai konfigurasi. Rahsia (`wrangler secret`)
// tidak dijana oleh `wrangler types`, jadi jenisnya datang dari schema ini.
//
// Kosong = ciri mati. Tiga kelakuan marc_go dikekalkan oleh pemanggil, bukan
// di sini: no-op senyap (emel, push), 503 jelas (reset kata laluan, upload),
// fallback (URL pengesahan) - docs/00000-foundation.md §4.
const optional = z.string().trim().default('')
const int = (fallback: number) => z.coerce.number().int().nonnegative().default(fallback)
const list = z
  .string()
  .default('')
  .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))

const schema = z.object({
  ENVIRONMENT: z.enum(['development', 'production']).default('production'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET wajib, sekurang-kurangnya 32 aksara'),
  ACCESS_TOKEN_TTL_MINUTES: int(15),
  REFRESH_TOKEN_TTL_DAYS: int(30),

  PUBLIC_BASE_URL: optional,
  EMAIL_VERIFY_URL: optional,
  CLAIM_ACCOUNT_URL: optional,
  PASSWORD_RESET_URL: optional,
  CERTIFICATE_VERIFY_URL: optional,
  REGISTRATION_PAYMENT_RETURN_URL: optional,
  ACTIVITY_PAYMENT_RETURN_URL: optional,
  CORS_ALLOWED_ORIGINS: list,

  RESEND_API_KEY: optional,
  EMAIL_FROM: optional,

  STRIPE_SECRET_KEY: optional,
  STRIPE_PUBLISHABLE_KEY: optional,
  STRIPE_WEBHOOK_SECRET: optional,
  TOYYIBPAY_BASE_URL: optional,
  TOYYIBPAY_SECRET_KEY: optional,
  TOYYIBPAY_CATEGORY_CODE: optional,
  REGISTRATION_FEE_CENTS: int(1000),
  GATEWAY_CHARGE_CENTS: int(100),
  REGISTRATION_BILL_EXPIRY_MINUTES: int(30),

  ONESIGNAL_APP_ID: optional,
  ONESIGNAL_API_KEY: optional,

  TELEGRAM_BOT_TOKEN: optional,
  TELEGRAM_BOT_USERNAME: optional,
  TELEGRAM_WEBHOOK_SECRET: optional,

  R2_ACCOUNT_ID: optional,
  R2_ACCESS_KEY_ID: optional,
  R2_SECRET_ACCESS_KEY: optional,
  R2_BUCKET_NAME: optional,

  AUDIT_PII_RETENTION_DAYS: int(90),
  AUDIT_RECORD_RETENTION_DAYS: int(365),
  UPLOAD_TOMBSTONE_RETENTION_DAYS: int(30),
  PAYMENT_LOG_RETENTION_DAYS: int(90),
})

export type Config = z.infer<typeof schema>

// Senarai kunci - dipakai oleh scripts/secrets-check.ts.
export const CONFIG_KEYS = Object.keys(schema.shape) as (keyof Config)[]

export class ConfigError extends Error { }

export function getConfig(env: object): Config {
  const result = schema.safeParse(env)
  if (!result.success) {
    const issue = result.error.issues[0]
    throw new ConfigError(`config ${issue?.path.join('.')}: ${issue?.message}`)
  }
  return result.data
}
