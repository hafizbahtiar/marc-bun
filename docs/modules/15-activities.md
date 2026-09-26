# 15 - activities

**Tujuan.** Kategori aktiviti, aktiviti, dan set sesinya - termasuk
kitaran hayat draf → terbit → selesai / batal.

**Sumber `marc_go`**: `handlers/activities.go`, `internal/activitylifecycle`,
`queries/activities.sql`.

## Laluan

| Method | Path | Lapisan | Siling |
|---|---|---|---|
| GET | `/activity-categories` | approved | semua; `?all=true` manager ke atas |
| POST | `/activity-categories` | verified | manager ke atas |
| PATCH | `/activity-categories/:id` | verified | manager ke atas |
| GET | `/activities` | approved | semua; `status=draft` manager ke atas |
| GET | `/activities/:id` | approved | draf hanya kepada management |
| POST | `/activities` | verified | management |
| PATCH | `/activities/:id` | verified | management; wajib `updated_at` |
| POST | `/activities/:id/publish` | verified | management |
| POST | `/activities/:id/cancel` | verified | management; `reason` wajib |
| PUT | `/activities/:id/sessions` | verified | management |

## Data

- **Milik**: `activity_categories`, `activities`, `activity_sessions`.
- **Tulis**: `audit_logs`, mesej queue `notify` (`activity_published`,
  `activity_cancelled`, `activity_reminder`).
- **Baca**: `activity_registrations` (kiraan + "saya sudah daftar").

## Peraturan

- `status` ∈ {`draft`, `published`, `cancelled`, `completed`}; hanya draf
  boleh diterbitkan; aktiviti dibatalkan tidak boleh dibatalkan lagi.
- Medan: tajuk ≤200, keterangan ≤2000, nama lokasi ≤300, alamat lokasi ≤500
  (aksara); `fee_cents >= 0`; `capacity > 0` atau NULL (tiada had);
  `attendance_threshold_pct` 1-100 (lalai 100); `currency` lalai `MYR`;
  `registration_closes_at` wajib.
- Kunci kategori: `^[a-z0-9_]+$`, unik.
- PATCH separa: medan tiada = kekal; `null` eksplisit pada lajur NOT NULL →
  400. Gabungan dibuat di app daripada baris sedia ada.
- **Sesi = sumber kebenaran**. `activities.starts_at/ends_at` ialah
  denormalisasi yang dikira semula **setiap kali** set sesi berubah.
  - Ganti **keseluruhan** set (PUT), bukan CRUD per-sesi - satu laluan kod.
  - Set kosong → 400 (kalau tidak, tetingkap lama kekal senyap).
  - `ends_at > starts_at` bagi setiap sesi.
  - Sesi yang sudah ada kehadiran tidak boleh dibuang → 409
    `sesi yang sudah ada kehadiran tidak boleh diganti`.
- Notifikasi terbit/batal kepada ahli, **selepas** komit, best-effort.
- `limit` 1-100, kursor keyset.

## Job: `lifecycle` (setiap jam)

1. **Peringatan H-1**: aktiviti `published` bermula dalam ~24 jam dan
   `reminder_sent_at IS NULL` → set `reminder_sent_at` **dahulu**
   (`UPDATE … WHERE reminder_sent_at IS NULL RETURNING`), kemudian gilir
   `notify`. Yang kalah perlumbaan tidak menghantar.
2. **Auto-selesai**: `published` dengan `ends_at < now` → `completed`.

## Cloudflare

- **PUT sesi** = satu `db.batch()`: padam sesi lama (dengan guard
  `NOT EXISTS (SELECT 1 FROM activity_attendances …)`), insert baharu,
  `UPDATE activities SET starts_at = (SELECT MIN…), ends_at = (SELECT MAX…)`,
  audit. Semakan kehadiran mesti **dalam** statement, bukan baca-dahulu;
  kalau statement padam mengena kurang baris daripada dijangka, batch
  dibatalkan dengan statement penjaga yang gagal (cth `SELECT RAISE` melalui
  `CHECK`) - reka dan buktikan dalam ujian.
- **PATCH** menggantikan `FOR UPDATE` (R1) dengan CAS `updated_at`.
- Cron Trigger `0 * * * *`.

## Ujian wajib

- PUT sesi `[]` → 400; tetingkap aktiviti tidak berubah.
- PUT sesi yang membuang sesi berkehadiran → 409; tiada perubahan separa.
- `starts_at`/`ends_at` = min/max sesi selepas setiap PUT.
- Dua cron `lifecycle` serentak → satu peringatan setiap ahli.
- `fee_cents = -1` → 400.
