// Binding sebenar (D1/KV/R2/Queue) untuk `bun test`, melalui workerd.
// Setiap panggilan = pangkalan data baharu, migrasi dijalankan dengan runner
// yang SAMA seperti produksi (`wrangler d1 migrations apply`).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getPlatformProxy } from 'wrangler'

export const TEST_SECRETS = {
  ENVIRONMENT: 'development',
  JWT_SECRET: 'test-secret-yang-panjangnya-lebih-32-aksara',
}

export async function testEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'marc-bun-'))
  const migrate = Bun.spawnSync(['bunx', 'wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', dir], {
    env: { ...process.env, CI: '1' },
  })
  if (migrate.exitCode !== 0) throw new Error(`migrasi gagal:\n${migrate.stderr.toString()}${migrate.stdout.toString()}`)

  // envFiles: [] - ujian tidak pernah membaca .env (prod) atau .env.dev.
  const proxy = await getPlatformProxy<CloudflareBindings>({ persist: { path: join(dir, 'v3') }, envFiles: [] })
  const env = { ...proxy.env, ...TEST_SECRETS } as CloudflareBindings
  return {
    env,
    async dispose() {
      await proxy.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
