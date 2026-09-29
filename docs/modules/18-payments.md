# 18 - payments

**Tujuan.** Tiga modul bayaran di atas satu kontrak `Gateway`: derma
(Stripe), yuran pendaftaran ahli (ToyyibPay), yuran aktiviti (ToyyibPay) -
berserta log, status, resit, sejarah, dan reconcile.

**Sumber `marc_go`**: `internal/{payment,paymentlog,paymentreconcile,receipt,
receiptmail,activitysweep,registrationsweep}`,
`handlers/{donations,registration_payment,activity_registration_payment,
payments,payment_status,payment_config,payment_reconcile,paymentlog_helpers}.go`,
`queries/{donations,registration_payments,payment_logs}.sql`.

## Laluan

| Method | Path | Lapisan | Had / gate |
|---|---|---|---|
| POST | `/donations/checkout` | awam + `optionalAuth` | `donation`, `blockTesterWrites` |
| POST | `/webhooks/:gateway` | awam | - (Stripe) |
| POST | `/registration-payments/checkout` | protected | `registration-payment-checkout`, `blockTesterWrites` |
| POST | `/registration-payments/webhook/toyyibpay` | awam | `registration-payment-webhook` |
| GET | `/registration-payments/return/toyyibpay` | awam (HTML / 302) | - |
| POST | `/activities/:id/registration/checkout` | verified | `activity-payment-checkout`, `blockTesterWrites` |
| POST | `/activity-registrations/webhook/toyyibpay` | awam | `registration-payment-webhook` |
| GET | `/activity-registrations/return/toyyibpay` | awam (HTML / 302) | - |
| GET | `/payment-status/:gateway/:reference` | awam + CORS | `payment-status` |
| GET | `/payment-config` | protected | - |
| GET | `/me/payments` | protected | - |
| GET | `/me/payments/{registration,activity,donation}/:id/receipt` | protected | `payment-receipt` |
| GET | `/admin/payments` | approved | management |
| POST | `/admin/payments/reconcile` | approved | management |
| POST | `/members/:id/cancel-registration-payment` | approved | admin ke atas; semak gateway **dahulu** - sudah bayar → tolak, pending → `failed` + audit |

**Laluan webhook dan return tidak boleh berubah** - ToyyibPay membakar URL
ke dalam setiap bil yang masih hidup.

## Data

- **Milik**: `donations`, `registration_payments` (id UUID), `payment_logs`
  (id `INTEGER PRIMARY KEY` - log dalaman, keyset `before_id`; `00000` §10).
- **Melalui pemilik**: `registrations.setPayment()` / `cancelUnpaid()`
  (lajur `payment_status`, `payment_ref` = billcode, `fee_cents_paid` pada
  `activity_registrations`),
  `activities.findById()` (yuran), `profile.findById()` (pengecualian staff).
- **Eksport**: `registrationFeeStatus(userId)` (satu-satunya pengiraan yuran
  tertunggak - dipakai `profile` melalui port, `members`, `dashboard`),
  `detach(userId)` (untuk `account-lifecycle`).

## Fail

```
features/payments/
  index.ts  routes.ts  service.ts  repo.ts  jobs.ts
  gateways.ts       interface Gateway, NotConfigured/IgnoredEvent, Stripe (fetch + HMAC
                    crypto.subtle), ToyyibPay (fetch; satu kilang, dua instance), gatewaysFor()
  gateways.test.ts  kontrak kedua-dua gateway (fetch disimulasi)
  receipt.ts        resit PDF (derma, yuran) + emel resit (receiptmail)
  logo.png.txt      crest kelab (base64 - Worker tiada fs)
shared/pdf.ts       semantik fpdf di atas pdf-lib (dikongsi dengan certificates)
```

Gateway disuntik melalui `AppDeps.gateways(config)`; ujian guna `fakeGateway`
(`src/test/app.ts`). Job cron membina gateway sebenar sendiri; fungsi dalaman
(`runReconcile`, `runRegistrationSweep`) menerima gateway untuk diuji.

## Kontrak `Gateway` (satu-satunya interface dengan >1 pelaksanaan)

```ts
interface Gateway {
  name: string
  enabled(): boolean
  createPayment(p: { amountCents, currency, metadata }): Promise<{ gatewayRef, clientSecret?, redirectUrl?, rawResponse? }>
  verifyWebhook(payload: string, headers: Headers): Promise<{ gatewayRef, status: 'succeeded' | 'failed', paidAt }>  // throw IgnoredEvent untuk event tak berkaitan
  checkStatus(gatewayRef): Promise<'pending' | 'succeeded' | 'failed'>
}
```

Registry: `stripe`, `toyyibpay` (callback yuran pendaftaran),
`toyyibpay-activity` (kredential **sama**, callback/return **berbeza**).
Tambah gateway = satu fail + satu entri registry; tiada service berubah.

## Peraturan

- **Susunan tulis**: baris `pending` ditulis **sebelum** memanggil gateway;
  `registration_payments.gateway_ref` nullable, diisi selepas; indeks unik
  separa `(gateway, gateway_ref) WHERE gateway_ref IS NOT NULL`.
  (`donations.gateway_ref` kekal NOT NULL + unik penuh - pariti skema.)
