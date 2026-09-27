# 00001 - Migrate: Go → Bun (Workers + D1)

Rancangan memindahkan `marc_go` (Go 43,110 baris, 225 query, 62 migration,
36 jadual, 6 job latar) ke `marc_bun` (TypeScript + Hono + D1 + Workers).

Asas & konvensyen: [`00000-foundation.md`](./00000-foundation.md).
Senarai kerja: [`../TODO.md`](../TODO.md).
Dokumen setiap feature: [`modules/`](./modules/README.md).

Sumber kebenaran sepanjang migrasi ialah **kod `marc_go`**, bukan dokumennya -
`ARCHITECTURE.md`/`DATABASE.md` di sana sudah tertinggal (mereka tiada
`member_addresses`, `departments`, `member_bans`, `certificate_templates`,
`legacy_member_*`, dan masih kata "lima goroutine" sedangkan sekarang enam).

---

## 1. Inventori sasaran

| Perkara | Bilangan | Nota |
|---|---|---|
| Baris Go | 43,110 | termasuk sqlc generated |
| Query bernama | 225 | 29 fail dalam `queries/` |
| Migration goose | 62 | → NNN_*.sql D1 |
| Jadual | 36 | lihat §2 |
| Route | ~105 | empat lapisan akses |
| Handler | 30 fail, 22,951 baris | `profile.go` (2,295) & `activities.go` (1,411) terbesar |
| Job latar | 6 | → Cron Triggers |
| Pakej `internal/` | 30 | lihat §3 |
| Modul bayaran | 3 | derma / yuran pendaftaran / yuran aktiviti |

Tiada satu pun nombor ini perlu dikekalkan. Ia senarai semak liputan: setiap
baris mesti ada padanan di `marc_bun` atau sebab bertulis kenapa ia dibuang.

## 2. Jadual (36) → D1

Semua ID `uuid` → `TEXT`; semua masa → `INTEGER` unix ms (lihat `00000` §8).

**Identiti & akses**: `users`, `profiles`, `roles`, `sequences`,
`refresh_tokens`, `email_verification_tokens`, `email_verification_sends`,
`password_reset_tokens`, `telegram_link_tokens`, `device_tokens`,
`blocked_email_domains`, `account_deletion_requests`, `member_addresses`,
`departments`.

**Kandungan**: `posts`, `post_images`, `post_likes`, `comments`,
`comment_likes`, `notifications`.

**Storan**: `pending_uploads`, `deleted_uploads`.

**Aktiviti**: `activity_categories`, `activities`, `activity_sessions`,
`activity_registrations`, `activity_attendances`, `activity_certificates`,
`certificate_templates`.

**Duit & jejak**: `donations`, `registration_payments`, `payment_logs`,
`audit_logs`.

**Legacy import**: `legacy_member_import_batches`, `legacy_member_import_rows`,
`legacy_member_claim_tokens`.

**Tiga constraint yang mesti dipindah, bukan dibuang** (ini yang menahan
keadaan mustahil, dan SQLite menyokong kesemuanya):

1. Indeks unik **separa**: `registration_payments(gateway, gateway_ref) WHERE
   gateway_ref IS NOT NULL`; `activity_registrations(activity_id, user_id)
   WHERE status <> 'cancelled'`; satu alamat default per ahli.
2. Trigger append-only `audit_logs`: tolak semua UPDATE kecuali redaksi
   `ip_address`/`user_agent` kepada NULL. Dalam SQLite ini trigger +
   `RAISE(ABORT, ...)`; bandingkan baris lama dengan `IS NOT` (bukan `<>`,
   supaya NULL kekal sama).
3. `CHECK` pada enum (`status`, `payment_status`, `module`, `method`, jenis
   notifikasi). Kekalkan senarai tertutup - ia yang menahan nilai tersalah
   eja daripada menjadi baris yang klien tak tahu cara papar.

## 3. Peta pakej Go → feature Bun

