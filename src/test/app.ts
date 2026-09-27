// Harness ujian HTTP: app sebenar (createApp) + D1/KV sebenar (testEnv) +
// kebergantungan luaran palsu yang merakam apa yang "dihantar".
//
// `src/test/**` dan `*.test.ts` di-exclude daripada tsconfig.json (program
// Worker) supaya jenis Bun/Node tidak bocor ke kod produksi. Akibatnya editor
// yang memuatkan tsconfig.json meletakkan fail ini di luar projek, dan global
// dari worker-configuration.d.ts (`CloudflareBindings`, `ExecutionContext`)
// jadi "Cannot find name". Dua reference di bawah menambah fail itu kembali ke
// program - dibaca sekali oleh setiap fail ujian yang mengimport harness ini.
/// <reference path="../../worker-configuration.d.ts" />
/// <reference path="../shared/assets.d.ts" />
import { createApp, type AppDeps } from '../app'
import type { Email } from '../shared/email'
import type { JobMessage } from '../shared/jobs'
import { signAccess } from '../shared/jwt'
import { TEST_SECRETS, testEnv } from './env'

export async function testApp(vars: Record<string, string> = {}) {
  const t = await testEnv()
  const sent = { emails: [] as Email[], jobs: [] as JobMessage[], telegram: [] as { chatId: number; text: string }[] }
  const deps: AppDeps = {
    sendEmail: async (_config, email) => void sent.emails.push(email),
    enqueue: async (_env, message) => void sent.jobs.push(message),
    sendTelegram: async (_config, chatId, text) => void sent.telegram.push({ chatId, text }),
  }
  const app = createApp(deps)

  // Had kadar dimatikan - ujian menghantar banyak permintaan dari satu "IP".
  const noLimit = { limit: async () => ({ success: true }) }
  const rateLimits = Object.fromEntries(Object.keys(t.env).filter((k) => k.startsWith('RL_')).map((k) => [k, noLimit]))
  const env = { ...t.env, ...rateLimits, PUBLIC_BASE_URL: 'https://api.marc.test', ...vars } as CloudflareBindings

  async function request(path: string, init: RequestInit & { json?: unknown; token?: string; ip?: string } = {}, envOverride: Record<string, unknown> = {}) {
    const pending: Promise<unknown>[] = []
    const headers = new Headers(init.headers)
    headers.set('CF-Connecting-IP', init.ip ?? '10.0.0.1')
    if (init.token) headers.set('Authorization', `Bearer ${init.token}`)
    if (init.json !== undefined) headers.set('Content-Type', 'application/json')
    const res = await app.request(
      path,
      { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body },
      { ...env, ...envOverride },
      { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext,
    )
    await Promise.all(pending) // kerja waitUntil selesai sebelum ujian menyemak
    return res
  }

  const body = async (res: Response) => (await res.json()) as Record<string, unknown>
  // Satu baris sebagai rekod longgar (NoInfer: jangan simpulkan jenis dari expect()).
  const row = (sql: string, ...params: unknown[]): Promise<NoInfer<Record<string, unknown>> | null> => env.DB.prepare(sql).bind(...params).first()

  return { env, sent, request, body, row, db: env.DB, dispose: t.dispose }
}

export type Harness = Awaited<ReturnType<typeof testApp>>

// id peranan seed (migrasi members) - guna nama, bukan nombor ajaib.
export const ROLE = { ahli: 1, supervisor: 2, manager: 3, superadmin: 4, tester: 5, admin: 6 } as const

let seq = 0

// Ahli fixture TANPA kata laluan sebenar (tiada kos bcrypt): cukup untuk
// sasaran pengurusan. Pemanggil yang perlukan token guna tokenFor().
export async function seedMember(
  h: Harness,
  opts: { role?: number; status?: string; staffVerified?: boolean; memberId?: string | null; avatar?: string | null; displayName?: string } = {},
) {
  const n = ++seq
  const id = crypto.randomUUID()
  const email = `ahli${n}@gmail.com`
  const staffId = `S-${n}`
  await h.db.batch([
    h.db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)').bind(id, email, 'x'),
    h.db
      .prepare(
        `INSERT INTO profiles (id, user_id, role_id, staff_id, status, staff_id_verified_at, member_id, avatar_r2_key, display_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), id, opts.role ?? ROLE.ahli, staffId, opts.status ?? 'approved', opts.staffVerified ? Date.now() : null, opts.memberId ?? null, opts.avatar ?? null, opts.displayName ?? `Ahli ${n}`),
  ])
  return { id, email, staffId }
}

// requireAuth tidak menyentuh D1 (senarai tolak KV sahaja - modules/00-shared.md),
// jadi token sah boleh dijana terus: ujian feature tidak perlu bayar bcrypt
// login, dan kebergantungan pada features/auth dikurangkan.
export async function tokenFor(userId: string): Promise<string> {
  return signAccess(TEST_SECRETS.JWT_SECRET, 15, userId, crypto.randomUUID())
}

export const updatedAtOf = async (h: Harness, userId: string): Promise<number> =>
  (await h.db.prepare('SELECT updated_at FROM profiles WHERE user_id = ?').bind(userId).first<{ updated_at: number }>())!.updated_at
