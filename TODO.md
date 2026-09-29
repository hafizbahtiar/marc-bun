# marc_bun - TODO

Kerja yang **belum siap** sahaja. Keputusan seni bina:
[`docs/00000-foundation.md`](./docs/00000-foundation.md). Rancangan migrasi:
[`docs/00001-migrate-golang-to-bun.md`](./docs/00001-migrate-golang-to-bun.md).
Spesifikasi setiap feature: [`docs/modules/`](./docs/modules/README.md).
Migrasi, skrip, arahan: [`docs/00002-tooling.md`](./docs/00002-tooling.md).

Sumber kebenaran sepanjang migrasi ialah **kod** `../marc_go`, bukan
dokumennya - `ARCHITECTURE.md`/`DATABASE.md` di sana sudah tertinggal.

Status: **Fasa 3 siap; Fasa 0 hampir siap** (lokal). Scaffold features-first, semua
binding, `shared/` asas, arahan, CI, skema D1; `bun run check` hijau. Belum: remote git,
rahsia prod (`.env`), deploy pertama. Seterusnya: Fasa 9 (data & cutover).

Setiap fasa selesai bila: respons padan `marc_go` (status + bentuk JSON +
mesej), tiada medan PII baharu, `bun run check` hijau, dan **dokumen
modul berkenaan dikemas kini** kalau kelakuan berbeza.

---

## Keputusan yang menyekat kerja lain

- [x] **Font PDF (R11).** WinAnsi + pengesahan eksplisit (2026-09-29).
- [x] **"Bulan ini" dashboard.** MYT - dilaksanakan Fasa 4 (`00001` §8.19).
- [x] **Nombor siri sijil (R4).** Terima jurang siri (dilaksana Fasa 6).
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
- [x] **`changes()` merentas statement dalam `db.batch()`** (R2) - lulus lokal (buang kehadiran, Fasa 5); kalau
      tidak, guna varian `WHERE EXISTS (…)`.
- [x] **`INSERT … SELECT … WHERE (subquery)`** (lulus lokal: 30 serentak → 10) menolak pendaftaran ke-
      `capacity+1` di bawah permintaan serentak (R1).
- [x] **Guard batch PUT sesi** (WHERE `NOT EXISTS` pada padam + insert, tiada statement penjaga) - cara membatalkan `db.batch()` bila sesi
      berkehadiran akan dibuang (`docs/modules/15-activities.md`).
- [ ] **Had parameter & saiz statement**: 100 parameter, 100 KB.
- [x] **`pdf-lib` di workerd** (~8 ms/sijil, bundle 394 KiB gzip): saiz bundle, CPU untuk **satu** sijil/resit,
      kelakuan aksara bukan WinAnsi.
- [ ] **`bcryptjs`** terhadap hash `$2a$`/`$2b$` sedia ada + had 72 bait.
- [ ] **KV `signedUrl`** - URL stabil merentas dua permintaan berturutan.
- [ ] **Kelewatan penyebaran KV** untuk pembatalan antara dua lokasi
      (bulk get sudah disahkan). Kalau >60 s tidak
      boleh diterima untuk ban → Durable Object per ahli.
- [ ] **Queue consumer** - had subrequest satu kelompok dengan 100 push.

## Fasa 0 - Scaffold (baki)

- [x] **Remote git** (2026-09-27): `github.com/hafizbahtiar/marc-bun` (public),
      `main` dijejak `origin/main`; CI berjalan pada push.
- [x] **Sumber Cloudflare** (2026-09-26): D1 `marc`
      (`5b6fc927-…`, 15 migrasi, 36 jadual), KV `marc` (`5365f980…`), Queue
      `marc-jobs` + `marc-jobs-dlq`. R2 `marc` sudah wujud dari `marc_go`
      (persendirian: `r2.dev` mati, tiada domain). `marc-staging` juga wujud -
      tidak dipakai.
- [x] Isi `.env` (prod, dari Railway production) + `.env.dev` (staging, hanya
      rahsia yang berbeza daripada prod).
- [ ] `bun run deploy` pertama (Worker `marc-bun` belum wujud) →
      `bun run secrets:push` → `bun run secrets:check`.