Seni bina: features-first + SOLID (`00000` §5). Setiap feature ada dokumen
dalam [`modules/`](./modules/README.md).

| `marc_go` | `marc_bun` |
|---|---|
| `cmd/api/main.go` | `src/index.ts` + `src/app.ts` |
| `internal/config` | `shared/config.ts` |
| `internal/db` + goose + `migrations/` | `wrangler d1 migrations` + `src/database/migrations/` (`00002`) |
| `queries/<x>.sql` + `internal/db/sqlc` | `features/<pemilik>/repo.ts` (SQL mentah + jenis tulisan tangan) |
| `internal/http/middleware` | `shared/middleware/*` |
| `internal/authz`, `internal/audit` (penulis) | `shared/authz.ts`, `shared/audit.ts` |
| `internal/email`, `internal/onesignal` + `internal/push` | `shared/email.ts`, `shared/push.ts` |
| `internal/phone`, `internal/disposableemail` | `shared/phone.ts`, `shared/disposable-email.ts` |
| `internal/redisclient` | binding `ratelimits` (+ KV untuk cache URL) |
| `handlers/{auth,sessions}.go`, `internal/auth` | `features/auth` |
| `handlers/telegram.go` | `features/telegram` |
| `handlers/{profile(Me/UpdateMe/deletion),addresses}.go` | `features/profile` |
| `handlers/profile.go` (members/roles/staff-id/member-id) | `features/members` |
| `handlers/departments.go` | `features/departments` |
| `handlers/blocked_email_domains.go` | `features/blocked-email-domains` |
| `handlers/account_lifecycle.go` | `features/account-lifecycle` |
| `handlers/member_bans.go` | `features/bans` |
| `handlers/audit.go`, `internal/retention` | `features/audit` (+ `jobs.ts`) |
| `handlers/legacy_member_import.go`, `internal/legacyimport` | `features/legacy-import` |
| `handlers/uploads.go`, `internal/storage`, `internal/reaper` | `features/uploads` (+ `jobs.ts`) |
| `handlers/{posts,posts_common,comments}.go` | `features/posts` |
| `handlers/{notifications,device_tokens}.go` + fan-out | `features/notifications` (+ consumer queue) |
| `handlers/dashboard.go` | `features/dashboard` |
| `handlers/activities.go`, `internal/activitylifecycle` | `features/activities` (+ `jobs.ts`) |
| `handlers/{activity_registrations,activity_attendance}.go` | `features/registrations` |
| `handlers/{activity_certificates,certificate_templates}.go`, `internal/certificate` | `features/certificates` |
| `handlers/{donations,registration_payment,activity_registration_payment,payments,payment_*}.go`, `internal/{payment,paymentlog,paymentreconcile,receipt,receiptmail,activitysweep,registrationsweep}` | `features/payments` (+ `jobs.ts`) |

**Nota sqlc.** sqlc tidak menjana TypeScript (plugin `sqlc-gen-typescript`
wujud tetapi muda). Jangan paksa: tulis repo tipis dengan SQL mentah + jenis
`Row` tulisan tangan + pemetaan DTO eksplisit. Itu lebih sedikit kod daripada
membina codegen, dan ia mengekalkan disiplin "DTO di sempadan" yang
menghalang kebocoran PII.

## 4. Fasa

Setiap fasa tamat apabila: (a) endpoint berkenaan memadankan respons
`marc_go` (kod status + bentuk JSON + mesej ralat), (b) tiada medan PII
baharu bocor, (c) `bun run check` hijau.

