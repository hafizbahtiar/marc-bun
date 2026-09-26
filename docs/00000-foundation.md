# 00000 - Foundation

Asas untuk `marc_bun`: backend MARC yang menggantikan `marc_go` (Go + Gin +
Postgres) dengan **Cloudflare Workers + Hono + D1**, ditulis dalam TypeScript
dan diurus dengan Bun.

Kerja belum siap: [`../TODO.md`](../TODO.md).
Rancangan migrasi penuh: [`00001-migrate-golang-to-bun.md`](./00001-migrate-golang-to-bun.md).

Rujukan hidup (projek lama, masih sumber kebenaran semasa migrasi):
`../marc_go/ARCHITECTURE.md`, `../marc_go/DATABASE.md`, `../marc_go/TODO.md`.

---

## 1. Kenapa tukar

- **Sasaran deployment ialah Workers** - tiada proses long-running, tiada
  Railway, tiada Docker. Satu artifact, deploy global.
- **Bun sebagai toolchain** - install, scripts, test runner. Runtime
  sebenar kekal `workerd` (V8 isolate), bukan Bun; jangan tulis kod yang
  bergantung pada API Node/Bun (lihat §3).
- **Pariti API diutamakan** - `marc_flutter`, `marc_next`, `marc_astro`
  kekal tanpa perubahan kontrak. Setiap perbezaan tingkah laku yang
  disengajakan mesti dicatat dalam `00001` §7.

## 2. Stack

| Lapisan | Pilihan | Nota |
|---|---|---|
| Runtime | Cloudflare Workers (`workerd`) | Web API sahaja |
| Framework | Hono | Router + middleware |
| Bahasa | TypeScript (`strict`) | Type-check dengan `tsc --noEmit`, bukan esbuild |
| DB | **D1 (SQLite)** | Satu binding, query SQL mentah |
| Migrasi | `wrangler d1 migrations` (native) | Forward-only, `d1_migrations`; lihat `00002` |
| Storan | R2 (binding) | Bucket **persendirian** |
| Rate limit | Binding `ratelimits` | Fail-open, satu binding setiap baldi |
| Auth | `jose` (HS256) + bcrypt | Hash bcrypt sedia ada kekal sah |
| Validasi | Zod (lalai: **strip**) | Medan tak dikenali **dibuang senyap**, bukan 400 - pariti Gin |
| PDF | `pdf-lib` | Sijil + resit, dijana on-demand |
| Kerja latar | Cron Triggers + Queues | Tiada proses long-running |
| Toolchain | Bun | `bun install`, `bun run`, `bun test` |

Sengaja **tidak** guna: ORM/query builder (kekal SQL mentah, padan `marc_go`
yang guna sqlc), Hono JSX, framework DI, SDK Stripe/Telegram/OneSignal
(masing-masing 1-3 panggilan `fetch`).

### 2.1 Sepenuhnya Cloudflare

| `marc_go` (Railway) | `marc_bun` (Cloudflare) | Nota |
|---|---|---|
| Proses Go + Docker | **Workers** | satu artifact, deploy global |
| Postgres | **D1** | `00000` §8, §9 |
| Redis (had kadar) | **Rate Limiting binding** | baldi bernama, R5 |
| R2 via S3 SDK | **R2 binding** (+ aws4fetch untuk presign sahaja) | R10 |
| Cache URL bertandatangan dalam memori | **KV** | kongsi merentas isolate |
| 6 goroutine ticker | **Cron Triggers** | satu handler `scheduled` |
| Goroutine fan-out notifikasi | **Queues** | satu queue `JOBS`, R6 |
| Resend | **kekal Resend** via `fetch` | keputusan: Resend; satu `POST /emails`, tiada SDK |
| `slog` ke stdout | **Workers Logs** (`observability.enabled`) | |
| Env Railway | `vars` + `wrangler secret` | |

Kekal luaran: **Stripe**, **ToyyibPay**, **OneSignal**, **Telegram Bot API**
(tiada padanan Cloudflare), dan **Resend** (pilihan sedar).

