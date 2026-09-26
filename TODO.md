# marc_bun - TODO

Kerja yang **belum siap** sahaja. Keputusan seni bina:
[`docs/00000-foundation.md`](./docs/00000-foundation.md). Rancangan migrasi:
[`docs/00001-migrate-golang-to-bun.md`](./docs/00001-migrate-golang-to-bun.md).
Spesifikasi setiap feature: [`docs/modules/`](./docs/modules/README.md).
Migrasi, skrip, arahan: [`docs/00002-tooling.md`](./docs/00002-tooling.md).

Sumber kebenaran sepanjang migrasi ialah **kod** `../marc_go`, bukan
dokumennya - `ARCHITECTURE.md`/`DATABASE.md` di sana sudah tertinggal.

Status: **Fasa 2 siap; Fasa 0 hampir siap** (lokal). Scaffold features-first, semua
binding, `shared/` asas, arahan, CI, skema D1; `bun run check` hijau. Belum: remote git,
rahsia prod (`.env`), deploy pertama. Seterusnya: Fasa 3 (`profile`, `members`, …).

Setiap fasa selesai bila: respons padan `marc_go` (status + bentuk JSON +
mesej), tiada medan PII baharu, `bun run check` hijau, dan **dokumen
modul berkenaan dikemas kini** kalau kelakuan berbeza.

---

## Keputusan yang menyekat kerja lain

- [ ] **Font PDF (R11).** Hadkan teks sijil/resit kepada WinAnsi dengan
      pengesahan eksplisit (pariti `marc_go`), atau tanam TTF Unicode
      (fontkit, bundle lebih besar).
- [ ] **"Bulan ini" dashboard.** MYT (cadangan) vs pariti `date_trunc` UTC
      `marc_go`. Lihat `docs/modules/14-dashboard.md`.
- [ ] **Nombor siri sijil (R4).** Terima jurang siri + dokumen (cadangan).
- [ ] **Origin CORS.** Senaraikan `CORS_ALLOWED_ORIGINS` (web Flutter,
      `marc_astro`, staging) sebelum CORS global - `00001` §8.1.
- [ ] **Staging.** Tiada sekarang (`00000` §4.1). Perlu sebelum cutover
      untuk latihan migrasi data penuh? Cadangan: ya, `env.staging` dengan
      binding berasingan, dibuang selepas cutover kalau tidak dipakai.
- [ ] **Cutover.** Tempoh beku tulis + berapa lama `marc_go` kekal
      baca-sahaja sebagai rollback.

Diputuskan (tidak perlu dibuka semula tanpa bukti baharu):
- ~~Kunci aktiviti (R1)~~ → statement bersyarat + unik + CAS `updated_at`,
  **tiada Durable Object**.
- ~~Penerbitan sijil berat (R7)~~ → `marc_go` sudah metadata-sahaja + PDF
  on-demand.
- ~~Penyedia emel~~ → Resend via `fetch`.
- ~~Runner migrasi~~ → `wrangler d1 migrations` native, forward-only (`00002`).
- ~~ID log~~ → `audit_logs`/`payment_logs` kekal `INTEGER` (keyset
  `before_id`); semua entiti lain termasuk bayaran = UUID.
- ~~Semakan sesi/ban setiap permintaan~~ → senarai tolak KV, D1 hanya pada
  refresh; kelewatan ~60 s diterima (`00001` §8.6).

## Verifikasi empirik (sebelum bergantung padanya)

Sudah disahkan 2026-09-26 (wrangler 4.141, Bun 1.4.2) - ujian dalam
`src/app.test.ts`: `getPlatformProxy()` di bawah `bun test` (D1/KV/R2);
`wrangler d1 migrations` terima binding `DB` + hantar fail bertrigger utuh;
`db.batch()` atomik (statement gagal membatalkan yang sebelumnya); trigger
`RAISE(ABORT)`; `DELETE … RETURNING`; KV bulk get → `Map`;
`PRAGMA foreign_keys = 1`.