| Fasa | Feature (`docs/modules/`) | Keluar |
|---|---|---|
| **0** | Scaffold: wrangler + semua binding, `shared/`, `/healthz`, runner migrasi, CI, test runner | Worker deploy dengan healthz hijau |
| **1** | Skema D1 penuh (36 jadual) + seed | `db:migrate` bersih dari kosong; kekangan §2 diuji |
| **2** | `auth`, `telegram` | Ujian auth `marc_go` dipindah, termasuk reuse-detection & rotasi atomik |
| **3** | `profile`, `members`, `departments`, `blocked-email-domains`, `bans`, `account-lifecycle` | Pariti gate rank + audit |
| **4** | `uploads`, `posts`, `notifications`, `dashboard` (+ `reaper`, consumer `notify`) | Klien Flutter lama memuat naik tanpa perubahan; pariti fan-out |
| **5** | `activities`, `registrations` (+ `lifecycle`) | Kapasiti atomik; invarian `starts_at`/`ends_at` |
| **6** | `certificates` | PDF menyerupai `marc_go`; verify awam medan-terhad |
| **7** | `payments` (+ `reconcile`, `activitysweep`, `registrationsweep`) | Idempotensi & susunan tulis dikekalkan |
| **8** | `audit` (+ `retention`), `legacy-import` | Import beribu baris tanpa langgar had parameter |
| **9** | Migrasi data + cutover (§6, §7) | Data sepadan, klien tidak berubah |

Job latar dipindah **bersama** feature pemiliknya, bukan sebagai fasa
berasingan.

## 5. Corak yang WAJIB direka semula

Ini senarai kerja sebenar. Setiap satu ialah tempat `marc_go` bergantung pada
Postgres dengan cara yang D1 tidak boleh tiru.

### R1. Kunci baris aktiviti (`LockActivityForRegistration`)

`marc_go` ambil `SELECT … FOR UPDATE` pada baris aktiviti dan menjalankan
SEMUA bacaannya dalam transaksi yang sama. Ia melindungi empat laluan:
daftar, PATCH aktiviti, check-in, dan terbit sijil. D1 tiada kunci baris dan
tiada transaksi interaktif.

Pembaikan terbaik ialah **bukan** menggantikan kunci dengan kunci - ia
menggantikannya dengan satu statement:

```sql
-- Daftar: semakan kapasiti + insert dalam SATU statement, atomik.
INSERT INTO activity_registrations (id, activity_id, user_id, status, …)
SELECT ?, ?, ?, 'registered', …
WHERE (
  SELECT COUNT(*) FROM activity_registrations
  WHERE activity_id = ? AND status <> 'cancelled'
) < (SELECT capacity FROM activities WHERE id = ? AND capacity IS NOT NULL)
```

Tiga laluan lain juga tidak memerlukan kunci:

- **PATCH aktiviti** - CAS `updated_at` (`marc_go` sudah menghantar
  `updated_at` dan memulangkan 409 `stale_write`).
- **Check-in** - `INSERT … ON CONFLICT DO NOTHING` atas unik
  `(registration_id, session_id)`.
- **Terbit sijil** - metadata sahaja (lihat R7) + unik `(activity_id,
  user_id)` + `ON CONFLICT DO NOTHING`.

**Keputusan: tiada Durable Object.** Tambah hanya bila ujian concurrency
membuktikan statement bersyarat tidak mencukupi.

### R2. Audit dalam transaksi yang sama

`marc_go` menulis mutasi + `audit_logs` dalam satu transaksi, sengaja
("jejak best-effort yang boleh gagal senyap bukan jejak"). Di D1, kesamaan
itu ialah `db.batch([mutasi, auditInsert])` - atomik, rollback penuh.

Syaratnya: **delta mesti dikira di app**, sebelum batch dibina (`marc_go`
memang buat begitu - `audit.Diff` mengira delta daripada dua map, ia tidak
membaca baris lama dari DB). Untuk mutasi bersyarat yang mungkin mengena 0
baris, lindung statement audit dengan predikat yang sama (`WHERE changes() >
0` - **sahkan secara empirik** dahulu; kalau ia tidak berkelakuan seperti
dijangka, lindung dengan `EXISTS (SELECT 1 FROM tabel WHERE id = ? AND
<predikat yang sama>)`).

Jangan longgarkan jaminan ini. Kalau audit jadi best-effort seperti
`payment_logs`, ia berhenti menjadi jejak.

### R3. Claim kerja reaper (dan sapuan lain)

