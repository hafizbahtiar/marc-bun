# 07 - account-lifecycle

**Tujuan.** Pelaksanaan pemadaman akaun oleh superadmin - sama ada atas
permintaan ahli (keperluan Google Play) atau terus.

**Sumber `marc_go`**: `handlers/account_lifecycle.go`,
`queries/account_deletion_requests.sql`,
`migrations/20260906170000_prepare_user_deletion.sql`.

## Laluan

| Method | Path | Lapisan | Siling |
|---|---|---|---|
| GET | `/admin/account-deletion-requests` | approved | superadmin |
| POST | `/admin/account-deletion-requests/:id/execute` | approved | superadmin |
| GET | `/admin/account-deletion-targets` | approved | superadmin |
| POST | `/admin/account-deletion-targets/:id/execute` | approved | superadmin; `reason` wajib (≤500) |

Permintaan itu sendiri dibuat melalui `POST /me/deletion-request`
([profile](./03-profile.md)).

## Data

- **Milik**: tiada - feature ini **orkestrator**. Satu `db.batch()` daripada
  statement pemilik, SEMUA dengan guard yang sama (pengguna wujud, bukan
  superadmin, dan - untuk laluan permintaan - permintaan masih `pending`):
  `uploads.enqueueUserObjectsStmt` (avatar, pending upload, gambar post →
  `deleted_uploads`, satu `INSERT … SELECT`), `payments.detachDonationsStmt`,
  `auditStmt`, `auth.deleteUserStmt` (terakhir).
- Nyahrujuk manual marc_go (`approved_by`, `staff_id_verified_by`, …) **tidak
  diperlukan**: skema D1 guna `ON DELETE SET NULL` pada setiap rujukan
  sejarah. (marc_go terlepas `profiles.banned_by` - memadam admin yang pernah
  ban seseorang gagal dengan ralat FK.)

## Peraturan

- Ditolak: akaun sendiri; mana-mana superadmin; superadmin terakhir.
- Senarai sasaran langsung mengecualikan semua superadmin.
- Objek R2 **tidak** dipadam dalam permintaan - kunci digilirkan ke
  `deleted_uploads` dan [uploads](./11-uploads.md) reaper memadamnya.
- Nyahrujuk + padam + gilir + audit = **satu `db.batch()`**. Separuh jalan
  tidak boleh wujud.
- Rekod kewangan (derma, bayaran) kekal - hanya pautan kepada ahli dibuang.
- Selepas batch komit: `KV.put('rv:user:<id>', …)` supaya access token ahli
  yang dipadam berhenti berfungsi (`requireAuth` tidak lagi membaca D1).

## Cloudflare

- Tiada `FOR UPDATE`: semakan dibuat dahulu untuk mesej ralat yang tepat, dan
  guard yang sama diulang dalam `WHERE` setiap statement batch - perlumbaan
  (cth permintaan ditarik) = tiada apa berubah, 404.
- **Derma**: sebelum `users` dipadam (FK `SET NULL` pada `donations.user_id`),
  emel akaun disalin ke `donor_email` yang kosong. Tanpa ini
  `donations_traceable` menggagalkan seluruh batch - pepijat marc_go (derma
  ahli log masuk disimpan dengan `donor_email` NULL, jadi pemadamannya gagal
  500). *Keputusan produk terbuka*: ini mengekalkan emel ahli yang dipadam
  dalam rekod kewangan (`TODO.md`).

## Ujian wajib

- Selepas pelaksanaan: tiada baris milik ahli; derma kekal dengan `user_id` NULL.
- Setiap kunci avatar/gambar post ahli ada dalam `deleted_uploads`.
- Superadmin terakhir tidak boleh dipadam walaupun dua permintaan serentak.
- Batch gagal di tengah → tiada apa berubah.