Tidak dipakai kerana tiada keperluan terbukti: Durable Objects (lihat
`modules/17-certificates.md` - kekangan unik mencukupi), Workflows,
Hyperdrive, Images, Turnstile.

## 3. Runtime & toolchain

Senarai penuh arahan & skrip: [`00002-tooling.md`](./00002-tooling.md).

```bash
bun install
bun run dev            # wrangler dev
bun run check          # tsc --noEmit && bun test
bun run db:migrate     # migrasi D1 lokal
bun run deploy         # check → bookmark → migrasi remote → deploy
```

### Ujian

`bun test` berjalan dalam **Bun**, bukan `workerd`. Jadi:

- **Ujian tulen** (kelayakan sijil, telefon, parser import, `diff` audit,
  kontrak gateway dengan `fetch` palsu): `bun test` terus.
- **Ujian yang perlukan D1/KV/R2**: binding sebenar daripada
  `getPlatformProxy()` (`wrangler`, sudah dipasang) dengan migrasi dijalankan
  ke atas DB sementara, kemudian `app.request(path, init, env)`.
- `tsc` dengan jenis `wrangler types` (bukan `@types/node`) yang menangkap
  penggunaan API Node dalam kod Worker - Bun tidak akan.
- Disahkan berfungsi di bawah Bun 1.4 (`src/test/env.ts`). Kalau satu hari
  ia rosak, fallback rasmi ialah `@cloudflare/vitest-pool-workers`.

Peraturan runtime:

- **Tiada API Node.** Tiada `fs`, `path`, `crypto` (Node), `Buffer`,
  `process`. Guna `crypto.randomUUID()`, `crypto.subtle`, `TextEncoder`.
  `nodejs_compat` hanya dipasang kalau ada keperluan yang disahkan - setiap
  penggunaan mesti ada sebab bertulis.
- **Tiada kerja panjang dalam satu request.** Had CPU per request (30s
  lalai, Workers Paid) mengikat (lihat §9.9).
- **Tiada state global yang boleh dipercayai.** Isolate dikitar semula; apa
  sahaja yang perlu kekal hidup dalam D1/KV/R2.
- Masa sentiasa UTC. Zon waktu hanya wujud pada sempadan paparan.

## 4. Bindings

`wrangler.jsonc` ialah sumber kebenaran; jenis dijana dengan
`bun run cf-typegen` ke `worker-configuration.d.ts` (tiada fail jenis tulisan tangan).

| Binding | Jenis | Guna |
|---|---|---|
| `DB` | D1Database | Semua data kekal |
| `KV` | KVNamespace | Cache URL R2 bertandatangan + senarai tolak token/ban |
| `BUCKET` | R2Bucket | Gambar post & avatar sahaja - PDF sijil/resit dijana on-demand, tidak disimpan |
| `JOBS` | Queue (producer + consumer) | Fan-out notifikasi + push (R6) |
| `RL_AUTH`, `RL_AUTH_SESSION`, `RL_VERIFY`, … | RateLimit | Satu binding setiap baldi bernama (R5) |
| `JWT_SECRET` | secret | HS256, min 32 bait, **sama** dengan `marc_go` |
| `ACCESS_TOKEN_TTL_MINUTES`, `REFRESH_TOKEN_TTL_DAYS` | var | 15 / 30 |
| `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` | secret/var | Derma |
| `TOYYIBPAY_BASE_URL`, `TOYYIBPAY_SECRET_KEY`, `TOYYIBPAY_CATEGORY_CODE` | secret/var | Dua instance gateway, kredential sama |
| `REGISTRATION_FEE_CENTS`, `GATEWAY_CHARGE_CENTS`, `REGISTRATION_BILL_EXPIRY_MINUTES` | var | 1000 / 100 / 30 |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` | secret/var | Presign sahaja |
| `RESEND_API_KEY`, `EMAIL_FROM` | secret/var | Emel (Resend); kosong = no-op senyap |
| `ONESIGNAL_APP_ID`, `ONESIGNAL_API_KEY` | secret/var | Push |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET` | secret/var | Bot binding |
| `PUBLIC_BASE_URL`, `EMAIL_VERIFY_URL`, `PASSWORD_RESET_URL`, `CERTIFICATE_VERIFY_URL`, `REGISTRATION_PAYMENT_RETURN_URL`, `ACTIVITY_PAYMENT_RETURN_URL` | var | Sama seperti `marc_go` |
| `CORS_ALLOWED_ORIGINS` | var | Senarai dipisah koma |
| `AUDIT_PII_RETENTION_DAYS`, `AUDIT_RECORD_RETENTION_DAYS`, `UPLOAD_TOMBSTONE_RETENTION_DAYS`, `PAYMENT_LOG_RETENTION_DAYS` | var | 90 / 365 / 30 / 90 |