`marc_go` bercadang `FOR UPDATE SKIP LOCKED`; ia belum ada, jadi jangan
tiru. Di D1, claim ialah satu statement:

```sql
UPDATE deleted_uploads
SET attempts = attempts + 1, next_attempt_at = ?
WHERE r2_key IN (
  SELECT r2_key FROM deleted_uploads WHERE next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 50
)
RETURNING r2_key, attempts;
```

Setiap sapuan kekal **idempoten** dan **guard-kolumn** seperti asal
(`reminder_sent_at IS NULL`, `payment_status <> 'paid'`), jadi dua cron
serentak menghasilkan keputusan yang sama.

### R4. Nombor siri sijil & pemulihan

`sequences` ialah upsert atomik (`INSERT … ON CONFLICT DO UPDATE … RETURNING`)
- kekal. Yang berubah: `marc_go` menjana siri + insert sijil dalam satu
transaksi, jadi rollback memulangkan siri. Di D1 ia dua pusingan (siri
dahulu, kemudian `batch([sijil, audit])`), jadi **kegagalan pada langkah
kedua membakar satu nombor siri**.

Keputusan: **terima jurang siri** dan dokumen ia (jurang ialah sifat normal
dokumen bernombor; siri sijil bukan resit cukai). Kalau tidak boleh
diterima, jadual tempahan siri diperlukan - tetapi itu kompleksiti yang
belum ada keperluan.

### R5. Had kadar: tetingkap `marc_go` → tetingkap native

Binding `ratelimits` hanya menyokong `period: 10` atau `period: 60`. Tetingkap
`marc_go` (12s/5, 10s/3, 6s/5, 2s/20, 3s/10) mesti dipetakan secara sedar -
jangan biarkan ia jadi lebih ketat tanpa keputusan:

| Baldi `marc_go` | Kadar asal | Cadangan D1 |
|---|---|---|
| `auth` (login/register) | 5 / 12s | `limit 5, period 60` (lebih ketat - sengaja, permukaan brute-force) |
| `auth-session` (refresh/logout) | 10 / 3s | `limit 20, period 60` (lebih longgar; app panggil automatik) |
| `password-reset`, `telegram-link` | 5 / 12s | `limit 5, period 60` |
| `verify-email-request` | 3 / 10s | `limit 10, period 60` |
| `donation`, `registration-payment-checkout`, `activity-payment-checkout`, `upload`, `payment-receipt` | 5 / 6s | `limit 20, period 60` + kunci bernama berasingan |
| `registration-payment-webhook` | 20 / 2s | `limit 30, period 10` |
| `post-create`, `comment-create`, `profile-update` | 10 / 3s | `limit 30, period 60` |
| `account-deletion-request`, `payment-status` | 10 / 3s | `limit 30, period 60` |
| `verify` (sijil awam) | 20 / 2s | `limit 30, period 10` |

Setiap baldi kekal **bernama** (kunci mengasingkan kuota) - tanpa itu, trafik
pengesahan awam menghabiskan kuota log masuk ahli. Semua fail-open, sama
seperti asal.

### R6. Fan-out notifikasi

`marc_go` menjalankan fan-out dalam goroutine dengan `context.Background()`
dan had 2 minit, satu goroutine per peristiwa. Workers **bukan** tempat untuk
itu: had subrequest (50 free / 1000 paid) dan had CPU selepas respons.

Guna **Queues** (`env.JOBS.send({ type: 'notify', … })`), ≤100 penerima
setiap mesej, dan consumer dalam `features/notifications` yang menulis baris
+ menghantar ke OneSignal. Ini bukan pilihan gaya - fan-out 200
penerima dalam satu request akan melebihi had.

### R7. Penerbitan sijil

*Dikemas kini selepas membaca semula kod.* `marc_go` **tidak lagi** menjana
PDF semasa terbit: `Issue` hanya menulis metadata + snapshot, dan
`GET /me/certificates/:id/file` menjana satu PDF on-demand (tiada R2).
`fillPendingCertificateFiles` ialah kod mati - jangan pindahkan.

