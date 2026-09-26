# 00002 - Tooling: migrasi, seed, arahan

Gaya migrasi ikut `../hono-workers` (fail SQL bernombor, header komen yang
menerangkan **kenapa**, `IF NOT EXISTS`), tetapi runner dan arahan dibina
semula untuk menutup masalah yang ditemui di sana.

Asas: [`00000-foundation.md`](./00000-foundation.md). Kerja: [`../TODO.md`](../TODO.md).

---

## 1. Apa yang kita ambil, apa yang kita buang dari `hono-workers`

| `hono-workers` | Masalah | `marc_bun` |
|---|---|---|
| `scripts/migrate.js` (422 baris) spawn `npx wrangler` per statement | perlahan; escape shell `--command="…"` rapuh (`$`, backtick) | **`wrangler d1 migrations apply`** native - 0 baris runner |
| Pecah SQL pada `;` | **memecahkan trigger** (`BEGIN … ; … END;`) - `audit_logs` append-only kita guna trigger | fail dihantar utuh oleh wrangler |
| Setiap fail tulis `INSERT OR IGNORE INTO schema_migrations` sendiri | lupa satu baris = migrasi dijalankan semula | wrangler rekod dalam `d1_migrations` secara automatik |
| Hack `ADD COLUMN` idempoten (regex + `PRAGMA` + tangkap ralat) | wujud kerana migrasi boleh dijalankan semula | tidak perlu: migrasi yang direkod tidak pernah dijalankan semula |
| `down` menjalankan **fail up yang sama** | rollback palsu | **forward-only**; rollback = D1 Time Travel + migrasi pembetulan |
| Tiada atomik per migrasi | gagal di tengah = skema separa | wrangler: migrasi yang gagal di-rollback, yang sebelumnya kekal |
| `db:reset` dengan senarai `DROP TABLE` tulisan tangan (lokal **dan remote**) | senarai basi; reset remote ialah footgun | reset **lokal sahaja**, padam state `.wrangler` - tiada senarai |
| Seed dijejak dalam `seed_versions`, status dihurai dengan regex | rapuh | data rujukan = migrasi; fixture dev = SQL idempoten, tiada jejak |
| Skrip `verify-*.ts` berasingan (8 fail) | bukan ujian sebenar; tiada CI | `bun test` |
| Tiada semakan fail migrasi diubah | migrasi yang sudah digunakan boleh disunting senyap | CI tolak sebarang **perubahan** pada fail migrasi sedia ada |
| Nama DB dihardcode dalam setiap arahan | | nama binding `DB` sahaja; wrangler baca `wrangler.jsonc` |

## 2. Migrasi

### Lokasi & penamaan

```jsonc
// wrangler.jsonc
"d1_databases": [{
  "binding": "DB",
  "database_name": "marc",
  "database_id": "…",
  "migrations_dir": "src/database/migrations"
}]
```

```
src/database/migrations/
  20260926100000_auth.sql          users + token auth
  20260926100100_members.sql       roles (+seed) + sequences
  20260926100200_departments.sql   (+seed)
  20260926100300_profile.sql       profiles, member_addresses, account_deletion_requests
  …
  20260926101400_legacy_import.sql
```

Skema awal = **satu fail setiap feature pemilik**, ikut urutan FK. Migrasi
seterusnya: `YYYYMMDDHHMMSS_<feature>_<apa>.sql` (cap masa **UTC**, gaya goose
`marc_go`).

- Dicipta **hanya** dengan `bun run db:new <feature>_<apa>`
  (`scripts/db-new.ts`). `wrangler d1 migrations create` tidak dipakai: ia
  hanya memberi max+1, bukan cap masa. Skrip menolak `<feature>` yang tiada
  dalam peta pemilik, dan menulis header "Pemilik / Kenapa".
- Kenapa cap masa, bukan `0001`: dua cawangan yang mencipta migrasi serentak
  tidak berlanggar nombor. Wrangler menyusun ikut nama dan menjalankan
  migrasi yang belum direkod - disahkan berfungsi dengan cap masa.
- Harga cap masa: migrasi dari cawangan lama (cap masa lebih awal daripada
  yang sudah di `main`) akan dijalankan **di luar urutan** di produksi. CI
  menolaknya (`scripts/check-migrations.ts`) - jana semula selepas rebase.
- Nama bermula dengan **feature pemilik** (features-first): skema dikongsi
  satu direktori kerana urutan FK global, tetapi pemiliknya jelas.
- Data rujukan yang produksi perlukan (`roles`, `activity_categories`,
  `certificate_templates` lalai) = **migrasi**, bukan seed. Padan `marc_go`
  (`seed_roles.sql` ialah migrasi goose).

### Gaya fail (dari `hono-workers`)