- [ ] **CAS `updated_at` di `marc_go`** - sahkan pepijat yang disyaki
      (respons saat vs DB mikrosaat → 409 setiap PATCH). Menentukan sama ada
      `00001` §8.5 ialah perubahan kelakuan sebenar.
- [ ] **Format masa JSON** - bandingkan sampel respons `marc_go` (`RFC3339`)
      dengan `toISOString()`; pastikan Flutter/Next/Astro parse kedua-duanya.
- [ ] **`changes()` merentas statement dalam `db.batch()`** (R2); kalau
      tidak, guna varian `WHERE EXISTS (…)`.
- [ ] **`INSERT … SELECT … WHERE (subquery)`** menolak pendaftaran ke-
      `capacity+1` di bawah permintaan serentak (R1).
- [ ] **Guard batch PUT sesi** - cara membatalkan `db.batch()` bila sesi
      berkehadiran akan dibuang (`docs/modules/15-activities.md`).
- [ ] **Had parameter & saiz statement**: 100 parameter, 100 KB.
- [ ] **`pdf-lib` di workerd**: saiz bundle, CPU untuk **satu** sijil/resit,
      kelakuan aksara bukan WinAnsi.
- [ ] **`bcryptjs`** terhadap hash `$2a$`/`$2b$` sedia ada + had 72 bait.
- [ ] **KV `signedUrl`** - URL stabil merentas dua permintaan berturutan.
- [ ] **Kelewatan penyebaran KV** untuk pembatalan antara dua lokasi
      (bulk get sudah disahkan). Kalau >60 s tidak
      boleh diterima untuk ban → Durable Object per ahli.
- [ ] **Queue consumer** - had subrequest satu kelompok dengan 100 push.

## Fasa 0 - Scaffold (baki)

- [ ] **Remote git** + commit pertama (repo sudah `git init`; tiada commit
      lagi). CI (`.github/workflows/ci.yml`) bergantung pada `origin/main`.
- [x] **Sumber Cloudflare** (2026-09-26): D1 `marc`
      (`5b6fc927-…`, 15 migrasi, 36 jadual), KV `marc` (`5365f980…`), Queue
      `marc-jobs` + `marc-jobs-dlq`. R2 `marc` sudah wujud dari `marc_go`
      (persendirian: `r2.dev` mati, tiada domain). `marc-staging` juga wujud -
      tidak dipakai.
- [ ] Isi `.env` (prod; sudah disalin dari `.env.example`; `JWT_SECRET`
      sama dengan `marc_go`) → `bun run secrets:push`.

Siap (rujukan): `git init`, `.gitignore` (`backups/`, `.env*`),
`.env.example` + `.env.dev` lokal + `bunfig.toml` (`env = false`), `wrangler.jsonc` (D1/KV/R2/Queue+DLQ/17 ratelimit/4 cron/
vars/observability), `worker-configuration.d.ts`, `tsconfig.json` (Worker,
`types: []` - API Node gagal type-check) + `tsconfig.test.json` (Bun),
`src/{index,app}.ts`, `shared/{config,http,time,db,jobs,types}.ts`,
`shared/middleware/{rate-limit,logger}.ts`, `GET /healthz`, arahan
`00002` §4, `scripts/secrets-check.ts`, `src/test/env.ts`,
`src/architecture.test.ts` (dibuktikan gagal pada 4 jenis pelanggaran), CI.
`shared/concurrency.ts` sengaja ditangguh ke PATCH pertama (Fasa 3).

## Fasa 1 - Skema D1 ✅

Siap 2026-09-26: 15 migrasi (satu setiap feature pemilik, urutan FK), 36
jadual `STRICT`, seed `roles`/`departments`/`activity_categories`/
`certificate_templates`, trigger append-only `audit_logs`, indeks unik
separa. `src/database/schema.test.ts` (31 ujian) - setiap kekangan gagal
bila dilanggar, dan set jadual mesti sama dengan peta pemilik
`docs/modules/README.md`.

