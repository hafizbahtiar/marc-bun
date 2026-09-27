# 05 - departments

**Tujuan.** Senarai rujukan bahagian/jabatan organisasi.

**Sumber `marc_go`**: `handlers/departments.go`, `queries/departments.sql`.

## Laluan

| Method | Path | Lapisan | Siling |
|---|---|---|---|
| GET | `/departments` | approved | manager ke atas (baca sahaja, untuk pemilih) |
| GET | `/admin/departments` | approved | superadmin |
| POST | `/admin/departments` | approved | superadmin |
| PATCH | `/admin/departments/:code` | approved | superadmin |
| DELETE | `/admin/departments/:code` | approved | superadmin |

## Data

- **Milik**: `departments`. **Dirujuk oleh**: `profiles.department_code`,
  `legacy_member_import_rows`.

## Peraturan

- `code` ialah kunci URL - **tidak boleh** mengandungi `/`.
- Padam bahagian yang masih dirujuk → `profiles.department_code` jadi NULL
  (`ON DELETE SET NULL`), ahli kekal - bahagian bukan kebenaran sistem.
- Mutasi **tidak** diaudit - pariti `marc_go` (`handlers/departments.go` tiada
  `audit.Record`). Bahagian ialah data rujukan, bukan perubahan keistimewaan.

## Cloudflare

- D1 sahaja. Pastikan `PRAGMA foreign_keys` berkuat kuasa di D1 (ia
  dihidupkan secara lalai) - ujian di bawah membuktikannya.

## Ujian wajib

- Kod dengan `/` → 400.
- Padam bahagian yang dirujuk → ahli kekal, `department_code` NULL.
- Manager boleh `GET /departments`, tidak boleh `POST /admin/departments`.