```sql
-- 0007_audit_logs.sql
--
-- Kenapa: jejak append-only. Trigger menolak UPDATE kecuali redaksi PII
-- (ip_address/user_agent → NULL) oleh retention. Lihat docs/modules/09-audit.md.
--
-- Pemilik: features/audit

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY,
  …
);

CREATE TRIGGER IF NOT EXISTS audit_logs_append_only
BEFORE UPDATE ON audit_logs
WHEN NEW.action IS NOT OLD.action OR …
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only');
END;
```

### Peraturan

1. **Forward-only.** Tiada `down`. Silap = migrasi baharu yang membetulkan.
2. **Tidak pernah sunting fail yang sudah di-merge.** CI menguatkuasakan:
   `scripts/check-migrations.ts` (CI pada PR) menolak fail sedia ada yang
   diubah, dipadam atau dinamakan semula.
3. **Expand → deploy → contract.** Migrasi dijalankan **sebelum** kod baharu
   dideploy, jadi setiap migrasi mesti serasi dengan kod yang sedang hidup:
   tambah lajur/jadual dahulu; buang/rename hanya dalam migrasi kemudian
   selepas tiada kod membacanya.
4. SQLite tiada `ALTER COLUMN`: tukar jenis/kekangan = jadual baharu + salin +
   `DROP` + `RENAME` dalam satu migrasi (`PRAGMA defer_foreign_keys = ON`).
5. Setiap kekangan ada ujian yang membuktikannya **gagal** bila dilanggar
   (`src/database/schema.test.ts`).

### Rollback produksi

```bash
bun run db:bookmark:remote        # SEBELUM deploy - simpan bookmark Time Travel
bun run db:restore:remote <bookmark>
```

Time Travel = 30 hari (Workers Paid). `deploy` mencetak bookmark secara
automatik (§4).

## 3. Seed (dev sahaja)

```
src/database/seeds/
  dev.sql          ahli contoh setiap peranan, aktiviti, post
```

- **Idempoten** (`INSERT OR IGNORE` dengan id tetap), jadi tiada jadual jejak.
- **Tiada `--remote`.** Produksi tidak pernah menerima fixture.
- Kata laluan contoh = satu hash bcrypt tetap, didokumenkan dalam header fail.

## 4. Arahan (`package.json`)

| Arahan | Apa | Nota |
|---|---|---|
| `dev` | `wrangler dev --env-file .env.dev` | D1/KV/R2/Queue lokal; **jangan** jalankan `wrangler dev` terus |
| `check` | `tsc -p tsconfig.json && tsc -p tsconfig.test.json && bun test` | satu arahan sebelum commit/PR; program Worker (tanpa jenis Node) + program ujian/skrip (Bun) |
| `test` | `bun test` | termasuk ujian sempadan feature (`00000` §5.2) |
| `cf-typegen` | `wrangler types … --env-file .env.example` | selepas ubah `wrangler.jsonc`; commit hasilnya (CI semak selari) |
| `db:new <feature>_<apa>` | `bun scripts/db-new.ts` | satu-satunya cara cipta migrasi; `YYYYMMDDHHMMSS_…` UTC |
| `db:migrate` | `wrangler d1 migrations apply DB --local` | |
| `db:status` | `wrangler d1 migrations list DB --local` | |
| `db:reset` | padam `.wrangler/state/v3/d1` → `db:migrate` → `db:seed` | **lokal sahaja** |
| `db:seed` | `wrangler d1 execute DB --local --file src/database/seeds/dev.sql` | |
| `db:sql "<sql>"` | `wrangler d1 execute DB --local --command` | pintasan |
| `db:migrate:remote` | `wrangler d1 migrations apply DB --remote` | wrangler ambil backup automatik |
| `db:status:remote` | `wrangler d1 migrations list DB --remote` | |
| `db:bookmark:remote` | `wrangler d1 time-travel info DB` | Time Travel sentiasa remote |
| `db:restore:remote <b>` | `wrangler d1 time-travel restore DB --bookmark <b>` | |
| `db:backup:remote` | `wrangler d1 export DB --remote --output backups/<masa>.sql` | salinan luar Cloudflare |
| `deploy` | `check` → `secrets:check` → `db:bookmark:remote` → `db:migrate:remote` → `wrangler deploy --minify` | berhenti pada langkah pertama yang gagal |
| `tail` | `wrangler tail` | log produksi langsung |
| `secrets:push [--dry-run]` | `bun scripts/secrets-push.ts` | tolak semua rahsia dalam `.env` ke **produksi** sekali gus (`wrangler secret bulk`, via stdin); kosong dilangkau; nama salah eja / var ditolak; kemudian `secrets:check` |
| `secrets:check` | `bun scripts/secrets-check.ts` | banding `wrangler secret list` dengan skema `shared/config.ts`; senarai yang hilang |
| `telegram:webhook` | `bun scripts/telegram-webhook.ts` | *ditambah dalam Fasa 2* - `setWebhook` dengan `secret_token` |
| `data:transform` | `bun scripts/transform-postgres.ts` | *ditambah dalam Fasa 9* - Postgres → SQL D1 berkeping (`00001` §6) |

