# 11 - uploads

**Tujuan.** Gambar (post, avatar) dimuat naik **terus** dari peranti ke R2
melalui URL presigned; Worker hanya menandatangani, mengesahkan, dan
membersihkan.

**Sumber `marc_go`**: `handlers/uploads.go`, `internal/storage/*`,
`internal/reaper`, `queries/uploads.sql`.

## Laluan

| Method | Path | Lapisan | Had kadar |
|---|---|---|---|
| POST | `/uploads/presign` | verified | `upload` |

Badan: `{"content_type": "image/jpeg" | "image/png" | "image/webp"}`.
Pulang URL PUT + `r2_key`. Klien kemudian melampirkan `r2_key` pada
`POST /posts` atau `PATCH /me`.

## Data

- **Milik**: `pending_uploads` (kunci yang ditandatangani tetapi belum
  dilampir), `deleted_uploads` (gilir padam R2 dengan retry).
- **Baca**: `post_images`, `profiles.avatar_r2_key` (untuk mengesan yatim).

## API dalaman (dipanggil feature lain)

| Fungsi | Guna |
|---|---|
| `presign(contentType)` | aws4fetch, S3 API R2 |
| `verifyImage(key, maxDim)` | saiz ≤ 5 MB, magic number padan jenis, dimensi ≤ 4096 (post) / 1024 (avatar) |
| `signedUrl(key)` | URL baca bertandatangan, **dicache KV** |
| `claim(key, userId)` | padam baris `pending_uploads` milik pemanggil - kunci orang lain ditolak |
| `enqueueDelete(keys, reason)` | statement untuk `db.batch()` pemanggil |

## Peraturan

- R2 tidak dikonfigur → `presign` **503** `upload gambar belum tersedia`.
- Kunci dijana pelayan (UUID), bukan daripada klien.
- **Gagal-tertutup** (R9): dimensi tidak dapat diukur = tolak. Pengesahan
  `marc_go` pernah gagal senyap (L16) - jangan ulang.
- Maks 4 gambar setiap post.
- **Satu-satunya tempat yang memadam objek R2** ialah reaper
  (`drainDeleteQueue`). Semua feature lain hanya menggilir kunci.
- Bucket **persendirian**. `R2_PUBLIC_URL` diset = amaran log (bucket
  mungkin terdedah).

## Job: `reaper` (setiap 15 minit)

1. Gilir gambar post yang sudah dipadam lembut tetapi belum digilir.
2. `pending_uploads` lebih tua daripada **6 jam** → gilir padam.
3. Kuras gilir: kepingan kecil, `R2.delete()` (idempoten), tanda selesai
   atau jadual semula dengan backoff.

## Cloudflare

- Presign: **aws4fetch** + rahsia `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`
  (R10). Proksi melalui Worker akan memecahkan klien Flutter lama.
- Pengesahan: `env.BUCKET.get(key)` (≤5 MB, baca penuh) + hurai header JPEG/
  PNG/WebP dalam JS. Tiada binding Images hanya untuk ini.
- `signedUrl`: KV `signed:<key>`, TTL KV 1 jam, URL sah 2 jam. Tanpa cache,
  `X-Amz-Date` berubah dan cache imej peranti dimuat turun semula (R10).
- Claim reaper: satu `UPDATE … WHERE r2_key IN (SELECT … LIMIT n) RETURNING`
  (R3). Dua cron bertindih = kerja sama, keputusan sama.

## Ujian wajib

- PNG bertopeng `.jpg` → ditolak (magic).
- JPEG 5000×10 px → ditolak (dimensi); JPEG rosak → ditolak (gagal-tertutup).
- Lampir `r2_key` milik pengguna lain → 400.
- Dua `signedUrl(key)` berturutan → rentetan sama.
- Reaper: `R2.delete` gagal → baris kekal dengan `attempts + 1`.
