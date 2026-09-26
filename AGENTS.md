# AGENTS.md

Panduan untuk **mana-mana agent** (Claude, Codex, Cursor, Copilot, Gemini, …)
yang bekerja dalam repo ini. Baca fail ini sepenuhnya sebelum menyentuh kod.
Ia pendek dengan sengaja; butiran ada dalam dokumen yang dipautkan.

## Apa projek ini

Backend kelab MARC. Menggantikan `../marc_go` (Go + Gin + Postgres + Redis,
Railway) dengan **Cloudflare Workers + Hono + D1 + R2 + KV + Queues + Cron**,
TypeScript, toolchain Bun. **Kontrak API tidak berubah**: app Flutter, Next,
Astro sedia ada mesti terus berfungsi tanpa diubah.

Status semasa: dalam `TODO.md` (baris "Status").

## Sumber kebenaran (ikut urutan ini bila bercanggah)

1. **Kod `../marc_go`** - untuk kelakuan: laluan, kod status, bentuk JSON,
   mesej ralat Melayu, peraturan perniagaan. Bukan dokumen `marc_go`
   (`ARCHITECTURE.md`/`DATABASE.md` di sana sudah basi).
2. **`docs/`** repo ini - untuk cara membinanya di Cloudflare.
3. `../hono-workers` - hanya untuk gaya fail migrasi. Jangan salin coraknya
   yang lain (lihat `docs/00000-foundation.md` §11).

Kalau kod `marc_go` dan `docs/` bercanggah tentang kelakuan, **kod menang** -
betulkan dokumen dalam perubahan yang sama dan nyatakannya.

## Peta dokumen

| Perlu tahu | Baca |
|---|---|
| Stack, binding, env, seni bina, peta Postgres → D1, had platform, konvensyen | `docs/00000-foundation.md` |
| Kenapa sesuatu direka semula (R1-R12), migrasi data, cutover, perubahan kelakuan disengajakan | `docs/00001-migrate-golang-to-bun.md` |
| Migrasi, seed, arahan, skrip, CI | `docs/00002-tooling.md` |
| Satu feature: laluan, jadual, peraturan, ujian wajib | `docs/modules/NN-<feature>.md` |
| Siapa memiliki jadual mana; siapa boleh import siapa | `docs/modules/README.md` |
| Kerja belum siap, keputusan terbuka, verifikasi | `TODO.md` |

## Arahan

```bash
bun install
bun run db:reset        # D1 lokal: kosongkan → migrasi → seed
bun run dev             # wrangler dev
bun run check           # tsc --noEmit && bun test  ← WAJIB hijau sebelum selesai
bun run db:new <feature>_<apa>   # satu-satunya cara cipta migrasi
bun run cf-typegen      # selepas ubah wrangler.jsonc
```

Senarai penuh: `docs/00002-tooling.md` §4. **Jangan** jalankan arahan
`*:remote` atau `deploy` tanpa arahan eksplisit manusia.

## Seni bina dalam 10 baris

```
src/index.ts            composition root: fetch / scheduled / queue, peta job, sambung port
src/app.ts              middleware global + mount feature
src/shared/             kod dikongsi >1 feature; TIDAK PERNAH import features/
src/features/<x>/       index.ts (API awam) routes.ts service.ts repo.ts schema.ts dto.ts jobs.ts
src/database/migrations YYYYMMDDHHMMSS_<feature>[_<apa>].sql (UTC), STRICT, forward-only
```

- `routes` = HTTP sahaja → `service` = peraturan → `repo` = SQL D1 sahaja →
  `dto` = baris ke JSON eksplisit.
- Import feature lain **hanya** melalui `features/<y>/index.ts`.
- Setiap jadual ada **satu** pemilik; hanya `repo.ts` pemilik menulisnya.
- Graf feature **asiklik**; kitaran dipecah dengan port yang disambung di
  `index.ts`/`app.ts`.
- `interface` hanya bila ≥2 pelaksanaan (hari ini: `Gateway` bayaran sahaja).
- Semua di atas diuji oleh `src/architecture.test.ts`. Ujian itu gagal =
  reka bentuk salah, bukan ujian salah.

Butiran: `docs/00000-foundation.md` §5.

## Peraturan keras (melanggar mana-mana = kerja belum siap)

**Runtime**
- Web API sahaja. Tiada `fs`, `path`, `Buffer`, `process`, `crypto` Node.
  Tiada `nodejs_compat` tanpa sebab bertulis.
- Tiada state boleh-ubah peringkat modul. Tiada kerja panjang dalam satu
  permintaan - keping, atau Queue.
- IP klien = `CF-Connecting-IP`. Masa = `Date.now()` (unix ms).

**Kontrak API (pariti `marc_go`)**
- Laluan tanpa prefix `/api` - sama seperti `marc_go`.
- Ralat = `{"error": "<mesej Melayu>"}` dengan teks **bait demi bait** sama.
- Validasi: Zod **strip** (medan tak dikenali diabaikan), **bukan**
  `.strict()`. Satu ralat, dipeta ke mesej `marc_go`, lalai `Data tidak sah`.
- Bukan pemilik sumber → **404**, bukan 403.
- Token dalam body JSON, bukan kuki.
- Laluan webhook & return bayaran **tidak boleh** berubah (URL dibakar ke
  dalam bil ToyyibPay yang masih hidup).