Dijumpai semasa ujian: memadam ahli yang ada derma dengan `donor_email`
NULL menggagalkan `donations_traceable`. `marc_go` terlepas kerana ia
menyimpan `''`. Ditangani oleh `payments.detach()` (Fasa 3/7).

## Fasa 2 - `auth`, `telegram` ✅

Siap 2026-09-26. `features/auth` (register, login, refresh, logout,
logout-all, pengesahan emel JSON + pautan HTML, reset kata laluan, 3 laluan
sesi), `features/telegram` (token, nyahikat, webhook), serta bahagian
`profile` (gate `requireApproved`/`requireVerified`, operasi `profiles`) dan
`blocked-email-domains` (`isBlocked`) yang diperlukan. `shared/`: jwt,
revocation (KV), crypto, email (Resend), cors, phone, disposable-email.
84 ujian HTTP + tulen; asap dalam workerd sebenar (daftar 98 ms, log masuk
77 ms - bcrypt kos 10).

Susulan (bukan penyekat):
- [ ] Baris `refresh_tokens` yang sudah digunakan/luput bertimbun
      (marc_go juga) - tambah sapuan ke job `retention` (Fasa 8).
- [ ] Mesej queue `notify` (cth `member_pending`) dibuang oleh `queue()`
      sehingga consumer `notifications` wujud (Fasa 4). Belum di produksi.
- [ ] Laluan `/auth/legacy-member-claim/*` → Fasa 8 (`legacy-import`).

## Fasa 3 - `profile`, `members`, `departments`, `blocked-email-domains`, `bans`, `account-lifecycle`

- [ ] `docs/modules/03`-`08`.
- [ ] Audit dalam batch pada setiap mutasi (R2).

## Fasa 4 - `uploads`, `posts`, `notifications`, `dashboard`

- [ ] `docs/modules/11`-`14`.
- [ ] Consumer queue `notify` (R6) + job `reaper`.

## Fasa 5 - `activities`, `registrations`

- [ ] `docs/modules/15`-`16`.
- [ ] Job `lifecycle`. Ujian kapasiti serentak.

## Fasa 6 - `certificates`

- [ ] `docs/modules/17-certificates.md`.
- [ ] PDF on-demand + pengesahan font; halaman verify awam medan-terhad.

## Fasa 7 - `payments`

- [ ] `docs/modules/18-payments.md`.
- [ ] `Gateway` + suite ujian kontrak dijalankan ke atas setiap pelaksanaan.
- [ ] Job `reconcile`, `activitysweep`, `registrationsweep`.

## Fasa 8 - `audit`, `legacy-import`

- [ ] `docs/modules/09-audit.md` (+ job `retention`), `10-legacy-import.md`.

## Fasa 9 - Data & cutover

- [ ] `scripts/transform-postgres.js` (`00001` §6) + pengesahan kiraan baris
      dan jumlah `amount_cents`.
- [ ] `sequences` = nilai tertinggi yang pernah diisu.
- [ ] Tulis kunci KV `ban:*` untuk ahli yang sedang digantung.
- [ ] Bandingkan sampel respons endpoint kritikal antara dua backend.
- [ ] Backup: `pg_dump` **dan** D1 Time Travel.
- [ ] Ujian asap: login, feed, daftar aktiviti, satu bayaran ujian, satu
      resit, satu sijil, satu QR pengesahan, satu webhook ToyyibPay lama.
- [ ] `marc_go` baca-sahaja sehingga stabil.

## Risiko diterima

- **Jurang siri sijil** (R4).
- **D1 10 GB setiap DB** - cukup untuk skala kelab.
- **Tiada read replication** - `withSession()` hanya bila bacaan terbukti panas.