- **Idempotensi** melalui guard `WHERE` (`status <> 'succeeded'`,
  `payment_status <> 'paid'`), bukan baca-dahulu. Webhook berulang = no-op 200.
- **Webhook tidak dipercayai**: Stripe - tandatangan HMAC; ToyyibPay - ambil
  `billcode` sahaja, sahkan dengan poll `getBillTransactions`. Gateway ialah
  sumber kebenaran.
- `ErrNotConfigured` → 503; `ErrIgnoredEvent` → 200.
- **`payment_logs`**: best-effort, `raw_payload` TEXT direkod **sebelum**
  parse (supaya payload rosak masih boleh didiagnosis); tidak pernah
  didedahkan melalui API.
- **Derma**: anonim wajib `donor_email`; log masuk dikaitkan `user_id`;
  `CHECK (user_id IS NOT NULL OR donor_email IS NOT NULL)`. Resit emel
  best-effort selepas webhook berjaya.
- **Yuran pendaftaran**: sekali bayar; ahli `pending` mesti boleh bayar
  (lapisan `protected`). Pengecualian staff → tiada bil.
  `outstandingRegistrationFee()` ialah **satu** fungsi dikongsi dengan
  [dashboard](./14-dashboard.md).
- **Yuran aktiviti**: amaun bil = `activities.fee_cents` semasa checkout,
  disnapshot ke `fee_cents_paid`. `GATEWAY_CHARGE_CENTS` **tidak** ditambah pada
  bil - hanya dipaparkan sebagai pecahan pada resit dan `/payment-config`.
- **Checkout ToyyibPay** wajib `billPhone`: telefon profil yang sah dipakai;
  kosong/cacat → 400 `code: phone_required`, nombor baharu disimpan ke profil.
- **Gateway gagal selepas baris pending ditulis** (yuran pendaftaran, L29) →
  tiada bil wujud, baris ditanda `failed`. Bil dicipta tetapi pautan gagal →
  log `mismatch` membawa kedua-dua belah untuk pautan manual.
- **Bayar selepas dibatal sweep** (yuran aktiviti) → `cancelled` + `paid`
  sengaja kelihatan, log `mismatch`, semakan manual.
- `/webhooks/:gateway` menerima mana-mana nama dalam registry (pariti).
- **Return page**: `*_RETURN_URL` diset → 302 dengan query string ToyyibPay
  dikekalkan; kosong → HTML makluman. **Bukan** sumber status.
- **Resit**: PDF dijana setiap permintaan (tiada R2); sendiri sahaja; hanya
  bayaran berjaya/`paid`; derma anonim tiada resit melalui API.
- `/me/payments` pulang **tiga** senarai berasingan (bukan satu).
- `/admin/payments` keyset `before_id` atas `payment_logs`.
- `/payment-status`: `reference` disemak aksara selamat sebelum dihantar ke gateway.

## Job

| Job | Jadual | Tindakan |
|---|---|---|
| `reconcile` | 30m | semua baris `pending` → `checkStatus` → betulkan DB ikut gateway |
| `activitysweep` | 15m | pendaftaran `payment_status = 'pending'`: tiada bil >45 min, ada bil >24 j → `cancelled` (lepaskan slot). **Tiada** semakan gateway (pariti) - bayaran lewat ditangkap webhook sebagai cancelled+paid |
| `registrationsweep` | 15m | `registration_payments` `pending` lebih tua daripada `REGISTRATION_BILL_EXPIRY_MINUTES` → semak gateway → `failed` |

`registrationsweep` dan pembatalan admin **semak gateway dahulu** - bayaran lewat tidak hilang senyap.
Semua idempoten dengan guard lajur; dua cron serentak = hasil sama.

## Cloudflare

- Stripe & ToyyibPay melalui `fetch` terus (Stripe: `PaymentIntent` create/
  retrieve + HMAC `crypto.subtle`). Tiada SDK - tiga panggilan tidak
  mewajarkan kebergantungan.
- Poll ToyyibPay (15 s timeout) dalam webhook: `AbortSignal.timeout(15000)`.
- Cron: `*/15 * * * *` (dua sweep), `*/30 * * * *` (reconcile) - kongsi
  handler `scheduled` ([shared](./00-shared.md)).
- Reconcile satu invokasi: 50 baris setiap jenis (marc_go 200) - had
  subrequest/D1; baki disambung pusingan seterusnya.
- `payment_logs.user_id` diisi melalui subquery `users` - pengguna dipadam
  tidak menggagalkan log.
- Bundle Worker selepas Fasa 7: 479 KiB gzip.
- Resit PDF: `pdf-lib` (R11). Tarikh resit derma = masa gateway (`paidAt`),
  bukan masa webhook; jangan cetak 1970 (L27a).

## Ujian wajib

- Pindah `toyyibpay_test.go` + `paymentreconcile_live_test.go`.
- Webhook sama dihantar dua kali → satu peralihan, satu emel resit.
- Webhook ToyyibPay dengan `status_id=1` palsu tetapi poll berkata unpaid →
  kekal `pending`.
- Gateway gagal selepas baris `pending` ditulis → baris `failed`, tiada bil.
- Akaun `tester` → 403 pada ketiga-tiga checkout.
- Yuran tertunggak `/me/payments` = `/dashboard`.
