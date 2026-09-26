# 03 - profile

**Tujuan.** Data peribadi ahli sendiri: profil, avatar, alamat, dan
permintaan pemadaman akaun.

**Sumber `marc_go`**: `handlers/profile.go` (`Me`, `UpdateMe`, `applyAvatar`,
`RequestAccountDeletion`), `handlers/addresses.go`,
`queries/{profiles,member_addresses,account_deletion_requests}.sql`.

## Laluan

| Method | Path | Lapisan | Had kadar |
|---|---|---|---|
| GET | `/me` | protected | - |
| PATCH | `/me` | protected | `profile-update` |
| POST | `/me/deletion-request` | protected | `account-deletion-request` |
| GET | `/me/addresses` | protected | - |
| POST | `/me/addresses` | protected | `profile-update` |
| PATCH | `/me/addresses/:id` | protected | `profile-update` |
| DELETE | `/me/addresses/:id` | protected | `profile-update` |

Semua `protected`, **bukan** `approved`: ahli `pending`/`rejected` mesti boleh
baca status sendiri dan mengurus data peribadinya.

## Data

- **Milik**: `profiles` (**semua** lajur), `member_addresses`,
  `account_deletion_requests`.
- **Eksport** untuk feature lain (satu-satunya SQL `profiles`): `createInitial`,
  `findById`, `setStatus`, `setRole`, `setActive`, `setDepartment`,
  `verifyStaffId`, `correctStaffId`, `correctMemberId`, `setBan`/`clearBan`,
  `setTelegram`/`clearTelegram`, `detach(userId)` (nyahrujuk untuk
  pemadaman). Setiap satu memulangkan **statement** untuk `db.batch()` pemanggil.
- **Melalui pemilik**: `uploads.verifyImage()`, `uploads.enqueueDelete()`.
- **Port** (disambung di `app.ts`): `RegistrationFeeStatus` ←
  `payments.registrationFeeStatus` - untuk `/me`, tanpa import `payments`.

## Peraturan

- **PATCH separa**: medan tidak dihantar = tidak berubah; medan dihantar
  (termasuk `""`) = ditetapkan. Zod mesti bezakan "tiada" dan `null`.
- **Avatar**: kunci baharu disahkan (saiz, magic, dimensi ≤1024 - lihat
  [uploads](./11-uploads.md)), avatar lama digilirkan ke `deleted_uploads`,
  audit - **satu `db.batch()`**. `avatar_url` = `null` (bukan `""`) bila tiada.
- **Alamat**: maks 3; alamat pertama dipaksa `is_default = true`; set default
  baharu menyahtetapkan yang lama dalam batch yang sama; padam default →
  promosi alamat tertua. Poskod 5 digit; negeri daripada senarai tertutup
  negeri Malaysia. Bukan milik → 404.
- **Permintaan pemadaman**: idempoten (permintaan terbuka sedia ada
  dipulangkan), direkod + audit sahaja. Pelaksanaan oleh admin - lihat
  [account-lifecycle](./07-account-lifecycle.md).
- PATCH `/me` wajib `updated_at` (kunci optimistik) → 409 `stale_write`.
- Panjang medan dalam **aksara**, bukan bait (L23).

## Cloudflare

- D1 + R2 (baca header imej untuk pengesahan) + KV (URL avatar bertandatangan).
- Had 3 alamat & satu default: `INSERT … SELECT … WHERE (SELECT COUNT(*) …) < 3`
  + indeks unik separa `(user_id) WHERE is_default = 1`. Tiada baca-dahulu.

## Ujian wajib

- Alamat ke-4 ditolak walaupun dua permintaan serentak.
- Sentiasa tepat satu default selepas create/update/delete.
- Avatar: batch gagal → tiada perubahan kunci **dan** tiada audit.
- PATCH dengan medan tidak dikenali (cth `role_id`) → 200, medan **diabaikan**,
  peranan tidak berubah.
