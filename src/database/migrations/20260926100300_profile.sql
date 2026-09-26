-- Pemilik: features/profile (docs/modules/03-profile.md)
--
-- `profiles` disentuh banyak feature, tetapi HANYA features/profile/repo.ts
-- menulisnya (operasi bernama dieksport - docs/modules/README.md).

CREATE TABLE profiles (
  id                      TEXT PRIMARY KEY,
  user_id                 TEXT NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
  role_id                 INTEGER NOT NULL REFERENCES roles (id),

  -- Identiti keahlian. member_id NULL sehingga staff_id disahkan
  -- (MARC-{staff_id}/{tahun}-{kod}, modules/04-members.md).
  staff_id                TEXT NOT NULL UNIQUE,
  staff_id_verified_at    INTEGER,
  staff_id_verified_by    TEXT REFERENCES users (id) ON DELETE SET NULL,
  member_id               TEXT UNIQUE,

  display_name            TEXT,
  phone                   TEXT,
  avatar_r2_key           TEXT,
  email_verified          INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1)),

  -- Kelulusan (status) berasingan daripada keahlian aktif (is_active).
  status                  TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  approved_by             TEXT REFERENCES users (id) ON DELETE SET NULL,
  approved_at             INTEGER,
  is_active               INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),

  department_code         TEXT REFERENCES departments (code) ON DELETE SET NULL,
  position                TEXT,

  emergency_contact_name  TEXT,
  emergency_contact_phone TEXT,
  health_notes            TEXT,

  -- Telegram chat id ialah integer 64-bit; nilai sebenar < 2^53 (selamat
  -- sebagai Number JS) - disahkan semasa transformasi data.
  telegram_chat_id        INTEGER UNIQUE,
  telegram_username       TEXT,
  telegram_linked_at      INTEGER,

  -- Ban aktif = banned_at NOT NULL AND (ban_expires_at NULL OR > now).
  -- Dikuatkuasakan di edge melalui KV `ban:<userId>` (modules/08-bans.md).
  banned_at               INTEGER,
  ban_expires_at          INTEGER,
  ban_reason              TEXT,
  banned_by               TEXT REFERENCES users (id) ON DELETE SET NULL,

  -- Token CAS kunci optimistik (modules/00-shared.md).
  updated_at              INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  created_at              INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),

  CHECK (ban_expires_at IS NULL OR banned_at IS NOT NULL)
) STRICT;

CREATE INDEX profiles_role_id_idx ON profiles (role_id);
CREATE INDEX profiles_status_idx ON profiles (status);
CREATE INDEX profiles_department_code_idx ON profiles (department_code);
CREATE INDEX profiles_updated_at_idx ON profiles (updated_at);
CREATE INDEX profiles_active_ban_idx ON profiles (ban_expires_at) WHERE banned_at IS NOT NULL;

-- Maks 3 setiap ahli (dikuatkuasakan dalam INSERT … SELECT … WHERE count < 3);
-- tepat satu default (indeks unik separa di bawah).
CREATE TABLE member_addresses (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  label        TEXT,
  is_default   INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  address_type TEXT NOT NULL CHECK (address_type IN ('landed', 'highrise')),
  unit_number  TEXT,
  floor        TEXT,
  block        TEXT,
  street       TEXT,
  township     TEXT,
  city         TEXT NOT NULL,
  postcode     TEXT NOT NULL,
  state        TEXT NOT NULL,
  created_at   INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at   INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
) STRICT;

CREATE INDEX member_addresses_user_id_idx ON member_addresses (user_id);
CREATE UNIQUE INDEX member_addresses_one_default_per_user ON member_addresses (user_id) WHERE is_default = 1;

-- Permintaan ahli sahaja (keperluan Google Play); pelaksanaan oleh
-- features/account-lifecycle. Satu baris setiap ahli (idempoten).
CREATE TABLE account_deletion_requests (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
  requested_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  completed_at INTEGER
) STRICT;