Cron (`triggers.crons`): `*/15 * * * *` (reaper, activitysweep,
registrationsweep), `*/30 * * * *` (reconcile), `0 * * * *` (lifecycle),
`0 19 * * *` (retention, 03:00 MYT).

Kosong = ciri mati. Tiga tingkah laku berbeza yang `marc_go` dokumenkan
(no-op senyap / 503 jelas / jatuh balik) **dikekalkan** - lihat `marc_go`
`ARCHITECTURE.md` §Config. Jangan cipta tingkah laku keempat.

### 4.1 Persekitaran

| Persekitaran | Data | Cara |
|---|---|---|
| lokal | D1/KV/R2/Queue simulasi dalam `.wrangler/` | `bun run dev`, rahsia dalam `.env.dev` (salin `.env.example`) |
| produksi | binding sebenar | `bun run deploy` dari `main` |

Tiada staging buat masa ini (keputusan terbuka dalam `TODO.md`). Kalau
ditambah: `env.staging` dalam `wrangler.jsonc` dengan D1/KV/R2/Queue
**berasingan** - tidak pernah berkongsi binding produksi.

## 5. Seni bina: features-first + SOLID

### 5.1 Struktur

```
src/
  index.ts                 composition root: fetch / scheduled / queue, peta job, sambung port
  app.ts                   Hono app: middleware global + mount setiap feature
  shared/                  kod yang dipakai >1 feature (modules/00-shared.md)
    middleware/            auth gates, rate-limit, tester, cors
    pdf/                   pdf-lib, pengesahan font, QR
    config.ts http.ts db.ts time.ts authz.ts audit.ts email.ts push.ts jobs.ts (enqueue) …
  features/
    <feature>/
      index.ts             API awam feature: routes + fungsi service yang dieksport
      routes.ts            HTTP sahaja: parse → service → DTO → respons
      service.ts           kes guna / peraturan perniagaan, tiada Hono, tiada SQL
      repo.ts              SQL mentah D1 sahaja, tiada peraturan
      schema.ts            Zod (strip, bukan strict)
      dto.ts               baris DB → JSON (eksplisit, tiada spread)
      jobs.ts              handler cron (kalau ada)
      *.test.ts            bersebelahan dengan kod yang diuji
  database/migrations/     YYYYMMDDHHMMSS_<feature>[_<apa>].sql (bun run db:new)
  database/schema.test.ts  setiap kekangan mesti gagal bila dilanggar
  database/seeds/dev.sql   fixture dev sahaja
scripts/                   secrets-check.ts, telegram-webhook.ts, transform-postgres.ts (00002 §5)
docs/modules/              satu dokumen setiap feature
```

Senarai feature dan dokumennya: [`modules/README.md`](./modules/README.md).
Fail yang tiada keperluan tidak dicipta - feature kecil boleh jadi
`routes.ts` + `repo.ts` sahaja.

### 5.2 Peraturan sempadan

1. Feature mengimport `shared/` dan **`index.ts`** feature lain sahaja - tidak
   pernah `repo.ts`/`service.ts` feature lain secara terus.
