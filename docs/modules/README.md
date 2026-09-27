# Modul

Satu dokumen untuk setiap feature dalam `src/features/<nama>/`. Seni bina
(features-first + SOLID) ditetapkan dalam
[`../00000-foundation.md`](../00000-foundation.md) §5; dokumen di sini cuma
menerangkan **apa** setiap feature buat, bukan cara struktur kod.

Sumber kebenaran tingkah laku ialah **kod `../marc_go`**. Setiap dokumen
menamakan fail Go asalnya. Mesej ralat, bentuk JSON dan kod status disalin
dari sana, bukan dari dokumen ini.

| # | Feature | Laluan utama | Job / Queue |
|---|---|---|---|
| 00 | [shared](./00-shared.md) | middleware, envelope, config, authz, audit, email, push, pdf | `enqueue`; dispatch di `index.ts` |
| 01 | [auth](./01-auth.md) | `/auth/*`, `/me/sessions*` | - |
| 02 | [telegram](./02-telegram.md) | `/me/telegram-link*`, `/webhooks/telegram` | - |
| 03 | [profile](./03-profile.md) | `/me`, `/me/addresses*`, `/me/deletion-request` | - |
| 04 | [members](./04-members.md) | `/members*`, `/roles` | - |
| 05 | [departments](./05-departments.md) | `/admin/departments*`, `/departments` | - |
| 06 | [blocked-email-domains](./06-blocked-email-domains.md) | `/admin/blocked-email-domains*` | - |
| 07 | [account-lifecycle](./07-account-lifecycle.md) | `/admin/account-deletion-*` | - |
| 08 | [bans](./08-bans.md) | `/admin/banned-members`, `/admin/members/:id/ban` | - |
| 09 | [audit](./09-audit.md) | `/audit-logs` | `retention` (24j) |
| 10 | [legacy-import](./10-legacy-import.md) | `/admin/legacy-member-import*`, `/auth/legacy-member-claim/*` | - |
| 11 | [uploads](./11-uploads.md) | `/uploads/presign` | `reaper` (15m) |
| 12 | [posts](./12-posts.md) | `/posts*`, `/comments*` | queue: notify |
| 13 | [notifications](./13-notifications.md) | `/notifications*`, `/device-tokens*` | queue consumer: notify |
| 14 | [dashboard](./14-dashboard.md) | `/dashboard` | - |
| 15 | [activities](./15-activities.md) | `/activity-categories*`, `/activities*` | `lifecycle` (1j) |
| 16 | [registrations](./16-registrations.md) | `/activities/:id/registration*`, attendance, `/me/activities` | - |
| 17 | [certificates](./17-certificates.md) | `/activities/:id/certificates`, `/certificates/*`, `/me/certificates*`, `/verify/certificates/:token`, templates | - |
| 18 | [payments](./18-payments.md) | derma, yuran pendaftaran, yuran aktiviti, status, resit, reconcile | `reconcile` (30m), `activitysweep` (15m), `registrationsweep` (15m) |

## Pemilik jadual

Hanya pemilik menulis (`00000` §5.2). 36 jadual, setiap satu tepat sekali:

| Feature | Jadual |
|---|---|
| auth | `users`, `refresh_tokens`, `email_verification_tokens`, `email_verification_sends`, `password_reset_tokens` |
| telegram | `telegram_link_tokens` |
| profile | `profiles`, `member_addresses`, `account_deletion_requests` |
| members | `roles`, `sequences` |
| departments | `departments` |
| blocked-email-domains | `blocked_email_domains` |
| audit | `audit_logs` |
| legacy-import | `legacy_member_import_batches`, `legacy_member_import_rows`, `legacy_member_claim_tokens` |
| uploads | `pending_uploads`, `deleted_uploads` |
| posts | `posts`, `post_images`, `post_likes`, `comments`, `comment_likes` |
| notifications | `notifications`, `device_tokens` |
| activities | `activity_categories`, `activities`, `activity_sessions` |
| registrations | `activity_registrations`, `activity_attendances` |
| certificates | `activity_certificates`, `certificate_templates` |
| payments | `donations`, `registration_payments`, `payment_logs` |
| account-lifecycle, bans, dashboard | tiada - bertindak melalui pemilik |

`profiles` ialah jadual paling banyak disentuh. `profile` memilikinya dan
mengeksport operasi bernama (`setStatus`, `setRole`, `verifyStaffId`,
`setBan`, `setTelegram`, …) - `members`, `bans`, `telegram`, `auth` memanggil
operasi itu, tidak pernah menulis SQL `profiles` sendiri.

`audit_logs` ditulis oleh semua feature melalui `shared/audit.ts`
(`auditStmt`) - satu-satunya pengecualian, kerana penulis audit ialah kod
kongsi, bukan feature.

## Graf kebergantungan

`A → B` = A mengimport `features/B/index.ts`. Mesti asiklik.

| Feature | Bergantung pada |
|---|---|
| notifications, uploads, audit, activities | - |
| profile | uploads |
| departments, blocked-email-domains | profile (`requireMinRole`) |
| auth | profile, blocked-email-domains |
| telegram | profile |
| bans | profile, members |
| members | auth, profile, departments, uploads |
| payments | profile, registrations, activities |
| registrations | activities |
| certificates | activities, registrations, profile, members |
| posts | uploads, profile |
| legacy-import | auth, profile, departments |
| account-lifecycle | auth, members, profile, uploads, payments |
| dashboard | *(read-model - cross-read)* |

Semua feature boleh menghantar mesej `notify` melalui `shared/jobs.ts`
(`enqueue`) - bukan import `notifications`.

Kitaran yang dipecahkan dengan port (D):
- `profile` & `members` perlukan status yuran pendaftaran (`/me`, `/members`)
  → cross-read subquery `registration_payments` dalam `profile/repo.ts`
  (pariti query marc_go), bukan import `payments`.
- Gate peranan (`requireMinRole`) dalam `profile`, bukan `members` - kalau
  tidak `departments → members → departments`.
- `activities` perlukan kiraan pendaftaran → cross-read subquery (a), bukan
  import `registrations`.

## Bentuk setiap dokumen

1. **Tujuan** - satu perenggan.
2. **Sumber `marc_go`** - fail yang dipindahkan.
3. **Laluan** - method, path, lapisan akses (`awam` / `protected` /
   `approved` / `verified`, lihat `00000` §6), siling dalam handler, baldi
   had kadar.
4. **Data** - jadual yang feature ini **miliki** (hanya ia yang tulis) dan
   jadual yang ia baca.
5. **Peraturan** - invarian yang mesti kekal. Ini bahagian yang paling
   penting; ujian ditulis daripadanya.
6. **Cloudflare** - binding yang dipakai dan corak D1 yang direka semula
   (rujuk R1-R12 dalam `00001` §5).
7. **Ujian wajib** - senarai minimum; setiap satu mesti gagal kalau
   peraturan dilanggar.

Tambah feature baharu = satu folder + satu dokumen + satu baris jadual di
atas. Tiada yang lain.
