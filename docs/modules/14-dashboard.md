# 14 - dashboard

**Tujuan.** Satu bacaan agregat untuk skrin Utama app: blok ahli untuk semua,
blok admin untuk management.

**Sumber `marc_go`**: `handlers/dashboard.go`, `queries/dashboard.sql`,
`outstandingRegistrationFee` dalam `handlers/payments.go`.

## Laluan

| Method | Path | Lapisan |
|---|---|---|
| GET | `/dashboard` | approved (bukan verified - klien memanggilnya sebelum skrin "sahkan emel") |

## Bentuk (ringkas)

- `member`: `membership` (`status`, `member_id`, `staff_id_verified`,
  `outstanding_registration_fee_cents`), `certificates_total`,
  `total_members`, `open_activities[]`.
- `admin` (management sahaja, `null` selainnya): `pending_approvals`,
  `member_stats` (`active`, `pending`, `new_this_month`, `by_department[]`),
  `activity_stats` (`upcoming`, `registrations_this_month`,
  `attendance_rate`), `revenue_this_month` (`registration_cents`,
  `activity_cents`, `donation_cents`, `total_cents`).

Bentuk tepat = struct dalam `dashboard.go`.

## Data

Baca sahaja. Tiada jadual milik.

## Peraturan

- **Yuran tertunggak** dikira oleh **satu** fungsi yang dikongsi dengan
  `/me/payments` ([payments](./18-payments.md)) - jangan tulis semula.
  Nilai = amaun baris `pending` **terbaru**, bukan `REGISTRATION_FEE_CENTS` semasa.
- "Bulan ini" dikira di app dan dihantar sebagai parameter `[mula, tamat)`
  unix ms. `marc_go` guna `date_trunc('month', now())` = zon **sesi DB**
  (kemungkinan UTC), jadi 1hb 00:00-07:59 MYT jatuh ke bulan lepas. Cadangan:
  MYT - ini perubahan tingkah laku, catat dalam `00001` §8.
- `attendance_rate` boleh `null` (tiada sesi) - jangan pulang `0`.
- `donation_cents` boleh `null` (bukan semua peranan nampak derma - salin
  syarat `marc_go`).

## Cloudflare

- Semua kiraan dalam satu `db.batch([...])` bacaan - satu pusingan ke D1,
  bukan N panggilan berjujukan.
- Bila laluan ini panas, pertimbangkan `withSession()` (read replica) -
  **bukan** sebelum ada ukuran.

## Ujian wajib

- Ahli biasa: `admin` = `null`.
- Sempadan bulan: bayaran pada 1hb 00:30 MYT (= hari terakhir bulan lepas
  UTC) dikira dalam bulan baharu.
- Yuran tertunggak sama dengan `/me/payments.outstanding_registration_fee`.
