-- Pemilik: features/auth (docs/modules/01-auth.md)
--
-- Konvensyen SEMUA migrasi (docs/00000-foundation.md §8):
--   - STRICT: D1 menolak jenis salah (cth rentetan ISO dalam lajur masa INTEGER).
--   - id = TEXT UUID v4 dijana di app (crypto.randomUUID), tiada default SQL.
--   - masa = INTEGER unix ms UTC. Default `now` hanya jaring keselamatan;
--     perbandingan masa sentiasa dihantar sebagai parameter dari app.
--   - boolean = INTEGER 0/1 dengan CHECK.
--   - Wang = INTEGER sen.
-- Sumber: marc_go internal/db/migrations (keadaan akhir, bukan ulang sejarah).

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
) STRICT;

-- Pariti marc_go: unik tanpa kira huruf (app juga menurunkan huruf).
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));

-- Refresh legap, disimpan SHA-256. family_id = satu sesi peranti (`sid` JWT);
-- consumed_* untuk rotasi sekali-guna + pengesanan reuse (modules/01-auth.md).
CREATE TABLE refresh_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  family_id   TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER,
  consumed_ip TEXT,
  user_agent  TEXT,
  created_ip  TEXT,
  created_at  INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
) STRICT;

CREATE INDEX refresh_tokens_user_id_idx ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_family_id_idx ON refresh_tokens (family_id);

CREATE TABLE email_verification_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
) STRICT;

CREATE INDEX email_verification_tokens_user_id_idx ON email_verification_tokens (user_id);

-- Had per akaun: 60 s antara hantar + 5 setiap 24 jam.
CREATE TABLE email_verification_sends (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
) STRICT;

CREATE INDEX email_verification_sends_user_created_idx ON email_verification_sends (user_id, created_at DESC);

CREATE TABLE password_reset_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
) STRICT;

CREATE INDEX password_reset_tokens_user_id_idx ON password_reset_tokens (user_id);
