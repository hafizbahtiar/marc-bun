-- Pemilik: features/registrations (docs/modules/16-registrations.md)
--
-- Kapasiti dikuatkuasakan oleh SATU statement INSERT … SELECT … WHERE count
-- < capacity (R1) - tiada kunci baris di D1. Indeks unik separa menolak
-- pendaftaran berganda tetapi membenarkan daftar semula selepas batal.
-- Lajur bayaran (payment_status, payment_ref, fee_cents_paid) ditulis oleh
-- features/payments melalui fungsi eksport registrations.

CREATE TABLE activity_registrations (
  id             TEXT PRIMARY KEY,
  activity_id    TEXT NOT NULL REFERENCES activities (id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'registered' CHECK (status IN ('pending_payment', 'registered', 'cancelled')),
  payment_status TEXT NOT NULL DEFAULT 'not_required' CHECK (payment_status IN ('not_required', 'pending', 'paid', 'refunded')),
  payment_ref    TEXT,
  fee_cents_paid INTEGER CHECK (fee_cents_paid >= 0),
  checkin_token  TEXT NOT NULL UNIQUE,
  registered_at  INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  cancelled_at   INTEGER
) STRICT;

CREATE UNIQUE INDEX activity_registrations_active_uniq ON activity_registrations (activity_id, user_id) WHERE status <> 'cancelled';
CREATE INDEX activity_registrations_activity_status_idx ON activity_registrations (activity_id, status);
CREATE INDEX activity_registrations_user_id_idx ON activity_registrations (user_id);
CREATE INDEX activity_registrations_payment_ref_idx ON activity_registrations (payment_ref) WHERE payment_ref IS NOT NULL;

-- `code` wujud dalam CHECK (pariti skema) tetapi ditolak oleh app - tiada
-- klien menghasilkannya.
CREATE TABLE activity_attendances (
  id              TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL REFERENCES activity_registrations (id) ON DELETE CASCADE,
  session_id      TEXT NOT NULL REFERENCES activity_sessions (id) ON DELETE CASCADE,
  method          TEXT NOT NULL CHECK (method IN ('manual', 'scan', 'self_scan', 'code')),
  marked_by       TEXT REFERENCES users (id) ON DELETE SET NULL,
  checked_in_at   INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (registration_id, session_id)
) STRICT;

CREATE INDEX activity_attendances_session_id_idx ON activity_attendances (session_id);
