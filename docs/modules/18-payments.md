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
  index.ts  routes.ts  service.ts  repo.ts  schema.ts  dto.ts  jobs.ts
  gateways/
    gateway.ts      interface Gateway + ralat NotConfigured / IgnoredEvent
    stripe.ts       fetch + HMAC crypto.subtle
    toyyibpay.ts    fetch; satu kelas, dua instance
    registry.ts     { stripe, toyyibpay, 'toyyibpay-activity' } daripada env
    contract.test.ts  suite yang sama dijalankan ke atas setiap gateway (L)
  receipts/         pdf-lib: derma, yuran pendaftaran, yuran aktiviti
```

## Kontrak `Gateway` (satu-satunya interface dengan >1 pelaksanaan)

```ts
interface Gateway {
  name: string
  enabled(): boolean
  createPayment(p: { amountCents, currency, metadata }): Promise<{ gatewayRef, clientSecret?, redirectUrl?, rawResponse? }>
  verifyWebhook(req: Request): Promise<{ gatewayRef, status: 'succeeded' | 'failed', paidAt }>  // throw Ignored untuk event tak berkaitan
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
- **Yuran aktiviti**: amaun = `activities.fee_cents` disnapshot pada
  pendaftaran; + `GATEWAY_CHARGE_CENTS`.
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
| `activitysweep` | 15m | pendaftaran aktiviti `pending_payment` lapuk → semak gateway → `cancelled` (lepaskan slot) |
| `registrationsweep` | 15m | `registration_payments` `pending` lebih tua daripada `REGISTRATION_BILL_EXPIRY_MINUTES` → semak gateway → `failed` |

Setiap sweep **semak gateway dahulu** - bayaran lewat tidak hilang senyap.
Semua idempoten dengan guard lajur; dua cron serentak = hasil sama.

## Cloudflare

- Stripe & ToyyibPay melalui `fetch` terus (Stripe: `PaymentIntent` create/
  retrieve + HMAC `crypto.subtle`). Tiada SDK - tiga panggilan tidak
  mewajarkan kebergantungan.
- Poll ToyyibPay (15 s timeout) dalam webhook: `AbortSignal.timeout(15000)`.
- Cron: `*/15 * * * *` (dua sweep), `*/30 * * * *` (reconcile) - kongsi
  handler `scheduled` ([shared](./00-shared.md)).
- Reconcile satu invokasi dihadkan N baris (had subrequest); baki disambung
  pusingan seterusnya.
- Resit PDF: `pdf-lib` (R11). Tarikh resit derma = masa gateway (`paidAt`),
  bukan masa webhook; jangan cetak 1970 (L27a).

## Ujian wajib

- Pindah `toyyibpay_test.go` + `paymentreconcile_live_test.go`.
- Webhook sama dihantar dua kali → satu peralihan, satu emel resit.
- Webhook ToyyibPay dengan `status_id=1` palsu tetapi poll berkata unpaid →
  kekal `pending`.
- Gateway gagal selepas baris `pending` ditulis → baris kekal, reconcile
  membetulkannya kemudian.
- Akaun `tester` → 403 pada ketiga-tiga checkout.
- Yuran tertunggak `/me/payments` = `/dashboard`.
