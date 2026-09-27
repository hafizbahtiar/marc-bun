# 08 - bans

**Tujuan.** Gantung akaun ahli, sementara atau kekal.

**Sumber `marc_go`**: `handlers/member_bans.go`, `queries/member_bans.sql`,
`middleware/auth.go` (`IsUserCurrentlyBanned`). Kod: `features/bans/routes.ts`.

## Laluan

| Method | Path | Lapisan | Siling |
|---|---|---|---|
| GET | `/admin/banned-members` | approved | superadmin |
| POST | `/admin/members/:id/ban` | approved | superadmin |
| DELETE | `/admin/members/:id/ban` | approved | superadmin |

## Data

- **Milik**: tiada. `profile.setBan()` / `profile.clearBan()` /
  `profile.listBanned()` (lajur `banned_at`, `ban_expires_at`, `ban_reason`,
  `banned_by`), kunci KV `ban:<userId>`.

## Peraturan

- Ditolak: akaun sendiri; superadmin; tanpa `reason`; `expires_at` tidak sah
  / pada masa lalu.
- Aktif = `banned_at IS NOT NULL AND (ban_expires_at IS NULL OR ban_expires_at > now)`.
  Tamat tempoh = automatik tidak aktif; tiada job diperlukan.
- Guard: tiada ban **aktif** → ban dua kali = 409, tidak menindih sebab asal.
  Ban yang sudah tamat boleh diganti (marc_go: guard `banned_at IS NULL`
  sahaja, jadi ban baharu selepas tamat ditolak 409 selamanya).
- Kuat kuasa di `requireAuth` melalui kunci KV `ban:<userId>`
  ([shared](./00-shared.md)) → 403 `akaun anda sedang digantung`, dan di
  `/auth/refresh` melalui D1. `optionalAuth` melayan ahli yang digantung
  sebagai tanpa log masuk.

## Cloudflare

- `now` dihantar sebagai parameter (unix ms), bukan `now()` SQL.
- Ban = D1 batch (profil + audit), **kemudian** `KV.put('ban:<id>', '1',
  { expiration })` (kosong untuk kekal); unban = `KV.delete`. Tamat tempoh
  KV = tamat ban, jadi tiada job.
- Cutover: tulis kunci `ban:*` untuk setiap ahli yang sedang digantung.

## Ujian wajib

- Ban → permintaan seterusnya 403; unban → 200.
- Ban tamat (`ban_expires_at` < now) → 200 tanpa unban.
- Superadmin / diri sendiri → 403/400.
