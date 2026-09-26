# marc_bun

Backend MARC di atas Cloudflare: **Workers + Hono + D1 + R2 + KV + Queues +
Cron Triggers**, TypeScript, diurus dengan Bun. Menggantikan `../marc_go`
(Go + Gin + Postgres + Redis di Railway) **tanpa mengubah kontrak API** -
`marc_flutter`, `marc_next`, `marc_astro` kekal seperti sedia ada.

> Status: migrasi sedang dirancang - lihat [`TODO.md`](./TODO.md).

## Mula

```bash
bun install
bun run db:reset         # D1 lokal: kosongkan → migrasi → seed dev
bun run dev              # wrangler dev (D1/KV/R2/Queue lokal)
bun run check            # tsc --noEmit && bun test (termasuk ujian sempadan feature)
bun run db:new auth_x    # migrasi baharu (forward-only)
bun run deploy           # check → bookmark Time Travel → migrasi remote → deploy
```

Rahsia: satu contoh `.env.example` → `.env` (**prod**, `bun run secrets:push`) dan `.env.dev` (lokal, `bun run dev`).
Semak semua secret produksi: `bun run secrets:check`. Senarai penuh arahan:
[`docs/00002-tooling.md`](./docs/00002-tooling.md) §4.

## Seni bina

Features-first + SOLID (`docs/00000-foundation.md` §5). Setiap feature ialah
satu folder `routes → service → repo`; setiap jadual ada satu pemilik; graf
feature asiklik. Semua ini **diuji** oleh `src/architecture.test.ts`, bukan
bergantung pada disiplin.

```
src/
  index.ts        fetch / scheduled / queue
  app.ts          middleware + mount feature
  shared/         config, envelope ralat, gate auth, audit, email, push, pdf
  features/<x>/   routes.ts service.ts repo.ts schema.ts dto.ts jobs.ts
```

## Dokumen

| Dokumen | Isi |
|---|---|
| [`AGENTS.md`](./AGENTS.md) | **Mula di sini** (manusia atau agent): sumber kebenaran, peraturan keras, aliran kerja |
| [`docs/00000-foundation.md`](./docs/00000-foundation.md) | Stack, binding, seni bina, peta Postgres → D1, had platform, konvensyen |
| [`docs/00001-migrate-golang-to-bun.md`](./docs/00001-migrate-golang-to-bun.md) | Fasa, corak yang direka semula (R1-R12), migrasi data, cutover |
| [`docs/00002-tooling.md`](./docs/00002-tooling.md) | Migrasi, seed, arahan, skrip, CI |
| [`docs/modules/`](./docs/modules/README.md) | Satu dokumen setiap feature + peta pemilik jadual + graf kebergantungan |
| [`TODO.md`](./TODO.md) | Kerja yang belum siap |
