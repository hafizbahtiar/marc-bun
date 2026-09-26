# 00 - shared

**Tujuan.** Kod yang dipakai lebih daripada satu feature. Bukan tempat
logik domain: kalau hanya satu feature memanggilnya, ia duduk dalam feature
itu.

**Sumber `marc_go`**: `internal/http/middleware/*`, `internal/config`,
`internal/authz`, `internal/audit`, `internal/email`, `internal/onesignal`,
`internal/push`, `internal/phone`, `internal/disposableemail`,
`internal/http/handlers/{bind,concurrency,audit_helpers,posts_common}.go`
(bahagian yang dikongsi), `cmd/api/main.go`.

## Isi

| Fail | Tanggungjawab |
|---|---|
| `shared/types.ts` | `AppEnv` (Bindings + Variables Hono) |
| `shared/config.ts` | Zod atas `env`: wajib vs pilihan, tiga tingkah laku "kosong" (`00000` §4) |
| `shared/http.ts` | `ApiError(status, mesej)`, envelope `{"error": …}`, `onError`, `notFound`, `parseBody(schema)` |
| `shared/middleware/auth.ts` | `requireAuth`, `optionalAuth`, `requireApproved`, `requireVerified` |
| `shared/middleware/tester.ts` | `blockTesterWrites` (tiga laluan checkout sahaja) |
| `shared/middleware/rate-limit.ts` | `rateLimit(bindingName, keyFn)` - fail-open |
| `shared/middleware/cors.ts` | CORS ikut `CORS_ALLOWED_ORIGINS` |
| `shared/db.ts` | `chunk()` untuk had 100 parameter, `now()` (unix ms), `uuid()` |
| `shared/time.ts` | `toJson(ms)` → RFC3339 UTC, `fromJson(str)` → ms (potong ke ms), `mytMonthRange()` - **satu** tempat format masa |
| `shared/concurrency.ts` | `expectedUpdatedAt(body)` (400 bila tiada/tak sah) + `staleWrite()` → 409 `{"error", "code": "stale_write"}` |
| `shared/authz.ts` | `isManagement`, `isAtLeastRole`, `roleRank` |
| `shared/audit.ts` | `auditStmt(db, entry)` - pulangkan **statement**, bukan tulis; pemanggil masukkan ke `db.batch()` (R2) + `diff(before, after)` |
| `shared/email.ts` | Resend `POST https://api.resend.com/emails` via `fetch`; no-op senyap bila `RESEND_API_KEY`/`EMAIL_FROM` kosong (pariti `marc_go`) |
| `shared/push.ts` | OneSignal via `fetch`; dipanggil oleh consumer queue sahaja |
| `shared/pdf/` | `pdf-lib`: `textFits()`/`clip()`, pengesahan WinAnsi (R11), QR |
| `shared/phone.ts`, `shared/disposable-email.ts` | port tulen, ujian dipindah baris-demi-baris |
| `shared/jobs.ts` | jenis mesej `JobMessage` + `enqueue(env, msg)` sahaja - **tiada** import feature |

## Middleware (urutan dalam `app.ts`)

Guna middleware **terbina Hono** dahulu (sudah dipasang, tiada kebergantungan
baharu): `hono/request-id`, `hono/body-limit`, `hono/cors`.

1. `requestId()` - header `X-Request-ID` (sama nama dengan `marc_go`).
2. logger satu baris JSON setiap permintaan: method, path, status, latency,
   `request_id`, `client_ip`. **Tiada** token, kata laluan, emel, atau body.
3. `bodyLimit({ maxSize: 1 << 20 })` → 413 (padan `MaxBodySize(1<<20)`).
4. `onError` → envelope. 500 = `{"error": "ralat dalaman"}`; butiran hanya
   dalam log bersama `request_id`.
5. `GET /healthz` → `{"status": "ok"}` (pariti), tiada I/O.

## Fakta runtime yang mudah tersalah

| Perkara | Peraturan |
|---|---|
| IP klien | `c.req.header('CF-Connecting-IP')` sahaja. Tiada senarai proksi dipercayai (itu kerja Railway di `marc_go`). Dipakai oleh had kadar, `consumed_ip` refresh, audit. |
| JWT | `jwtVerify(token, key, { algorithms: ['HS256'] })` - **pin algoritma**. |
| Banding rahsia | `crypto.subtle.timingSafeEqual` (webhook Telegram, HMAC Stripe) - tidak pernah `===`. |
| `Date.now()` | Beku sepanjang kerja CPU dalam satu permintaan (mitigasi Spectre), hanya bergerak selepas I/O. Selamat untuk cap masa; jangan guna untuk ukur prestasi dalam kod. |
| State global | Tiada cache/pembolehubah boleh-ubah peringkat modul. Isolate dikongsi antara permintaan dan dikitar semula bila-bila. |
| `ctx.waitUntil` | Hanya untuk kerja kecil selepas respons (tulis KV senarai tolak, log). Kerja fan-out = Queue. |
| Kerja selepas komit | Emel/push/KV ditulis **selepas** `db.batch()` berjaya; kegagalannya dilog, tidak membatalkan respons. |

Gate per-laluan, bukan global:

| Gate | Tolak | Mesej (`marc_go`) |
|---|---|---|
| `requireAuth` | tiada token / tak sah | 401 `token tidak dijumpai` / `token tidak sah` |
| | `rv:sid:*` / `rv:user:*` dalam KV | 401 `token tidak sah` |
| | `ban:<userId>` dalam KV | 403 `akaun anda sedang digantung` |
| `requireApproved` | status bukan `approved` | 403 `akaun anda belum diluluskan pihak pengurusan` |
| `requireVerified` | emel belum disahkan | 403 `sila sahkan email anda dahulu` |
| `blockTesterWrites` | peranan `tester` | 403 `akaun tester tidak boleh membuat bayaran sebenar` |
| `optionalAuth` | tidak pernah - token rosak/ban = tanpa pengguna | - |

### Pembatalan token: senarai tolak KV (bukan D1 setiap permintaan)

`marc_go` buat satu `SELECT` Postgres setiap permintaan (keluarga `sid` hidup
+ ban). Di D1 (single-threaded, satu region) itu meletakkan **setiap**
permintaan pada satu DB. Ganti dengan **senarai tolak dalam KV** - hanya
ditulis semasa pembatalan (jarang), dibaca di edge (murah):

| Kunci KV | Ditulis bila | Nilai | Tamat |
|---|---|---|---|
| `rv:sid:<familyId>` | `DELETE /me/sessions/:id`, `/me/sessions/revoke`, `/auth/logout`, reuse-detection | `1` | TTL access (900 s) + 60 s |
| `rv:user:<userId>` | `/auth/logout-all`, reset kata laluan, pemadaman akaun | `iat` potongan (unix s) - token dengan `iat` lebih awal ditolak | TTL access + 60 s |
| `ban:<userId>` | ban / unban | `1` | `expiration` = `ban_expires_at`; tiada = kekal; unban = `delete` |

`requireAuth` = sahkan JWT (tiada I/O) → **satu** bulk `KV.get([3 kunci])` →
tiada kunci = lulus. Tiada D1.

Kenapa ini selamat:
- **D1 kekal sumber kebenaran.** `/auth/refresh` masih semak keluarga + ban
  dalam D1. KV hilang/lewat paling teruk = token sedia ada hidup sehingga
  access TTL tamat (≤15 minit) - sama dengan JWT stateless biasa.
- Kunci hanya perlu hidup selagi access token yang terjejas boleh hidup,
  jadi KV tidak membesar.
- Tulis KV **selepas** batch D1 komit; gagal tulis KV = log, bukan 500.

Kosnya (terima secara sedar): KV **eventually consistent** - pembatalan
sampai ke semua lokasi dalam ~60 s, bukan serta-merta seperti `marc_go`.
Kalau "serta-merta global" wajib (cth ban kes keselamatan), satu-satunya
produk Cloudflare yang memberinya ialah Durable Object per ahli - tambah
**hanya** bila keperluan itu wujud.

## Masa & kunci optimistik

- D1 simpan `INTEGER` unix ms. JSON keluar `new Date(ms).toISOString()`
  (`2026-09-26T13:04:05.123Z`). `marc_go` guna `time.RFC3339` (tanpa pecahan
  saat) - kedua-dua bentuk ISO 8601, klien parse sama; sahkan dengan sampel.
- `updated_at` ialah token CAS: `profiles`, `posts`, `comments`,
  `activities`, `activity_categories`, `certificate_templates`. Klien
  menghantar balik nilai yang ia terima; tulis =
  `UPDATE … WHERE id = ? AND updated_at = ?` dan `meta.changes = 0` → 409
  `stale_write`.
- **Pepijat `marc_go` yang disyaki**: respons memotong `updated_at` ke saat,
  tetapi DB menyimpan mikrosaat (`now()`), jadi `=` hampir tidak pernah padan
  → 409 pada setiap PATCH. Tiada ujian meliputinya. Di `marc_bun` ms keluar =
  ms disimpan, jadi CAS berfungsi. Semasa cutover, `updated_at` daripada
  data Postgres **dipotong ke ms** dalam skrip transformasi.

## Authz

- `management` = kategori peranan (`supervisor`, `manager`, `admin`,
  `superadmin`). `isAtLeastRole(x)` = `rank(caller) >= rank(x)`.
- Siling dikuatkuasakan **dalam service**, bukan pada grup laluan.
- Pemilikan: query sentiasa diskop dengan `userId` daripada token, tidak
  pernah daripada URL/body. Bukan pemilik → **404**, bukan 403.

## Cloudflare

- Semua binding dibaca melalui `c.env` / `env` yang disuntik; tiada global.
- `src/index.ts` (composition root) memegang dua peta: `cron → [job]` dan
  `message.type → handler`. Setiap feature eksport job/handler sendiri;
  menambah job = satu baris dalam peta (O dalam SOLID). Peta ada di
  `index.ts`, bukan `shared/`, kerana `shared/` tidak boleh mengimport feature.
- Satu queue (`JOBS`), mesej `{ type, ... }` berdiskriminasi. Queue kedua
  hanya bila keperluan retry/concurrency berbeza **terbukti**.

## Ujian wajib

- Setiap gate: satu kes tolak + satu kes lulus.
- `auditStmt` dalam batch bersama mutasi yang gagal → tiada baris audit.
- `chunk()` tidak pernah melebihi 100 parameter.
- `phone`, `disposable-email`, `config` - pindah ujian `marc_go`.
