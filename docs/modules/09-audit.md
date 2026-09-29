# 09 - audit

**Tujuan.** Jejak "siapa ubah apa, bila" yang append-only, dan polisi
simpanan data (retention).

**Sumber `marc_go`**: `internal/audit`, `handlers/{audit,audit_helpers}.go`,
`internal/retention`, `queries/audit_logs.sql`,
`migrations/*audit_logs*.sql`.

Penulis audit (`auditStmt`, `diff`) duduk dalam [shared](./00-shared.md)
kerana setiap feature memanggilnya. Feature ini memiliki **bacaan** dan
**retention**.

## Laluan

| Method | Path | Lapisan | Siling |
|---|---|---|---|
| GET | `/audit-logs` | approved | management |

Tapisan: `entity_type`, `entity_id`, `action`, `actor_id`. Keyset:
`before_id` + `limit` (lalai 50, maks 200).

## Data

- **Milik**: `audit_logs` (id `INTEGER PRIMARY KEY AUTOINCREMENT`, bukan UUID).
- **Retention menyentuh**: `audit_logs`, `deleted_uploads` (batu nisan),
  `payment_logs`.

## Peraturan

- **Delta sahaja** untuk `update` - hanya medan yang berubah. Dikira di app
  (`diff(before, after)`), tidak pernah dengan membaca balik baris dalam DB.
- **Dalam batch yang sama** dengan mutasi (R2). Audit best-effort bukan audit.
- **Append-only** melalui trigger: tolak semua `UPDATE`/`DELETE` kecuali
  (a) redaksi `ip_address`/`user_agent` kepada NULL, (b) padam oleh retention.
  Perbandingan lajur guna `IS NOT` supaya NULL = NULL.
- Pelaku boleh NULL (tindakan sistem/cron). Snapshot nama/peranan pelaku
  disimpan dalam baris - tidak bergantung pada profil yang mungkin dipadam.
- **Tiada medan peringkat superadmin (T3) dalam audit**: `/audit-logs` dibaca oleh
  semua pengurusan, jadi `health_notes` & kenalan kecemasan direkod sebagai
  `[disunting]` (butiran ahli: T3 untuk superadmin sahaja).
- Jenis entiti = pemalar dalam `shared/audit.ts`; tambah entiti = tambah
  pemalar, bukan migrasi.

## Job: `retention` (setiap 24 jam)

| Sapuan | Umur (env, hari) | Tindakan |
|---|---|---|
| Redaksi PII audit | `AUDIT_PII_RETENTION_DAYS` (90) | `ip_address`, `user_agent` → NULL; baris kekal |
| Padam audit | `AUDIT_RECORD_RETENTION_DAYS` (365) | padam baris |
| Batu nisan upload | `UPLOAD_TOMBSTONE_RETENTION_DAYS` (30) | padam `deleted_uploads` yang sudah selesai |
| Log bayaran | `PAYMENT_LOG_RETENTION_DAYS` (90) | padam `payment_logs` |

`0` = sapuan dimatikan.

## Cloudflare

- Cron Trigger harian (`0 19 * * *` = 03:00 MYT). Setiap sapuan **berkeping**
  (R8): `… WHERE id IN (SELECT id … LIMIT 1000)` dalam gelung, maks 20 pusingan
  setiap sapuan setiap larian; baki disambung esok.
- Batu nisan upload dan `payment_logs` dipadam melalui statement eksport
  pemiliknya (`uploads.pruneTombstonesStmt`, `payments.prunePaymentLogsStmt`) -
  audit tidak menulis jadual orang lain.
- `/audit-logs`: `old_values`/`new_values` dipulangkan sebagai JSON, bukan
  rentetan; `ip_address`/`user_agent` tidak pernah dipulangkan.
- Trigger SQLite `BEFORE UPDATE … RAISE(ABORT, …)` menggantikan trigger
  plpgsql.

## Ujian wajib

- `UPDATE audit_logs SET action = …` → ditolak oleh trigger.
- Redaksi `ip_address` → dibenarkan; ubah lajur lain serentak → ditolak.
- Mutasi gagal dalam batch → tiada baris audit.
- Retention: 2,500 baris lama dipadam merentas beberapa kepingan; baris baharu kekal.