Tiada arahan `*:reset:remote`. Tiada `db:migrate:up/down <versi>`.
Tiada `kv:reset:remote` - kunci KV kita semua ada TTL.

## 5. Skrip

Semua dalam **TypeScript dijalankan dengan Bun** (`bun scripts/x.ts`), bukan
`.js` tanpa jenis. Skrip dan ujian di-type-check oleh `tsconfig.test.json` (jenis Bun);
kod Worker oleh `tsconfig.json` dengan `types: []` - jadi `Buffer`/`node:fs`
dalam `src/` gagal type-check.

| Skrip | Kenapa wujud |
|---|---|
| `db-new.ts`, `check-migrations.ts` | cap masa UTC + pemilik wajib; CI: tiada suntingan, tiada cap masa di luar urutan (diuji dalam `migrations.test.ts`) |
| `secrets-push.ts` + `secrets-lib.ts` | malas `secret put` satu-satu; logik tulen diuji dalam `secrets.test.ts` |
| `secrets-check.ts` | 20+ secret/var; satu yang hilang = ciri mati senyap (`00000` §4) |
| `telegram-webhook.ts` | daftar webhook + rahsia, sekali setiap persekitaran |
| `transform-postgres.ts` | migrasi data sekali (`00001` §6) |

Skrip lain hanya bila ada keperluan berulang yang terbukti.

## 6. Ujian

- `bun test` - semua `*.test.ts` bersebelahan dengan kod.
- Binding sebenar: `testEnv()` (`src/test/env.ts`) → direktori sementara,
  `wrangler d1 migrations apply` (runner produksi yang sama), kemudian
  `getPlatformProxy()`. Setiap panggilan = DB baharu; `dispose()` membersihkan.
- HTTP: `app.request(path, init, env)` - tiada pelayan.
- `src/architecture.test.ts` membaca peta pemilik terus dari
  `docs/modules/README.md` - ubah pemilik = ubah dokumen itu.

## 7. Sediakan sumber Cloudflare (sekali)

**Remote = produksi sahaja. Lokal = dev.** Tiada `--env`/staging:
`ENVIRONMENT` dalam `wrangler.jsonc` ialah `production`; `.env.dev` lokal
menindihnya dengan `development`.

| Fail | Guna | Git |
|---|---|---|
| `.env.example` | senarai kunci untuk kedua-dua fail + sumber jenis rahsia (`cf-typegen`) | commit |
| `.env` | rahsia **produksi**, hanya dibaca `secrets:push` | diabaikan |
| `.env.dev` | rahsia **lokal** - `bun run dev` = `wrangler dev --env-file .env.dev` | diabaikan |

`.env` ialah nama lalai yang **semua** alat baca secara automatik, jadi
setiap laluan ditutup secara eksplisit (disahkan 2026-09-26):

| Alat | Tanpa tutup | Tutup |
|---|---|---|
| `wrangler dev` | memuatkan `.env` → Stripe/ToyyibPay sebenar dalam dev | `--env-file .env.dev` (hanya fail itu dibaca) |
| `wrangler types` | nama kunci `.env` masuk jenis, CI berbeza | `--env-file .env.example` |
| `bun test`, `bun scripts/*` | `.env` dimuat ke `process.env` | `bunfig.toml`: `env = false` |
| `getPlatformProxy()` (ujian) | memuatkan `.env` | `envFiles: []` (`src/test/env.ts`) |

Menjalankan `wrangler dev` **terus** (bukan `bun run dev`) akan memuatkan
`.env` prod - sentiasa guna `bun run dev`.


```bash
bunx wrangler login
bunx wrangler d1 create marc                 # salin database_id ke wrangler.jsonc
bunx wrangler kv namespace create KV         # salin id
bunx wrangler r2 bucket create marc
bunx wrangler queues create marc-jobs
bunx wrangler queues create marc-jobs-dlq
bun run cf-typegen
cp .env.example .env                         # isi nilai PROD; JWT_SECRET SAMA dengan marc_go (00000 §7)
bun run secrets:push --dry-run
bun run secrets:push                         # semua sekali + secrets:check
```

`namespace_id` ratelimit (1001-1017) ialah integer pilihan sendiri - unik
dalam akaun, tiada arahan cipta.

## 8. CI

`.github/workflows/ci.yml`:

```
bun install --frozen-lockfile
bun run cf-typegen && git diff --exit-code worker-configuration.d.ts   # jenis selari
bun run check
bun scripts/check-migrations.ts origin/<base>                            # tiada suntingan + urutan cap masa (PR)
bun run db:migrate                                                      # bersih dari kosong
wrangler deploy --dry-run
```

Deploy produksi = `bun run deploy` dari cawangan `main` sahaja.
