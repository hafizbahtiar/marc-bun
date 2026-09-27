# 04 - members

**Tujuan.** Direktori ahli dan tindakan pengurusan ke atas ahli lain:
kelulusan, peranan, status aktif, bahagian, `staff_id`, `member_id`.

**Sumber `marc_go`**: `handlers/profile.go` (`Members`, `GetMemberDetail`,
`ListRoles`, `UpdateMember*`, `ApproveMember`, `RejectMember`,
`setMemberStatus`, `VerifyStaffID`, `CorrectStaffID`, `CorrectMemberID`,
`CancelMemberRegistrationPayment`), `handlers/auth.go` (`generateMemberID`,
`memberIDCode`), `queries/{profiles,roles,sequences}.sql`.

## Laluan

Semua `approved`. Siling dalam service.

| Method | Path | Siling |
|---|---|---|
| GET | `/members` | semua (keterlihatan ikut rank); `?status=pending` management |
| GET | `/members/:id` | semua dalam siling rank; medan bertingkat |
| GET | `/roles` | management; hanya peranan yang caller boleh assign |
| POST | `/members/:id/approve` | management |
| POST | `/members/:id/reject` | management |
| POST | `/members/:id/verify-staff-id` | manager ke atas |
| PATCH | `/members/:id/staff-id` | admin ke atas |
| PATCH | `/members/:id/member-id` | admin ke atas |
| PATCH | `/members/:id/role` | management, rank caller **>** target & peranan baharu |
| PATCH | `/members/:id/active` | sama seperti `/role` |
| PATCH | `/members/:id/department` | manager ke atas, rank caller **>=** target (boleh diri sendiri) |

## Data

- **Milik**: `roles`, `sequences` (eksport `nextSequence(key, n)` - turut
  dipakai `certificates`).
- **Melalui pemilik**: `profile.set*`/`verifyStaffId`/`correct*` (semua
  tulis `profiles`), `departments.exists()`, `payments.registrationFeeStatus()`
  (medan T2), mesej `notify` (approve/reject).
- `POST /members/:id/cancel-registration-payment` **bukan** di sini - ia
  milik [payments](./18-payments.md) (laluan tidak menentukan feature).

## Peraturan

- **Siling keterlihatan** (`visibleRankCeiling`, dikira dari jadual `roles`,
  bukan hardcode): nampak sehingga satu tingkat di atas rank sendiri;
  superadmin hanya kelihatan kepada superadmin. Di luar siling → **404**.
- Ahli biasa hanya nampak ahli `approved` (+ diri sendiri).
- **Medan bertingkat** `/members/:id` (dibina di server, bukan disorok klien).
  T2 = kategori `management` (supervisor ke atas) - siling rank di atas
  menentukan **rekod siapa** yang boleh dilihat, T2 menentukan **medan apa**
  yang kelihatan:
  - T1 semua: nama, gambar, no. ahli, peranan, bahagian, jawatan, aktif.
  - T2 management: + emel, telefon, status bayaran pendaftaran.
  - T3 superadmin sahaja: + kenalan kecemasan, nota kesihatan, Telegram,
    alamat penuh.
  DTO eksplisit untuk setiap tingkat - tiada spread baris DB.
- **Approve/reject**: bukan akaun sendiri; tidak boleh tolak ahli
  management; approve memerlukan `staff_id` disahkan dahulu; status sama =
  no-op 200. Tolak = baris kekal (boleh diluluskan kemudian). Emel +
  notifikasi melalui queue selepas batch komit.
- **`member_id`**: `MARC-{staff_id}/{tahun MYT}-{kod}`; kod daripada
  `memberIDCode(role)` (superadmin tiada nombor jujukan). Dijana sekali
  semasa `verify-staff-id`; nilai sedia ada tidak ditulis semula.
  `CorrectMemberID` hanya pada `member_id` yang sudah wujud (NULL → 409).
- **`CorrectStaffID`** tidak menyahsahkan ahli.
- Setiap mutasi: `db.batch([mutasi, auditStmt])` (R2).

## Cloudflare

- `sequences`: `INSERT … ON CONFLICT DO UPDATE … RETURNING` - kekal atomik.
- `verify-staff-id` = dua pusingan (siri, kemudian `batch([profil, audit])`);
  kegagalan kedua membakar satu nombor - diterima seperti R4.
- Unik `staff_id` / `member_id`: kekangan `UNIQUE` → 409; bezakan melalui
  nama kekangan dalam mesej ralat SQLite (`UNIQUE constraint failed:
  profiles.staff_id`).
- Pertukaran status bersyarat: `UPDATE … WHERE id = ? AND status <> ?` +
  semak `meta.changes`.

## Ujian wajib

- Jadual siling untuk setiap peranan seed (ahli/supervisor/manager/admin/superadmin).
- Supervisor tidak nampak medan T2 selain yang dibenarkan; manager tidak nampak T3.
- Manager tidak boleh assign `manager`/`admin`; admin tidak boleh ubah superadmin.
- Approve tanpa `staff_id` disahkan → 400.
- Format `member_id` + tahun MYT pada sempadan 31 Dis 16:00 UTC.