- Perubahan kelakuan yang disengajakan → mesti disenaraikan dalam
  `docs/00001-migrate-golang-to-bun.md` §8.

**D1**
- SQL mentah dalam `repo.ts`. Tiada ORM, tiada query builder.
- Tiada transaksi interaktif. Atomik = `db.batch([...])`; semua statement
  dibina **sebelum** batch (tiada baca di tengah).
- Concurrency = guard dalam `WHERE` + semak `meta.changes`, atau kekangan
  unik + `ON CONFLICT`. **Tidak pernah** baca-dahulu-kemudian-tulis.
- Audit ditulis dalam batch yang **sama** dengan mutasi (`shared/audit.ts`).
- ≤100 parameter setiap statement → `chunk()`.
- Masa = `INTEGER` unix ms; JSON = `toISOString()` melalui `shared/time.ts`.
- ID = `crypto.randomUUID()` (kecuali `roles`, `audit_logs`, `payment_logs`).
- Wang = `INTEGER` sen. Tidak pernah `REAL`.

**Migrasi**
- Forward-only. **Tidak pernah** sunting fail migrasi yang sudah wujud -
  tulis migrasi baharu. Expand → deploy → contract.

**Keselamatan**
- JWT `algorithms: ['HS256']`. Rahsia dibanding dengan `timingSafeEqual`.
- Query milik-sendiri sentiasa diskop dengan `userId` daripada token, tidak
  pernah daripada URL/body.
- Respons dibina daripada DTO eksplisit - tiada spread baris DB (bocor PII).
- Log: tiada token, kata laluan, emel, body, `raw_payload`.
- Webhook tidak dipercayai: sahkan tandatangan (Stripe) atau poll gateway
  (ToyyibPay).

## Aliran kerja

**Tambah/ubah endpoint**
1. Baca handler Go asal dalam `../marc_go/internal/http/handlers/` dan
   dokumen modul berkenaan.
2. Ujian dahulu (daripada "Ujian wajib" dokumen modul) - mesti gagal.
3. `schema.ts` → `repo.ts` → `service.ts` → `routes.ts` → `dto.ts`.
4. `bun run check` hijau.
5. Kemas kini dokumen modul kalau kelakuan/jadual/laluan berubah;
   tandakan `TODO.md`.

**Tambah jadual/lajur** - `bun run db:new <feature>_<apa>`, header komen
"kenapa + pemilik", tambah ke peta pemilik (`docs/modules/README.md`), ujian
kekangan yang **gagal** bila dilanggar.

**Tambah feature** - folder `src/features/<x>/`, `docs/modules/NN-<x>.md`
(ikut bentuk dalam `docs/modules/README.md`), satu baris dalam jadual
modul, pemilik jadual, dan graf kebergantungan.

**Tambah job cron / mesej queue** - eksport daripada `features/<pemilik>/jobs.ts`,
satu entri dalam peta di `src/index.ts`, jadual cron dalam `wrangler.jsonc`.
Mesti idempoten (dua larian serentak = hasil sama).

## Definisi selesai

- `bun run check` hijau, dan ujian baharu **gagal** bila logik dipatahkan.
- Respons padan `marc_go` (status + bentuk + mesej) atau perbezaan dicatat
  dalam `00001` §8.
- Tiada medan PII baharu dalam mana-mana respons.
- Dokumen modul + `TODO.md` dikemas kini dalam perubahan yang sama.

## Jangan

- Jangan tambah kebergantungan untuk apa yang boleh ditulis dalam beberapa
  baris atau yang Hono/Workers sudah sediakan.
- Jangan tambah produk Cloudflare (Durable Objects, Workflows, …) tanpa bukti
  keperluan - keputusan semasa ada dalam `TODO.md` "Diputuskan".
- Jangan "kemaskan" kelakuan `marc_go` semasa memindah (lapisan akses,
  pengecualian yang disengajakan) - pariti dahulu, penambahbaikan kemudian
  dengan catatan.
- Jangan buka semula keputusan dalam `TODO.md` "Diputuskan" tanpa bukti baharu.
- Jangan commit `.env` (prod), `.env.dev`, `backups/`, atau rahsia. Jangan
  letak nilai produksi dalam `.env.dev`. Jangan baca/cetak nilai `.env`.
- Jangan jalankan `secrets:push` tanpa arahan manusia - ia menulis ke produksi.

## Glosari

| Istilah | Maksud |
|---|---|
| ahli | pengguna / member |
| pengurusan / management | peranan kategori `management`: supervisor (50), manager (60), admin (80), superadmin (100) |
| `tester` | akaun review app store (rank 5), disekat daripada bayaran sebenar |
| lapisan `protected` / `approved` / `verified` | log masuk / + status diluluskan / + emel disahkan (`00000` §6) |
| siling | semakan peranan dalam service, bukan pada grup laluan |
| yuran pendaftaran / yuran aktiviti / derma | tiga modul bayaran (`modules/18-payments.md`) |
| sijil | sijil penyertaan aktiviti, PDF dijana semasa muat turun |
| R1-R12 | corak yang direka semula untuk D1/Workers (`00001` §5) |
| L<n> | pengajaran/insiden bernombor daripada `marc_go` |
| pariti | kelakuan sama bait-demi-bait dengan `marc_go` |
