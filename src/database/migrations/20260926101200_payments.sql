-- Pemilik: features/payments (docs/modules/18-payments.md)
--
-- Susunan tulis: baris `pending` SEBELUM gateway dipanggil; gateway_ref diisi
-- selepas. Idempotensi melalui guard WHERE (status <> 'succeeded'), bukan
-- baca-dahulu. Wang = INTEGER sen.

-- user_id NULL bila penderma tanpa akaun ATAU akaun sudah dipadam
-- (ON DELETE SET NULL - rekod kewangan kekal). Jejak wajib: user_id atau emel.
-- Pariti marc_go: derma ahli log masuk menyimpan donor_email = '' (bukan
-- NULL), jadi CHECK kekal lulus selepas SET NULL. Baris dengan donor_email
-- NULL akan MENGGAGALKAN pemadaman akaun - payments.detach() mesti menukar
-- NULL → '' dahulu (modules/07-account-lifecycle.md).
CREATE TABLE donations (
  id           TEXT PRIMARY KEY,
  user_id      TEXT REFERENCES users (id) ON DELETE SET NULL,
  donor_name   TEXT,
  donor_email  TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency     TEXT NOT NULL DEFAULT 'myr',
  gateway      TEXT NOT NULL CHECK (gateway IN ('stripe', 'sociabuzz')),
  gateway_ref  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  created_at   INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  CONSTRAINT donations_traceable CHECK (user_id IS NOT NULL OR donor_email IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX donations_gateway_gateway_ref_idx ON donations (gateway, gateway_ref);
CREATE INDEX donations_user_id_idx ON donations (user_id) WHERE user_id IS NOT NULL;

-- gateway_ref NULL sehingga bil ToyyibPay dicipta (baris ditulis dahulu).
CREATE TABLE registration_payments (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency     TEXT NOT NULL DEFAULT 'myr',
  gateway      TEXT NOT NULL CHECK (gateway IN ('toyyibpay')),
  gateway_ref  TEXT,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  created_at   INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
) STRICT;

CREATE UNIQUE INDEX registration_payments_gateway_gateway_ref_idx ON registration_payments (gateway, gateway_ref) WHERE gateway_ref IS NOT NULL;
CREATE INDEX registration_payments_user_id_idx ON registration_payments (user_id);

-- Log dalaman best-effort. id INTEGER (keyset before_id, 00000 §10).
-- raw_payload direkod SEBELUM parse; tidak pernah didedahkan melalui API.
CREATE TABLE payment_logs (
  id           INTEGER PRIMARY KEY,
  module       TEXT NOT NULL CHECK (module IN ('donation', 'registration_fee', 'activity_fee')),
  event        TEXT NOT NULL,
  status       TEXT NOT NULL,
  gateway      TEXT NOT NULL,
  gateway_ref  TEXT,
  amount_cents INTEGER,
  user_id      TEXT REFERENCES users (id) ON DELETE SET NULL,
  related_id   TEXT,
  message      TEXT,
  raw_payload  TEXT,
  created_at   INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
) STRICT;

CREATE INDEX payment_logs_module_created_idx ON payment_logs (module, created_at DESC);
CREATE INDEX payment_logs_gateway_ref_idx ON payment_logs (gateway, gateway_ref) WHERE gateway_ref IS NOT NULL;
CREATE INDEX payment_logs_created_at_idx ON payment_logs (created_at);
