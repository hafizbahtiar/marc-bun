# 10 - legacy-import

**Tujuan.** Bawa masuk rekod ahli dari eksport MARC 2026 (CSV) - staging,
semak konflik, import baris bersih, dan biar ahli yang belum ada akaun
**menuntut** rekodnya sendiri.

**Sumber `marc_go`**: `handlers/legacy_member_import.go`,
`internal/legacyimport`, `cmd/legacy-import-audit`,
`migrations/20260906150000_create_legacy_member_import.sql`.

## Laluan

| Method | Path | Lapisan | Siling / had |
|---|---|---|---|
| POST | `/admin/legacy-member-import/dry-run` | approved | superadmin; `multipart` `file`, ≤1 MB |
| GET | `/admin/legacy-member-import/batches` | approved | superadmin |
| GET | `/admin/legacy-member-import/:id` | approved | superadmin |
| POST | `/admin/legacy-member-import/:id/import` | approved | superadmin |
| POST | `/admin/legacy-member-import/:id/resolve-department` | approved | superadmin |
| PATCH | `/admin/legacy-member-import/rows/:id` | approved | superadmin |
| POST | `/auth/legacy-member-claim/request` | awam | `auth` |
| POST | `/auth/legacy-member-claim/complete` | awam | `auth` |

## Data

- **Milik**: `legacy_member_import_batches`, `legacy_member_import_rows`,
  `legacy_member_claim_tokens`.
- **Melalui pemilik**: `auth.createUser()`, `profile.createInitial()`,
  `departments.create()` (`resolve-department`).

## Peraturan

- **Parser tulen** (`legacyimport.ts`): cari baris header (buku kerja ada
  baris tajuk/legenda sebelum header), jangan anggap baris pertama.
- **Dry-run** tidak menyentuh `users`/`profiles`; simpan laporan + checksum.
  Baris berkonflik kekal kelihatan untuk dibetulkan.
- Konflik = dalam fail (pendua pasangan) **dan** terhadap akaun sebenar
  (emel, `staff_id`, `member_id`). Betulkan satu baris → **seluruh batch**
  dinilai semula, kerana pendua ialah sifat pasangan.
- `conflicts`/`warnings` sentiasa array JSON (`[]`, tidak pernah `null`),
  ditulis **dan** dibaca.
- **Import** hanya baris bersih. Baris tanpa akaun kekal dalam staging untuk
  dituntut.
- **Resolve department**: cipta bahagian yang hilang **dan** tulis semula
  rujukan baris batch kepada kod baharu, serentak (kod tidak boleh ada `/`).
- **Claim request**: respons **sama** untuk padan / tidak padan / akaun sudah
  wujud (tiada enumerasi). Token legap, SHA-256, TTL 1 jam, emel pautan.
- **Claim complete**: tuntut token sekali-guna, cipta akaun; token luput →
  400; akaun sudah wujud → 409.

## Cloudflare

- **Had 100 parameter / 100 KB statement** (R5 `00001` risiko 5): semua
  insert baris staging dan import **dikeping** dengan `chunk()`.
- Import boleh diulang: setiap baris yang sudah diimport ditanda, jadi
  permintaan yang terputus disambung, bukan diduplikasi.
- `multipart` dibaca dengan `c.req.parseBody()` (Web `FormData`), had 1 MB
  disemak sebelum parse.
- Batch besar melebihi had CPU/query satu permintaan → proses N baris setiap
  panggilan dan pulangkan kemajuan (klien memanggil semula) - sama corak
  dengan R7.

## Ujian wajib

- Pindah `legacyimport_test.go` (parser, konflik) baris-demi-baris.
- Import 1,000 baris tanpa melanggar had parameter.
- Claim request: bentuk & masa respons sama untuk tiga kes.
- Import diulang → tiada akaun pendua.
