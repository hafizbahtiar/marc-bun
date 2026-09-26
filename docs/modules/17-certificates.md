# 17 - certificates

**Tujuan.** Terbit sijil penyertaan kepada ahli yang layak, jana PDF bila
dimuat turun, tarik balik, templat gaya, dan pengesahan awam melalui QR.

**Sumber `marc_go`**: `handlers/{activity_certificates,certificate_templates}.go`,
`internal/certificate/*`, `queries/{activity_certificates,certificate_templates}.sql`.

## Laluan

| Method | Path | Lapisan | Siling / had |
|---|---|---|---|
| POST | `/activities/:id/certificates` | verified | management |
| POST | `/certificates/:id/revoke` | verified | management |
| GET | `/me/certificates` | approved | sendiri |
| GET | `/me/certificates/:id/file` | approved | sendiri; PDF dijana on-demand |
| GET | `/verify/certificates/:token` | **awam** + CORS GET | baldi `verify` sendiri |
| GET | `/admin/certificate-templates` | verified | management |
| GET, PATCH | `/admin/certificate-templates/:id` | verified | management; PATCH wajib `updated_at` |
| POST | `/admin/certificate-templates/:id/publish` | verified | management |

## Data

- **Milik**: `activity_certificates`, `certificate_templates`.
- **Melalui pemilik**: `members.nextSequence('certificate', n)`,
  `activities.findWithSessions()`, `registrations.attendanceSummary()`,
  `profile.findById()`; mesej `notify` (`certificate_ready`).

## Peraturan

- **Kelayakan** (fungsi tulen, tiada DB):
  `attended * 100 >= totalSessions * thresholdPct`, integer, bukan float;
  `totalSessions <= 0` → tidak layak.
- Terbit hanya **selepas sesi terakhir tamat** → 422.
- **Terbit = metadata sahaja**: siri, `verify_token`, dan **snapshot** (nama
  penerima, tajuk aktiviti, kategori, tarikh, gaya templat) disimpan dalam
  baris. PDF **tidak** disimpan di R2 - dijana setiap muat turun daripada
  snapshot. (`fillPendingCertificateFiles` dalam `marc_go` ialah kod mati.)
- Idempoten: terbit semula tidak menduplikasi sijil yang sudah ada
  (unik `(activity_id, user_id)`).
- **Muat turun**: bukan pemilik → 404; ditarik balik → 410
  `sijil ini telah ditarik balik`.
- **Tarik balik**: baris **tidak** dipadam - pengesahan mesti boleh
  menunjukkan "ditarik balik", bukan "tidak dijumpai" (sama dengan palsu).
- **Pengesahan awam**: medan terhad sahaja - `serial`, `recipient_name`,
  `activity_title`, `activity_date`, `issued_at`, `status`
  (`sah` | `ditarik_balik`). Token tidak dikenali dan token cacat →
  404 **bait-demi-bait sama**.
- Pautan QR: `CERTIFICATE_VERIFY_URL?token=…` bila diset, jika tidak
  `PUBLIC_BASE_URL/verify/certificates/:token`. Hanya sijil yang dijana
  selepas perubahan terjejas - sijil bercetak kekal.
- **PDF**: A4 landskap, QR; semak setiap medan teks terhadap pengekodan font
  **sebelum** melukis dan namakan medan yang gagal (R11); potong teks
  panjang ikut lebar.
- Templat: suntingan disimpan sebagai draf, `publish` menjadikannya lalai
  untuk penerbitan seterusnya. Sijil sedia ada tidak berubah (snapshot).

## Cloudflare

- **Terbit**: kira layak (bacaan), ambil N siri (`sequences` upsert +N,
  satu statement), kemudian `db.batch()` insert berkeping (≤100 parameter) +
  audit. Jurang siri bila batch gagal = diterima (R4).
- Tiada Durable Object diperlukan: unik `(activity_id, user_id)` +
  `INSERT … ON CONFLICT DO NOTHING` menjadikan penerbitan serentak selamat.
  (Ini menggantikan cadangan DO dalam R1/R7 `00001`.)
- **Muat turun**: `pdf-lib` dalam permintaan. Satu PDF, bukan 200 - had CPU
  memadai; ukur (`TODO.md` verifikasi).
- `verify` di belakang baldi `ratelimits` sendiri - trafik awam tidak boleh
  menghabiskan kuota log masuk ahli.

## Ujian wajib

- `IsEligible`: 2/3 @ 66 → layak, 2/3 @ 67 → tidak; 0 sesi → tidak.
- Terbit dua kali → tiada pendua, siri tidak meningkat untuk yang sedia ada.
- Terbit sebelum sesi terakhir tamat → 422.
- Verify: token rawak vs token cacat → respons sama; tiada `user_id`/emel.
- Sijil ditarik balik: verify `ditarik_balik`, muat turun 410.
- Nama dengan aksara di luar set font → ralat menamakan `recipient_name`.