- [ ] Isi `vars` bukan-rahsia dalam `wrangler.jsonc` (EMAIL_FROM, URL frontend,
      ToyyibPay, Stripe publishable, OneSignal app id, R2_ACCOUNT_ID, …);
      `PUBLIC_BASE_URL` = domain marc_go semasa cutover (bil ToyyibPay hidup).

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
NULL menggagalkan `donations_traceable`. (Pembetulan: marc_go juga menyimpan
NULL, bukan `''` - pemadaman itu gagal 500 di marc_go.) Ditangani dalam Fasa 3.

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
- [ ] Laluan `/auth/legacy-member-claim/*` → Fasa 8 (`legacy-import`).

## Fasa 3 - `profile`, `members`, `departments`, `blocked-email-domains`, `bans`, `account-lifecycle` ✅

Siap 2026-09-27. Semua laluan pariti marc_go; `shared/audit.ts` (audit dalam
batch yang sama, snapshot pelaku melalui subquery) + `shared/concurrency.ts`
(CAS `updated_at`). Alamat & pemadaman akaun = satu batch berguard.
Ujian HTTP untuk setiap feature (termasuk 5 alamat serentak → tepat 3, batch
pemadaman gagal di tengah → tiada perubahan).

Diputuskan: **derma ahli yang dipadam** - emel akaun disalin ke
`donor_email` supaya penyumbang kekal boleh dijejak (pemilik produk, 2026-09-27).

Avatar baharu & URL bertandatangan: siap dalam Fasa 4.

## Fasa 4 - `uploads`, `posts`, `notifications`, `dashboard` ✅

Siap 2026-09-27. Presign R2 (aws4fetch), pengesahan imej gagal-tertutup
(JPEG/PNG/WebP), URL baca bertandatangan dicache KV, job `reaper` (15m),
avatar baharu. Posts/komen/like pariti marc_go (sunting = pemilik; padam =
pemilik/management). Consumer `notify` (satu INSERT + satu panggilan
OneSignal). Dashboard dengan sempadan bulan MYT.

## Fasa 5 - `activities`, `registrations` ✅

Siap 2026-09-27. Kategori, aktiviti, sesi (ganti keseluruhan, satu batch
bersyarat), terbit/batal + notifikasi, job `lifecycle` (tuntut peringatan
satu statement). Daftar atomik satu statement (30 serentak / kapasiti 10 →
tepat 10), batal, kehadiran (self_scan / manual / scan / pindaan). Docs
15/16 dibetulkan ikut kod marc_go (mesej, 422, `registered`+`pending`).

## Fasa 6 - `certificates` ✅

Siap 2026-09-29. Terbit (metadata + snapshot, satu tempahan julat siri,
batch), tarik balik, `/me/certificates`, PDF on-demand (`pdf-lib` + `uqr`,
WinAnsi dengan pengesahan medan), verify awam medan-terhad, templat
(PATCH/publish CAS). Notifikasi `certificate_ready` satu mesej, sijil
dipautkan oleh consumer.

## Fasa 7 - `payments` ✅

Siap 2026-09-29. Gateway Stripe + ToyyibPay (fetch, tiada SDK; HMAC Stripe
dengan crypto.subtle) + ujian kontrak; derma, yuran pendaftaran (L29: baris
dahulu), yuran aktiviti, webhook (log mentah dahulu, idempoten), resit PDF +
emel, `/me/payments`, `/admin/payments`, reconcile manual + cron, dua sweep,
batal bil oleh admin. `shared/pdf.ts` dikongsi dengan sijil.

Belum disahkan terhadap gateway sebenar: createBill/getBillTransactions
ToyyibPay dan PaymentIntent Stripe hanya diuji dengan fetch disimulasi -
uji sekali dengan sandbox (`dev.toyyibpay.com`, kunci `sk_test`) sebelum cutover.

## Fasa 8 - `audit`, `legacy-import` ✅

Siap 2026-09-29. `/audit-logs` + job `retention` harian berkeping (redaksi PII,
padam audit, batu nisan upload, payment_logs). Legacy import: parser CSV tulen
(port ujian Go), dry-run/batch/import/resolve-department/sunting baris dengan
kira-semula seluruh batch dalam satu statement json_each, tuntutan akaun
(respons seragam, token sekali-guna, serentak = satu akaun).

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
