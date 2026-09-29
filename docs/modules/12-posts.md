# 12 - posts

**Tujuan.** Suapan kelab: post (biasa / pengumuman), gambar, komen
bersarang dua tahap, dan like.

**Sumber `marc_go`**: `handlers/{posts,posts_common,comments}.go`,
`queries/{posts,comments,likes}.sql`.

## Laluan

Semua `verified`.

| Method | Path | Had kadar |
|---|---|---|
| GET | `/posts` | - |
| POST | `/posts` | `post-create` |
| GET | `/posts/:id` | - |
| PATCH | `/posts/:id` | - |
| DELETE | `/posts/:id` | - |
| POST, DELETE | `/posts/:id/like` | - (dedup ialah mekanismenya) |
| GET | `/posts/:id/comments` | - |
| POST | `/posts/:id/comments` | `comment-create` |
| PATCH, DELETE | `/comments/:id` | - |
| POST, DELETE | `/comments/:id/like` | - |

## Data

- **Milik**: `posts`, `post_images`, `post_likes`, `comments`, `comment_likes`.
- **Tulis**: `deleted_uploads` (gambar post dipadam), `audit_logs`
  (update/delete), mesej queue `notify`.

## Peraturan

- `type` ∈ {`normal`, `announcement`}; `announcement` management sahaja.
- Kandungan: post ≤10,000 aksara, komen ≤2,000 aksara (aksara, bukan bait).
- Gambar: maks 4; setiap `r2_key` mesti milik pemanggil dalam
  `pending_uploads` dan lulus `verifyImage` ([uploads](./11-uploads.md)).
- **Padam lembut** (`deleted_at`) - post dipadam = 404 di mana-mana.
- **Sunting: pemilik sahaja** (`cuma pemilik boleh edit post/comment`).
  **Padam**: pemilik **atau** management (`canModify`). PATCH/DELETE wajib
  `updated_at` → 409 `stale_write` bila lapuk ([shared](./00-shared.md)).
- Komen hanya pada post yang belum dipadam (marc_go menerima komen pada post
  dipadam lembut - hanya bergantung pada FK).
- **Komen kedalaman ≤2**: balas komen tahap-2 → dilekatkan pada induk
  tahap-1 asalnya (flatten), bukan tahap 3.
- **Like idempoten**: like kali kedua tiada baris baharu → **tiada
  notifikasi**. Unlike tiada baris = 204. Like pada post/komen yang dipadam
  lembut → 404 (syarat `deleted_at IS NULL` dalam INSERT…SELECT).
- Notifikasi (`post_like`, `post_comment`, `comment_like`) kepada pemilik,
  **bukan** kepada diri sendiri; best-effort selepas komit.
- Senarai: keyset `(created_at, id)`, kursor legap `"<masa>|<uuid>"`,
  lalai 20. Kursor rosak → 400 `cursor tidak sah`.
- Respons senarai dibina berkelompok (kiraan like, kiraan komen, pratonton
  komen, liked-by-me, gambar) - **tiada N+1**.
- Blok `author` best-effort: profil gagal dibaca → blok kosong, bukan 500
  (komen sudah tersimpan).

## Cloudflare

- Cipta post = `db.batch([post, images…, claim pending_uploads…])`.
- Like: `INSERT … ON CONFLICT DO NOTHING RETURNING` → hanya hantar mesej
  `notify` bila satu baris dipulangkan.
- Pratonton berkelompok: `WHERE post_id IN (…)` dikeping ≤100 parameter.
- Kursor: format masa bertukar kepada unix ms - klien melayan kursor sebagai
  legap, jadi selamat.
- Notifikasi = `env.JOBS.send({ type: 'notify', … })`, bukan panggilan
  OneSignal dalam permintaan (R6).

## Ujian wajib

- Like dua kali → satu baris, satu notifikasi.
- Balas komen tahap-2 → `parent_id` = induk tahap-1.
- Ahli biasa cipta `announcement` → 403.
- Post dipadam → `GET /posts/:id` 404, gambar masuk `deleted_uploads`.
- Senarai 45 post dengan limit 20 → tiga halaman, tiada pendua/tertinggal.
