// Harness ujian HTTP: app sebenar (createApp) + D1/KV sebenar (testEnv) +
// kebergantungan luaran palsu yang merakam apa yang "dihantar".
import { createApp, type AppDeps } from '../app'
import type { Email } from '../shared/email'
import type { JobMessage } from '../shared/jobs'
import { testEnv } from './env'

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
