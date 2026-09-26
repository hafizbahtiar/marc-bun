# 06 - blocked-email-domains

**Tujuan.** Tambahan manual kepada senarai domain emel pelupusan terbenam
(`shared/disposable-email.ts`) - untuk domain baharu yang senarai statik
terlepas.

**Sumber `marc_go`**: `handlers/blocked_email_domains.go`,
`internal/disposableemail`, `queries/blocked_email_domains.sql`.

## Laluan

| Method | Path | Lapisan | Siling |
|---|---|---|---|
| GET | `/admin/blocked-email-domains` | approved | superadmin |
| POST | `/admin/blocked-email-domains` | approved | superadmin |
| DELETE | `/admin/blocked-email-domains/:domain` | approved | superadmin |

## Data

- **Milik**: `blocked_email_domains`. **Dibaca oleh**: [auth](./01-auth.md)
  semasa daftar.

## Peraturan

- Domain dinormalkan (huruf kecil, trim) sebelum simpan dan sebelum banding.
- Semakan daftar = senarai terbenam **ATAU** jadual. Membuang dari jadual
  tidak membuka domain yang ada dalam senarai terbenam.
- Superadmin sahaja - ini mengawal siapa boleh mendaftar langsung.

## Cloudflare

- D1 sahaja. Tiada cache KV: dibaca sekali per pendaftaran, bukan laluan panas.

## Ujian wajib

- Domain dalam jadual → daftar ditolak.
- `Example.COM` dan `example.com` dilayan sama.
