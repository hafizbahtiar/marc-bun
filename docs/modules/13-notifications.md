# 13 - notifications

**Tujuan.** Peti notifikasi dalam app, token peranti OneSignal, dan
**consumer queue** yang melakukan fan-out (baris DB + push).

**Sumber `marc_go`**: `handlers/{notifications,device_tokens}.go`,
`internal/{push,onesignal}`, `notifyOwner`/`notifyMembers` dalam
`posts_common.go`/`activities.go`, `queries/{notifications,device_tokens}.sql`.

## Laluan

| Method | Path | Lapisan |
|---|---|---|
| GET | `/notifications` | verified |
| POST | `/notifications/:id/read` | verified |
| POST | `/notifications/read-all` | verified |
| DELETE | `/notifications/read` | verified |
| DELETE | `/notifications/selected` | verified |
| DELETE | `/notifications/:id` | verified |
| POST | `/device-tokens` | approved |
| DELETE | `/device-tokens/:id` | approved |
| DELETE | `/device-tokens/by-onesignal/:onesignalId` | approved |

## Data

- **Milik**: `notifications`, `device_tokens`.

## Peraturan

- `type` senarai tertutup (`CHECK`): `post_like`, `post_comment`,
  `comment_like`, `member_pending`, `member_approved`, `member_rejected`,
  `activity_published`, `activity_cancelled`, `certificate_ready`,
  `activity_reminder`. Jenis baharu = migrasi + klien tahu cara papar.
- Semua operasi diskop `user_id` daripada token.
- Senarai: keyset `(created_at, id)`, lalai 20, sama format kursor dengan posts.
- **Upsert token peranti**: `onesignal_id` milik pengguna lain → **409**
  (halang rampasan push).
- Padam token by-onesignal dipakai semasa logout (klien tahu id SDK, bukan
  id baris).

## Consumer queue: `notify`

Mesej: `NotifyMessage` dalam `shared/jobs.ts` (`kind`, `actorId`,
`recipientIds` ≤100, sasaran, `push?` `{title, message}` - tiada = tanpa push).

1. Tapis penerima = pelaku, buang pendua.
2. SATU `INSERT … SELECT FROM json_each(?)` - penerima/pelaku yang sudah
   dipadam dilangkau (bukan ralat FK yang di-retry selama-lamanya).
3. SATU panggilan OneSignal untuk semua `device_tokens` penerima.
4. Gagal push = log, **bukan** retry mesej (baris DB sudah wujud; retry akan
   menduplikasi). Gagal DB = biar queue retry.

Pengeluar (`posts`, `members`, `activities`, `certificates`, `auth`) hanya
memanggil `notify.enqueue(env, msg)` - mereka tidak tahu tentang OneSignal.

## Cloudflare

- **Queues** menggantikan goroutine `context.Background()` + had 2 minit (R6).
  Fan-out 200 penerima dalam satu permintaan akan melanggar had subrequest.
- Mesej besar (ramai penerima) dipecah oleh pengeluar kepada ≤100 penerima
  setiap mesej - satu kelompok consumer kekal di bawah had subrequest.
- `ONESIGNAL_APP_ID`/`ONESIGNAL_API_KEY` kosong = push no-op, baris DB tetap
  ditulis.

## Ujian wajib

- Consumer: pelaku tidak menerima notifikasi sendiri.
- Consumer dijalankan dua kali untuk mesej sama → baris pendua **diterima**
  (hanya berlaku bila ack gagal selepas tulis; tiada kunci unik).
- Upsert `onesignal_id` pengguna lain → 409.
- `DELETE /notifications/selected` dengan id orang lain → diabaikan.
