# 16 - registrations

**Tujuan.** Pendaftaran ahli ke aktiviti (dengan kapasiti) dan kehadiran
per-sesi yang menentukan kelayakan sijil.

**Sumber `marc_go`**: `handlers/{activity_registrations,activity_attendance}.go`,
`internal/certificate/eligibility.go` (`WithinCheckinWindow`),
`queries/{activity_registrations,activity_attendances}.sql`.

## Laluan

| Method | Path | Lapisan | Siling |
|---|---|---|---|
| GET | `/me/activities` | approved | sendiri; yang dibatalkan tidak dipulangkan |
| POST | `/activities/:id/registration` | verified | ahli |
| DELETE | `/activities/:id/registration` | verified | ahli; ditolak selepas aktiviti tamat |
| GET | `/activities/:id/registrations` | verified | management (nama + `member_id` orang lain) |
| POST | `/activities/:id/sessions/:sid/attendance` | verified | `manual`/`scan` management; `self_scan` ahli sendiri |
| DELETE | `/activities/:id/sessions/:sid/attendance/:rid` | verified | management, sentiasa diaudit |

Checkout aktiviti berbayar: [payments](./18-payments.md).

## Data

- **Milik**: `activity_registrations`, `activity_attendances`.
- **Tulis**: `audit_logs` (kehadiran; **bukan** daftar - volum tinggi, baris
  sudah bawa `registered_at`/`cancelled_at`).

## Peraturan

- `status` ∈ {`pending_payment`, `registered`, `cancelled`};
  `payment_status` ∈ {`not_required`, `pending`, `paid`, `refunded`}.
- Aktiviti percuma → `registered` + `not_required`. Berbayar →
  `registered` + `pending` (slot **dipegang**; dilepaskan oleh
  `activitysweep` bila tidak dibayar). `pending_payment` wujud dalam `CHECK`
  tetapi tidak ditulis oleh marc_go.
- Syarat daftar (mesej `marc_go`, semua 409): aktiviti mesti `published`
  (`aktiviti belum dibuka`), dalam tetingkap `registration_opens_at`..
  `registration_closes_at` (`pendaftaran telah ditutup`), belum berdaftar
  (`anda sudah berdaftar`), kapasiti belum penuh (`aktiviti sudah penuh`).
  Tiada aktiviti → 404.
- Batal selepas tamat → **422** `aktiviti sudah tamat, pendaftaran tidak boleh dibatalkan`.
- Kapasiti mengira semua baris `status <> 'cancelled'` (termasuk
  `pending_payment`).
- Batal = baris kekal `cancelled`; indeks unik separa
  `(activity_id, user_id) WHERE status <> 'cancelled'` membenarkan daftar semula.
- `checkin_token` legap (CSPRNG) untuk QR ahli.
- **Kehadiran**:
  - `method` diterima: `manual`, `scan`, `self_scan`. (`code` wujud dalam
    `CHECK` tetapi **ditolak** - tiada klien menghasilkannya.)
  - `self_scan`: identiti daripada JWT sahaja; `registration_id`/token dalam
    body → ditolak. QR venue hanya mengekod aktiviti+sesi (bukan kelayakan).
  - Tetingkap: `[starts_at - 2j, ends_at + 2j]`; di luar = **422**
    `di luar tetingkap check-in`, kecuali **pindaan** management yang diaudit.
  - Tanda dua kali = idempoten (pulang baris sedia ada, `created: false`).
- Senarai pengurusan membawa `attended_session_ids` (`[]`, bukan `null`).

## Cloudflare

- **Kapasiti atomik (R1)** - satu statement, tiada kunci:

  ```sql
  INSERT INTO activity_registrations (id, activity_id, user_id, status, …)
  SELECT ?, a.id, ?, ?, …
  FROM activities a
  WHERE a.id = ? AND a.status = 'published'
    AND ? BETWEEN COALESCE(a.registration_opens_at, 0) AND a.registration_closes_at
    AND (a.capacity IS NULL OR
         (SELECT COUNT(*) FROM activity_registrations r
          WHERE r.activity_id = a.id AND r.status <> 'cancelled') < a.capacity)
  RETURNING *;
  ```

  Tiada baris dipulangkan → baca sekali untuk memilih mesej ralat yang tepat.
  Indeks unik separa menolak pendaftaran berganda (→ `sudah berdaftar`).
- Kehadiran: satu `INSERT … SELECT` dengan semua syarat (pendaftaran aktif,
  sesi milik aktiviti sama, aktiviti hidup, tetingkap kecuali pindaan)
  `ON CONFLICT DO NOTHING RETURNING` + audit berguard dalam batch. Tiada
  baris → baca untuk memilih mesej (susunan marc_go).
- Buang kehadiran: audit berguard `changes() > 0` (statement padam sebelumnya).

## Ujian wajib

- Kapasiti 10, 30 permintaan serentak → tepat 10 berjaya.
- Batal kemudian daftar semula → dibenarkan.
- Batal selepas aktiviti tamat → ditolak.
- `self_scan` dengan `registration_id` orang lain → ditolak.
- Check-in 2j01m sebelum sesi → 422; 1j59m → OK.
- `method: "code"` → 400.
