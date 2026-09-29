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

- **Had 100 parameter / query setiap invokasi**: insert staging, kemas kini
  kira-semula dan penandaan import masing-masing **SATU statement** atas
  `json_each(?)` (INSERT…SELECT / UPDATE…FROM) - 1,000 baris = satu query.
  Semakan konflik akaun sebenar = tiga query (emel, staff_id, member_id), bukan
  tiga setiap baris.
- **Import**: 2 statement setiap akaun SEDIA ADA (kemas kini profil + audit)
  dalam satu batch - ~490 akaun setiap panggilan; panggil semula untuk baki.
- **Claim complete**: batch [guna token (guard `consumed_at IS NULL`), cipta
  user, cipta profil, tanda baris] - tiga yang terakhir bersyarat pada token
  INI baru digunakan, jadi tuntutan serentak = tepat satu akaun; yang kalah → 400.
- Pautan tuntutan = `CLAIM_ACCOUNT_URL?token=…` (halaman marc_next); dilog
  hanya di development bila emel belum dikonfigurasi.
- Import boleh diulang: setiap baris yang sudah diimport ditanda, jadi
  permintaan yang terputus disambung, bukan diduplikasi.
- `multipart` dibaca dengan `c.req.parseBody()` (Web `FormData`); badan > 1 MB
  ditolak oleh had global lebih dahulu (`Data tidak sah`, lihat `00001` §8).
- Batch besar melebihi had CPU/query satu permintaan → proses N baris setiap
  panggilan dan pulangkan kemajuan (klien memanggil semula) - sama corak
  dengan R7.

## Ujian wajib

- Pindah `legacyimport_test.go` (parser, konflik) baris-demi-baris.
- Import 1,000 baris tanpa melanggar had parameter.
- Claim request: bentuk & masa respons sama untuk tiga kes.
- Import diulang → tiada akaun pendua.