Yang tinggal: insert N baris dalam kepingan ≤100 parameter dalam satu
`db.batch()`, dan ukur CPU `pdf-lib` untuk **satu** PDF. Tiada Queue atau
Workflow diperlukan untuk sijil.

### R8. Sapuan retention

`marc_go` memadam ikut umur dengan satu statement. Had 30s setiap query
bermakna `DELETE … WHERE created_at < ?` ke atas ratusan ribu baris akan
melebihi had. Keping: `DELETE FROM x WHERE id IN (SELECT id FROM x WHERE …
LIMIT 1000)` dalam gelung, dengan had bilangan pusingan setiap invokasi.

### R9. Verifikasi dimensi imej

`marc_go` membaca julat R2 sehingga `MaxImageSizeBytes` (5 MB) untuk sampai
ke penanda SOF0 JPEG; pusingan awal (12 bait, kemudian 64 KB) **gagal
senyap** dan had dimensi langsung tidak berkuat kuasa (L16). Jangan ulang.

Di Workers: `bucket.get(key)` (objek ≤5 MB, jadi baca penuh selamat) dan
hurai header dalam JS. Kalau binding Images tersedia, `env.IMAGES.info()`
memberi dimensi secara native - tapi jangan tambah produk hanya untuk ini.
**Jangan** gagal-terbuka: kalau dimensi tak dapat diukur, tolak muat naik.

### R10. Muat naik terus ke R2

Klien Flutter memuat naik terus guna presigned URL (`POST /uploads/presign`
→ PUT ke R2 → sahkan). Kekalkan: jana URL dengan **aws4fetch** dalam Worker
(R2 S3 credentials sebagai secret). Alternatif `hono-workers` (proksi melalui
Worker) lebih sedikit bahagian bergerak tetapi **memecahkan klien lama** -
jadi ia bukan pilihan parity.

Bucket kekal persendirian; `R2_PUBLIC_URL` tidak diperlukan (kalau ia
diset, itu amaran yang sama seperti `marc_go` - bucket berkemungkinan
terdedah secara awam).

`SignedURL` mesti **dicache dalam KV** (TTL 1 jam, tempoh sah 2 jam). Ini
bukan pengoptimuman: presigned URL mengandungi `X-Amz-Date`, jadi
menandatangani semula setiap permintaan menghasilkan rentetan berbeza dan
cache imej peranti (dikunci ikut URL) dimuat turun semula setiap kali.

### R11. PDF: `fpdf` → `pdf-lib`

`pdf-lib` ialah JS tulen dan berjalan di workerd. Dua perkara yang mesti
dikekalkan daripada `marc_go`:

- **Pengesahan teks sebelum cetak.** `fpdf` menggantikan rune yang tak
  dipeta dengan `.` secara senyap (cp1252). `pdf-lib` dengan font standard
  (WinAnsi) pula **membaling ralat** untuk aksara di luar set. Kedua-duanya
  bermakna nama ahli boleh rosak/gagal. Jadi: semak setiap medan teks
  (serial, nama penerima, tajuk aktiviti, kategori) terhadap pengekodan
  SEBENAR sebelum melukis, dan namakan medan yang gagal dalam ralat. Kalau
  nama beraksara penuh (CJK, emoji, diakritik Melayu) diperlukan, tanam TTF
  Unicode melalui fontkit - keputusan yang belum dibuat.
- **Pemotongan teks** (`clip()` dalam `receipt.go`): tanpa itu teks panjang
  melimpah keluar bingkai. `pdf-lib` tiada padanan terus; kira lebar teks
  dengan `font.widthOfTextAtSize()`.

QR: kekal `qrcode` (SVG/PNG) → benam sebagai imej, atau lukis matriks
modul terus.

### R12. Perbezaan kecil yang mudah terlepas