2. **Tulis**: setiap jadual ada **satu** feature pemilik - hanya `repo.ts`
   pemilik mengandungi `INSERT/UPDATE/DELETE` untuknya. Feature lain memanggil
   fungsi eksport pemilik, atau menerima **statement** daripadanya untuk
   dimasukkan ke `db.batch()` sendiri (atomik merentas feature tanpa berkongsi
   repo). Peta pemilik: [`modules/README.md`](./modules/README.md#pemilik-jadual).
3. **Baca**: melalui fungsi eksport pemilik, dengan dua pengecualian yang
   mesti ditanda `-- cross-read: <jadual> (<sebab>)` dalam SQL:
   (a) subquery dalam statement yang **mesti atomik** (cth semakan kapasiti
   `registrations` membaca `activities`), (b) `dashboard`, satu-satunya
   read-model agregat.
4. **Graf kebergantungan asiklik.** Kitaran dipecahkan dengan **D**: feature
   hilir mengisytiharkan jenis *port* (`type FeeExemption = (userId) =>
   Promise<boolean>`) dan `app.ts` menyambungkan pelaksanaan feature lain.
   Graf semasa: [`modules/README.md`](./modules/README.md#graf-kebergantungan).
5. Kesan sampingan merentas feature yang tidak perlu atomik (notifikasi,
   emel) = mesej queue, bukan panggilan terus.
6. `shared/` tidak pernah mengimport `features/`.
7. **Dikuatkuasakan oleh ujian**, bukan disiplin: `src/architecture.test.ts`
   (≈40 baris, tiada kebergantungan) membaca semua `import` dan gagal bila
   (i) import menembusi `features/<x>/` selain `index.ts`, (ii) `shared/`
   mengimport `features/`, (iii) graf feature ada kitaran, (iv) `INSERT/
   UPDATE/DELETE` ke jadual bukan milik dalam `repo.ts`.

### 5.3 SOLID - apa maksudnya di sini

| Prinsip | Bentuk konkrit | Yang **tidak** dibuat |
|---|---|---|
| **S** | `routes` = HTTP, `service` = peraturan, `repo` = SQL, `dto` = bentuk respons. Satu sebab untuk berubah setiap fail. | Kelas "Manager"/"Helper" serba guna |
| **O** | Gateway bayaran baharu = fail baharu + entri registry. Job baharu = entri peta cron. Jenis mesej queue baharu = entri peta. Tiada `switch` dalam service. | Hierarki kelas/pewarisan |
| **L** | Setiap `Gateway` memenuhi kontrak yang sama (webhook tak dipercayai, `checkStatus` = kebenaran, `ErrNotConfigured` → 503). Satu suite ujian kontrak dijalankan ke atas setiap pelaksanaan. | |
| **I** | Service menerima kebergantungan sempit: `deps: Pick<Repo, 'findById' \| 'update'>`, bukan `env` penuh. | "God object" `Services` |
| **D** | Service bergantung pada **jenis**, bukan pelaksanaan. Komposisi di `routes.ts` (`makeService(c.env)`) - itulah composition root. Ujian menghantar objek palsu; TS structural typing menjadikannya percuma. | Bekas DI, dekorator, `interface` untuk setiap repo |

`interface` bertulis hanya bila ada **≥2 pelaksanaan sebenar** (hari ini:
`Gateway`). Satu pelaksanaan + jenis tersimpul (`ReturnType<typeof makeRepo>`)
sudah memberi D tanpa fail tambahan.

### 5.4 Padanan dengan `marc_go`

`handlers/<x>.go` → `features/<x>/routes.ts` + `service.ts`;
`queries/<x>.sql` + `internal/db/sqlc` → `features/<x>/repo.ts`;
`internal/<pkg>` → `features/<pkg>/` (kalau milik satu feature) atau
`shared/` (kalau dikongsi); job latar → `features/<pemilik>/jobs.ts`.
Peta penuh: `00001` §3.

## 6. Lapisan akses route

Empat lapisan `marc_go` dikekalkan **sama**, termasuk semua pengecualian
yang disengajakan - jangan "kemaskan" semasa migrasi:

| Lapisan | Middleware |
|---|---|
| `r` | awam |
| `protected` | `jwtAuth` |
| `approved` | `jwtAuth` + status `approved` |
| `verified` | `jwtAuth` + `approved` + `email_verified` |

Yang mesti kekal di `protected` dan **bukan** `approved` (sebab yang sama
seperti `marc_go`): `/me`, `/me/payments`, ketiga-tiga laluan resit,
`POST /registration-payments/checkout`, `/me/addresses`, `/me/sessions`.
Ahli `pending` mesti boleh baca status sendiri, bayar, dan lihat bukti
bayaran sendiri.

Siling sebenar (management / superadmin) dikuatkuasakan **dalam handler**,
bukan pada grup route. Sebabnya sama: kebanyakan semakan perlu tahu SIAPA
target dahulu.

## 7. Auth

Sama model dengan `marc_go`:

- **Access**: JWT HS256, TTL 15 minit, `sub` = user id, `sid` = keluarga
  refresh. `requireAuth` tidak menyentuh D1: ia semak **senarai tolak KV**
  (sesi dibatalkan, `logout-all`, ban) dalam satu bulk get. Pembatalan
  sampai ke semua edge dalam ~60 s; D1 kekal sumber kebenaran pada
  `/auth/refresh`. Butiran: `modules/00-shared.md`.
- **Refresh**: token legap 32 bait, disimpan sebagai SHA-256 hash, rotasi
  sekali-guna atomik, `family_id` untuk pengesanan reuse.
- **Token dihantar dalam body JSON** (bukan kuki httpOnly) - klien utama
  ialah app Flutter. Ini **berbeza** daripada `hono-workers`, yang guna
  kuki; jangan salin corak itu ke sini.
- Reset kata laluan, pengesahan emel, dan binding Telegram: token legap +
  hash SHA-256 + TTL, corak klaim `DELETE … RETURNING` (lihat §8).
- Hash bcrypt lama (`$2a$`/`$2b$`) kekal sah - `bcryptjs` mengesahkannya.
  Tiada migrasi semula kata laluan diperlukan.
- JWT lama kekal sah selagi `JWT_SECRET` sama - jadi cutover boleh berlaku
  tanpa log keluar paksa semua ahli.

## 8. Peta semantik Postgres → D1

Ini bahagian yang menentukan bentuk kod. Setiap baris di bawah ialah tempat
`marc_go` bergantung pada Postgres dan apa yang menggantikannya.

**Jenis**

| Postgres | D1 (SQLite) | Nota |
|---|---|---|
| `uuid` + `gen_random_uuid()` | `TEXT` + `crypto.randomUUID()` di app | D1 tiada fungsi UUID; jangan hasilkan UUID dalam SQL |
| `timestamptz` | `INTEGER` (unix ms, UTC) | Isih/julat kekal murah; padan `Date.now()` |
| `boolean` | `INTEGER` 0/1 | |
| `int4`/`int8` | `INTEGER` | |
| `amount_cents` | `INTEGER` | Sen sebagai integer - **jangan** tukar ke REAL |
| `jsonb` | `TEXT` + fungsi JSON1 | `json_extract()`, `json_set()` disokong D1 |
| `text[]` (cth `changed_fields`) | `TEXT` (array JSON) | |
| enum via `CHECK` | `CHECK` | Kekal; ia yang menahan nilai tersalah eja |
| `numeric` | `REAL`/`INTEGER` | Elak untuk wang |

Konvensyen jadual (disahkan dalam `src/database/schema.test.ts`):

- **Semua jadual `STRICT`** - D1 menolak jenis salah (cth rentetan ISO dalam
  lajur masa `INTEGER`) dan bukannya menyimpannya senyap.
- Default masa `(CAST(unixepoch('subsec') * 1000 AS INTEGER))` sebagai jaring
  keselamatan; perbandingan masa tetap parameter dari app.
- Tarikh tanpa masa (`activity_certificates.activity_date`) = `TEXT`
  `YYYY-MM-DD` dengan `CHECK`, bukan instant.
- Seed data rujukan guna ID tetap (`roles` 1-6 sama dengan marc_go;
  UUID `00000000-0000-4000-8000-…` untuk kategori & templat).

**Operasi**

| Corak `marc_go` | Ganti D1 | Status |
|---|---|---|
| `SELECT … FOR UPDATE` (kunci baris) | tiada - guna CAS dalam `WHERE` + semakan `changes`, atau Durable Object | **reka semula** |
| Transaksi interaktif (`BEGIN; SELECT; UPDATE; COMMIT`) | `db.batch([...])` - atomik, rollback penuh, tapi **tiada baca antara statement** | reka semula |
| `DELETE … RETURNING` (klaim token sekali-guna) | kekal - satu statement, atomik | selamat |
| `UPDATE … RETURNING` (rotasi refresh token) | kekal | selamat |
| `INSERT … ON CONFLICT DO UPDATE … RETURNING` (`sequences`) | kekal | selamat |
| Partial unique index (`WHERE gateway_ref IS NOT NULL`) | kekal (SQLite sokong) | selamat |
| Trigger `BEFORE UPDATE … RAISE(ABORT)` (audit append-only) | kekal sebagai trigger SQLite | selamat |
| `FOR UPDATE SKIP LOCKED` (claim kerja reaper) | `UPDATE … SET claimed_at = ? WHERE claimed_at IS NULL … RETURNING` | reka semula |
| `ILIKE` | `LIKE` (ASCII case-insensitive) / `COLLATE NOCASE` | selamat |
| `now()`, `interval` | kira di app, hantar sebagai parameter | disiplin |

**Tiga akibat yang paling kerap tersalah faham:**

1. **`batch()` bukan transaksi interaktif.** Kau siapkan semua statement
   dahulu, hantar sekali, dapat hasil mengikut urutan. Kau **tidak boleh**
   baca nilai daripada statement pertama untuk membina statement kedua.
   Delta audit mesti dikira di app sebelum batch (yang `marc_go` memang
   buat - `audit.Diff`), bukan dengan membaca balik baris lama dalam
   transaksi.
2. **D1 auto-commit dan single-threaded per database.** Setiap statement
   bersifat atomik, dan dua request yang tiba serentak akan berselang-seli
   antara statement. Corak lindung yang betul ialah **guard dalam `WHERE`**
   (`… AND status <> 'paid'`), iaitu corak yang `marc_go` sudah pakai untuk
   idempotensi bayaran. Jangan ganti dengan baca-dahulu-kemudian-tulis.
3. **Tiada kunci baris.** `LockActivityForRegistration` (dipakai untuk
   daftar, check-in, terbit sijil) diganti dengan statement bersyarat
   tunggal + kekangan unik, dan PATCH dengan CAS `updated_at`. Tiada
   Durable Object - lihat `00001` R1 dan `modules/16-registrations.md`.

## 9. Had platform yang membentuk reka bentuk

Angka-angka ini bukan trivia; setiap satu menukar cara kod ditulis.

1. **Saiz baris/string/BLOB maks 2 MB** - PDF tidak pernah masuk D1 (ia
   memang di R2; kekalkan).
2. **Maks 100 bound parameter setiap query** - sebarang INSERT berkelompok
   (legacy import, fan-out notifikasi) mesti dikeping.
3. **Maks 100 KB panjang statement** - sama, keping.
4. **Maks 30 s setiap query** - sapuan retention mesti keping (`DELETE …
   WHERE id IN (SELECT … LIMIT 1000)` dalam gelung), bukan satu DELETE besar.
5. **Maks 1000 query setiap invocation**, 6 sambungan serentak.
6. **DB single-threaded** - daya pemprosesan ialah songsangan tempoh query.
   Indeks bukan pilihan.
7. **10 GB setiap DB, tiada kenaikan** - cukup untuk skala kelab; kalau
   pernah menghampiri, itu isyarat arkitektur, bukan permintaan kuota.
8. **Read replication melalui `withSession()`** - hanya perlu kalau bacaan
   jadi panas; jangan pasang awal (YAGNI).
9. **Had CPU setiap request** - kerja berjujukan yang besar tidak muat.
   Penerbitan sijil **bukan lagi** kes ini: `marc_go` kini menerbit metadata
   sahaja dan menjana PDF semasa muat turun (satu PDF setiap permintaan;
   fasa 2 lama ialah kod mati). Yang masih perlu dikeping: legacy import,
   fan-out notifikasi (queue), sapuan retention, reconcile.
10. **Tiada proses latar.** Enam job `marc_go` jadi **Cron Triggers**
    (satu handler `scheduled` yang dispatch ikut `controller.cron`).

## 10. Konvensyen kod

- **SQL mentah sahaja** dalam `features/*/repo.ts`. Tiada ORM. Setiap query
  ialah `db.prepare(sql).bind(...)`; jenis baris ditulis tangan dan
  dipetakan ke DTO secara eksplisit (tiada spread baris DB ke respons).
- **DTO di sempadan.** Respons dibina daripada struct eksplisit - padan
  `marc_go` (`memberResponse`, `verifyResponse`). Ini yang menghalang
  medan PII bocor apabila query menambah lajur.
- **Envelope ralat sama**: `{"error": "<mesej Melayu>"}` dengan kod status
  yang sama. Klien bergantung pada mesej ini; jangan tukar teks tanpa
  menukar klien.
- **Validasi di sempadan sahaja**, panjang dalam **aksara** bukan bait -
  regresi sebenar di `marc_go` (L23).
  - **Jangan `.strict()`.** Gin mengabaikan medan tak dikenali; klien lama
    yang menghantar medan tambahan mesti terus berfungsi. Zod lalai (strip)
    membuang medan itu - keselamatan mass-assignment sama, tanpa 400 baharu.
  - Ralat = **ralat pertama sahaja**, dipeta ke mesej Melayu `marc_go`
    (`friendlyBindError`, `handlers/bind.go`): cth `Format email tidak sah`,
    `Kata laluan diperlukan (minimum 6 aksara)`, `Kandungan diperlukan`;
    selainnya `Data tidak sah`. **Bukan** gaya `hono-workers` (semua isu
    digabung dengan `; `).
  - JSON rosak / body kosong → 400 `Data tidak sah`. UUID laluan tidak sah →
    400 `id tidak sah`.
- **Kod status**: 404 (bukan 403) untuk sumber yang bukan milik pemanggil,
  supaya kewujudan tidak bocor - sama seperti `marc_go`.
- **Semua masa** unix ms UTC dalam DB; JSON = `toISOString()` melalui
  `shared/time.ts` sahaja.
- **ID** string UUID v4 untuk semua entiti (termasuk semua baris bayaran:
  `donations`, `registration_payments`, `activity_registrations`), kecuali
  tiga yang **sengaja** kekal integer (`INTEGER PRIMARY KEY` = rowid SQLite):
  - `audit_logs.id`, `payment_logs.id` - log dalaman append-only; keyset
    `before_id` perlukan id tersusun ikut masa (UUID v4 tidak), rowid ialah
    indeks paling kecil & insert paling pantas, dan id tidak pernah terdedah
    kepada awam. Tukar ke UUID = tukar kontrak `before_id` (nombor → string).
  - `roles.id` - jadual rujukan kecil, di-seed.

## 11. Rujukan

- Had & transaksi D1: <https://developers.cloudflare.com/d1/platform/limits/>,
  <https://developers.cloudflare.com/d1/worker-api/d1-database/> (`batch()` =
  transaksi, auto-commit, tiada transaksi interaktif)
- Statement SQL yang disokong (JSON1, FTS5): <https://developers.cloudflare.com/d1/sql-api/sql-statements/>
- `../hono-workers` - rujukan untuk **gaya** migrasi, binding `ratelimits`
  native, dan R2 persendirian sahaja. **Jangan** salin: runner migrasi
  (`00002` §1), token dalam kuki (§7), gaya mesej validasi (§10).
