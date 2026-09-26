# 01 - auth

**Tujuan.** Identiti: daftar, log masuk, token, pengesahan emel, reset kata
laluan, dan sesi peranti.

**Sumber `marc_go`**: `handlers/auth.go`, `handlers/sessions.go`,
`internal/auth/*`, `middleware/auth.go`, `queries/{users,refresh_tokens,
email_verification_tokens,password_reset_tokens}.sql`.

## Laluan

| Method | Path | Lapisan | Had kadar |
|---|---|---|---|
| POST | `/auth/register` | awam | `auth` |
| POST | `/auth/login` | awam | `auth` |
| POST | `/auth/refresh` | awam | `auth-session` |
| POST | `/auth/logout` | awam | `auth-session` |
| POST | `/auth/logout-all` | protected | - |
| POST | `/auth/verify-email/request` | approved | `verify-email-request` |
| POST, OPTIONS | `/auth/verify-email/confirm` | awam + CORS | `auth` |
| GET | `/auth/verify-email/confirm` | awam (HTML) | `auth` |
| POST | `/auth/password-reset/request` | awam | `password-reset` |
| POST, OPTIONS | `/auth/password-reset/confirm` | awam + CORS | `password-reset` |
| GET | `/me/sessions` | protected | - |
| POST | `/me/sessions/revoke` | protected | `profile-update` |
| DELETE | `/me/sessions/:id` | protected | `profile-update` |

## Data

- **Milik**: `users`, `refresh_tokens`, `email_verification_tokens`,
  `email_verification_sends`, `password_reset_tokens`.
- **Melalui pemilik**: `profile.createInitial()` (baris awal, status
  `pending`) dalam batch yang sama dengan `users`;
  `blockedEmailDomains.isBlocked()`.

## Peraturan

- **Access token**: JWT HS256, 15 minit, `sub` = user id, `sid` = `family_id`
  refresh. Token tanpa `sid` (lama) kekal sah dan langkau semakan keluarga.
- **Pembatalan** menulis senarai tolak KV selepas D1 komit
  ([shared](./00-shared.md)): logout / batal sesi / reuse → `rv:sid:*`;
  `logout-all` / reset kata laluan → `rv:user:*` (cutoff ms, claim `iat_ms`).
  Refresh sentiasa semak D1, termasuk ban (→ 403).
- **Logout** memadam seluruh keluarga peranti, bukan satu baris (`00001` §8.7).
- **Rotasi refresh** = satu `db.batch([INSERT … SELECT, UPDATE … RETURNING])`
  dengan guard sama → sama ada guna-lama + cipta-baharu, atau tiada apa.
- **Reset kata laluan** = satu batch (tukar hash, padam semua refresh,
  tuntut token) → atomik; kedua serentak ditolak `pautan tidak sah`.
- **Refresh**: 32 bait legap, disimpan SHA-256, TTL `REFRESH_TOKEN_TTL_DAYS`
  (30). Rotasi sekali-guna **atomik**: tuntut token lama + masukkan token
  baharu dalam satu `db.batch()`. Reuse token yang sudah digunakan →
  bunuh keseluruhan keluarga, **kecuali** datang dari `consumed_ip` yang sama
  (retry/race sah). `consumed_ip` kosong = tidak padan (gagal-tertutup).
- **Token dalam body JSON**, bukan kuki (klien utama Flutter).
- `X-MARC-Device-Label` → label sesi; fallback `User-Agent`.
- **Daftar**: emel diturunkan huruf kecil + unik; tolak domain pelupusan
  (senarai terbenam + `blocked_email_domains`); `staff_id` diisi ahli;
  notifikasi "ahli baru menunggu" kepada semua management (queue,
  best-effort - pendaftaran tidak gagal kerananya).
- **Login**: mesej sama untuk emel tak wujud vs kata laluan salah (tiada
  enumerasi). Kata laluan > 72 bait ditolak dalam validator (R12).
- **Pengesahan emel**: had per akaun 60s antara hantar + 5 per 24 jam
  (`email_verification_sends`); pautan GET merender HTML ringkas.
  Emel tak dikonfigur = token tetap disimpan, emel no-op.
- **Reset kata laluan**: `request` sentiasa **204** (tiada enumerasi); TTL 1
  jam; tuntut dengan `DELETE … RETURNING` sebagai statement pertama; berjaya
  → bunuh **semua** refresh token ahli. `PASSWORD_RESET_URL` kosong = **503**.
- **Sesi**: satu baris per `family_id`; `created_at` = log masuk asal,
  `expires_at` = token termuda. Batal = padam **seluruh** keluarga. Id milik
  orang lain diabaikan senyap (`revoke`) atau 404 (`DELETE`).

## Cloudflare

- D1 sahaja. Klaim token: `DELETE … RETURNING` / `UPDATE … RETURNING`
  (selamat di D1, `00000` §8).
- Had kadar: binding `ratelimits` bernama (R5) - `auth`, `auth-session`,
  `password-reset`, `verify-email-request` ialah **baldi berasingan**.
- Emel melalui `shared/email.ts`.
- `jose` + `bcryptjs` (hash `$2a$`/`$2b$` lama kekal sah).

## Ujian wajib

- Rotasi: token lama selepas refresh → 401; reuse dari IP lain → keluarga mati.
- Dua refresh serentak dengan token sama → tepat satu berjaya.
- Reset kata laluan serentak dengan token sama → tepat satu berjaya.
- `logout-all` → access token sedia ada ditolak (KV tempatan: serta-merta).
- KV tidak tersedia → access token hidup sehingga tamat, refresh tetap ditolak.
- Had 60s / 5-per-24j pengesahan emel.
- Hash bcrypt daripada `marc_go` lulus `login`.