| Perkara | `marc_go` | `marc_bun` |
|---|---|---|
| Kata laluan > 72 bait | bcrypt Go **pulang ralat** | `bcryptjs` memotong senyap - hadkan panjang dalam validator (pariti) |
| Had body | `MaxBodySize(1<<20)` | middleware yang sama, 1 MB |
| Tarikh resit derma | `pi.Created` (L27a, risiko diterima) | sama, atau betulkan dengan `LatestCharge.Created` - jangan cetak 1970 |
| Zon waktu resit | MYT pada PDF, UTC dalam badan emel (L27b, sudah dibaiki) | satu fungsi format, satu zon |
| Mesej ralat | Melayu, dalam `{"error": …}` | sama, bait demi bait di mana klien bergantung padanya |
| 404 bukan 403 | untuk sumber bukan milik pemanggil | sama |

## 6. Migrasi data (Postgres → D1)

Satu arah. Rollback ialah **restore Postgres + deploy semula kod lama**, jadi
ia mesti disediakan sebelum cutover.

1. **Ekstrak**: baca 36 jadual mengikut urutan FK (`pg_dump --data-only` atau
   SELECT terus; volume skala kelab, jadi tiada isu).
2. **Transformasi** setiap lajur: UUID → TEXT (kekal rentetan, jangan
   hasilkan semula), `timestamptz` → INTEGER ms UTC, `boolean` → 0/1,
   `jsonb`/`text[]` → TEXT JSON, amaun kekal INTEGER sen.
   `updated_at` dipotong ke ms (token CAS - `modules/00-shared.md`).
   `telegram_chat_id` (`bigint`) kekal INTEGER - selamat dalam julat
   `Number.MAX_SAFE_INTEGER`; sahkan nilai maksimum sebelum import.
   `activity_certificates.activity_date` (`date`) → `TEXT 'YYYY-MM-DD'`;
   lajur `r2_key` sijil **dibuang** (kod mati). Jadual `STRICT`: setiap nilai
   mesti jenis tepat, jadi ralat jenis muncul semasa import, bukan kemudian.
   **Data rujukan yang di-seed oleh migrasi**: `roles` - sahkan id 1-6
   produksi = seed (profiles.role_id bergantung padanya), kemudian langkau;
   `activity_categories`, `certificate_templates`, `departments` - `DELETE`
   baris seed dahulu, kemudian import baris produksi (id produksi dirujuk
   oleh `activities`/sijil/profil).
   Kekangan yang lebih ketat daripada marc_go (disahkan selari dengan kod
   penulis marc_go, tetapi semak data): `departments.code` tanpa `/`,
   `blocked_email_domains.domain` huruf kecil, `ban_expires_at` hanya dengan
   `banned_at`, `post_images.position` 0-3, `activity_categories.key`
   `[a-z0-9_]`, `activity_date` format tarikh, `conflicts`/`warnings` array
   JSON (baris lama `null` → `'[]'`).
3. **Jana SQL** `INSERT` berkeping: maks 100 parameter setiap statement
   (jadual lebar = keping kepada baris yang lebih sedikit) dan <100 KB setiap
   statement.
4. **Import**: `wrangler d1 execute --file` (had 5 GB fail) atau `d1 import`.
5. **Sahkan**: kiraan baris setiap jadual sepadan; jumlah `amount_cents`
   setiap modul bayaran sepadan; `audit_logs` & `payment_logs` boleh dibaca
   dan `json_extract()` berfungsi; trigger append-only menolak UPDATE yang
   sepatutnya ditolak.
6. **R2 tidak berubah**: kunci objek kekal sama, jadi gambar & PDF lama terus
   berfungsi tanpa penulisan semula.
7. **Kata laluan tidak berubah**: hash bcrypt port as-is.
8. **`sequences`**: set `current_value` kepada nilai tertinggi yang pernah
   diisu, supaya tiada nombor ahli/siri sijil berulang.

## 7. Cutover

Kerana DB berubah, "jalankan kedua-dua backend atas satu DB" **mustahil** -
ini bukan strangler klasik. Pelan jujur:

1. **Bekukan tulis** pada `marc_go` (skrin maintenance / 503 pada route
   tulis). Skala kelab: beberapa minit.
2. Ekstrak → transform → import (§6).
3. Sahkan (§6.5) dan bandingkan sampel respons antara dua backend untuk
   endpoint kritikal.
4. Tukar `PUBLIC_BASE_URL`/DNS ke Worker.
5. `marc_go` kekal hidup **baca-sahaja** sebagai rollback selama N hari.
6. Selepas stabil: matikan, dan pindahkan kerja yang tertinggal.

Perkara yang menjadikan cutover boleh diterima:

- **`JWT_SECRET` sama** → tiada ahli dipaksa log keluar.
- **Path webhook kekal sama** (`/webhooks/stripe`,
  `/registration-payments/webhook/toyyibpay`,
  `/activity-registrations/webhook/toyyibpay`). ToyyibPay membakar URL ke
  dalam bil, jadi menukar laluan akan memutuskan bayaran yang masih hidup.
  **Rujuk balik ke `marc_go`: ToyyibPay perlu DUA instance gateway dengan
  callback berbeza - kekalkan dua binding, bukan satu.**
- **`verify_token` sijil lama kekal** → QR pada sijil bercetak terus sah.
  (Ingat: `CERTIFICATE_VERIFY_URL` hanya menjejaskan sijil yang dijana
  selepas ia ditukar - sijil bercetak tidak boleh dibetulkan.)

## 8. Perubahan tingkah laku yang disengajakan

Setiap satu mesti disemak dengan pemilik produk sebelum cutover.

1. **CORS**. `marc_go` hanya memasang CORS pada dua route (verify-email,
   pengesahan sijil) kerana semua klien ialah app native; TODO-nya mencatat
   CORS global sebagai kerja yang belum bermula (web Flutter). `marc_bun`
   patut memasang CORS global untuk origin yang dikonfigurasi - ini
   **menambah** keupayaan, bukan mengubah kontrak. Sahkan senarai origin.
2. **Cabaran `tester`**. `marc_go` menyekat tulis bayaran sahaja untuk akaun
   `tester` (review Google Play/App Store). Kekal sama.
3. **Rate limit lebih ketat pada `auth`** (R5). Ini satu-satunya tempat
   pariti kadar berubah secara sedar; sahkan dengan ujian beban ringan.
4. **"Bulan ini" pada `/dashboard`**: `marc_go` guna `date_trunc` zon sesi
   DB (kemungkinan UTC); `marc_bun` cadang sempadan MYT.
5. **CAS `updated_at`**: `marc_go` disyaki sentiasa 409 (respons dipotong ke
   saat, DB mikrosaat); `marc_bun` memulangkan ms dan membandingkan ms, jadi
   PATCH benar-benar berfungsi. Klien yang bergantung pada 409 berulang
   (tidak mungkin) akan nampak perbezaan.
6. **Pembatalan token ~60 s, bukan serta-merta.** `requireAuth` membaca
   senarai tolak KV (bukan D1), jadi logout sesi / `logout-all` / ban /
   pemadaman akaun sampai ke semua edge dalam ~60 s (serta-merta di lokasi
   yang sama). `/auth/refresh` kekal serta-merta melalui D1. Lihat
   `modules/00-shared.md`.
7. **Logout memadam seluruh keluarga peranti.** `marc_go` memadam SATU
   baris token; baris yang sudah dirotasi kekal, jadi peranti yang log keluar
   masih tersenarai dalam `/me/sessions` dan access token hidup ≤15 minit.
8. **`/auth/refresh` menyemak ban dalam D1** → 403 `akaun anda sedang
   digantung` (marc_go hanya menyemak di `requireAuth`).
9. **Kata laluan > 72 bait** (≤72 aksara tetapi berbilang-bait) → 400
   `Kata laluan terlalu panjang…` (marc_go: 500 kerana bcrypt Go membaling
   ralat; bcryptjs akan memotong senyap).
