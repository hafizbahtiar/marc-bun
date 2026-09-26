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

- **Milik**: tiada - feature ini **orkestrator**. Ia mengumpul statement
  daripada setiap pemilik dan menghantar satu `db.batch()`:
  `profile.detach(id)` (`approved_by`, `staff_id_verified_by`),
  `legacyImport.detach(id)`, `payments.detach(id)` (`donor_email` NULL → `''`,
  kemudian FK `SET NULL` pada `donations.user_id` - tanpa langkah pertama
  `donations_traceable` menggagalkan seluruh batch; diuji dalam
  `schema.test.ts`),
  `uploads.keysOf(id)` + `uploads.enqueueDelete(keys)`, `auth.deleteUser(id)`
  (cascade), `auditStmt`.
- Pemilik baharu dengan FK ke `users` mesti menambah `detach()` - ujian
  skema dalam §Cloudflare menangkapnya bila terlupa.

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

- `marc_go` ambil `FOR UPDATE` pada baris sasaran. Di D1: kira semua kunci R2
  dan bina semua statement dahulu, kemudian satu batch. Guard kiraan
  superadmin dalam `WHERE` statement `DELETE` (bukan baca-dahulu) supaya
  dua pemadaman serentak tidak boleh memadam superadmin terakhir.
- Senarai statement nyahrujuk mesti diuji terhadap **skema**, bukan senarai
  tulisan tangan: satu FK baharu tanpa `ON DELETE` akan menggagalkan batch.

## Ujian wajib

- Selepas pelaksanaan: tiada baris milik ahli; derma kekal dengan `user_id` NULL.
- Setiap kunci avatar/gambar post ahli ada dalam `deleted_uploads`.
- Superadmin terakhir tidak boleh dipadam walaupun dua permintaan serentak.
- Batch gagal di tengah → tiada apa berubah.