10. **Pautan token tidak dilog di produksi** bila emel belum dikonfigur
    (marc_go melognya sentiasa - token dalam log = kebocoran). Development:
    kekal dilog.
11. **Claim JWT tambahan `iat_ms`** - ketepatan milisaat untuk `logout-all`
    / reset (tanpanya token yang dikeluarkan dalam saat yang sama terlepas).
    Aditif; token marc_go tanpa `iat_ms` kekal sah.
12. **Ban selepas tamat** boleh diganti dengan ban baharu (marc_go: 409).
13. **Pemadaman akaun ahli yang pernah menderma** berjaya; emel akaun disalin
    ke `donor_email` (marc_go: 500) - diluluskan pemilik produk (penyumbang boleh dijejak).
14. **Nyahban** memulangkan `{user_id, banned}` sama; **ban** kini mengisi
    `email` & `role_key` (marc_go: rentetan kosong).
15. **Headless/`scheduled`**: job latar yang di `marc_go` jalan pada setiap
   instance tanpa kunci teragih, di D1 berjalan sekali per cron. Sama
   keputusan, kurang kerja.
16. **Pengesahan imej gagal-tertutup**: WebP/rosak yang dimensinya tidak dapat
    diukur ditolak (marc_go meluluskannya).
17. **Komen pada post dipadam lembut** → 404 (marc_go: diterima).
18. **Notifikasi kepada pengguna yang sudah dipadam** dilangkau senyap.
19. **"Bulan ini" dashboard = MYT** (lihat 4) - dilaksanakan.

## 9. Risiko

| # | Risiko | Kesan | Mitigasi |
|---|---|---|---|
| 1 | Tiada transaksi interaktif / kunci baris | concurrency salah senyap | R1-R3; ujian concurrency Postgres `marc_go` dipindah sebagai ujian D1 |
| 2 | Jana PDF (sijil/resit) melebihi had CPU | muat turun gagal | R7: satu PDF setiap permintaan; ukur `pdf-lib` |
| 3 | Mapping tetingkap rate limit | ahli sah kena 429 | R5 + ujian beban |
| 4 | Cutover sehala | downtime / kehilangan data | §6.5 pengesahan; backup Postgres + Time Travel D1 (30 hari) |
| 5 | Had 100 parameter pada legacy import | import gagal di tengah | `chunk()` ≤100 parameter; import beridempoten + boleh disambung (`modules/10-legacy-import.md`) |
| 6 | Pengekodan font PDF | sijil rosak atau gagal | R11: sahkan teks sebelum lukis |
| 7 | Jurang nombor siri sijil | nombor hilang | R4: keputusan produk, dokumen |
| 8 | Liputan ujian | regresi senyap | `marc_go` ada 202 PASS/9 SKIP; pindahkan ujian tulen dahulu (`certificate`, `phone`, `config`, `auth`) kerana ia paling murah dan paling bernilai |
| 9 | Kelewatan penyebaran KV untuk pembatalan token/ban | token dibatalkan hidup ≤60 s di edge lain | Diterima; refresh semak D1; Durable Object per ahli hanya jika serta-merta global diwajibkan |

## 10. Nisbah kerja-berbaloi

Migrasi ini bukan terjemahan; dua pertiga daripadanya ialah kod baharu
(SQL mentah bertulis tangan, reka semula concurrency, PDF, job). Yang
mengurangkan kerja: kontrak API kekal (klien tidak berubah), logik tulen
(kelayakan sijil, normalisasi telefon, senarai domain emel, pemotongan teks)
boleh dipindah hampir baris-demi-baris, dan constraint DB (§2) melakukan
sebahagian besar kerja integriti tanpa kod aplikasi.

Yang menambah kerja: setiap `SELECT … FOR UPDATE` (R1), setiap transaksi
interaktif (R2), dan setiap kerja latar berjujukan (R6, R7). Anggarkan
bahagian ini dahulu - ia penentu jadual, bukan bilangan endpoint.
