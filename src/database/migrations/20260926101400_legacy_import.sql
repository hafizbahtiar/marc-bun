-- Pemilik: features/legacy-import (docs/modules/10-legacy-import.md)
--
-- Staging eksport ahli MARC 2026. conflicts/warnings sentiasa array JSON
-- (tidak pernah null - marc_go pernah menyimpan `null` dan terpaksa
-- menormalkan semasa baca; CHECK di sini menutup kelas pepijat itu).

CREATE TABLE legacy_member_import_batches (
  id              TEXT PRIMARY KEY,
  source_filename TEXT NOT NULL,
  source_sha256   TEXT NOT NULL,
  created_by      TEXT REFERENCES users (id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'dry_run' CHECK (status IN ('dry_run', 'ready', 'imported', 'failed')),
  total_rows      INTEGER NOT NULL DEFAULT 0,
  valid_rows      INTEGER NOT NULL DEFAULT 0,
  conflict_rows   INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
) STRICT;

CREATE INDEX legacy_member_import_batches_created_idx ON legacy_member_import_batches (created_at DESC);

CREATE TABLE legacy_member_import_rows (
  id              TEXT PRIMARY KEY,
  batch_id        TEXT NOT NULL REFERENCES legacy_member_import_batches (id) ON DELETE CASCADE,
  source_row      INTEGER NOT NULL,
  legacy_number   TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'conflict' CHECK (status IN ('valid', 'conflict', 'imported', 'claimed')),
  legacy_staff_id TEXT NOT NULL DEFAULT '',
  member_id       TEXT NOT NULL DEFAULT '',
  display_name    TEXT NOT NULL DEFAULT '',
  email           TEXT NOT NULL DEFAULT '',
  phone           TEXT NOT NULL DEFAULT '',
  department_code TEXT NOT NULL DEFAULT '',
  position        TEXT NOT NULL DEFAULT '',
  emergency_name  TEXT NOT NULL DEFAULT '',
  emergency_phone TEXT NOT NULL DEFAULT '',
  health_notes    TEXT NOT NULL DEFAULT '',
  address         TEXT NOT NULL DEFAULT '',
  category        TEXT NOT NULL DEFAULT '',
  club_position   TEXT NOT NULL DEFAULT '',
  legacy_status   TEXT NOT NULL DEFAULT '',
  conflicts       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(conflicts) AND json_type(conflicts) = 'array'),
  warnings        TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(warnings) AND json_type(warnings) = 'array'),
  user_id         TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  UNIQUE (batch_id, source_row)
) STRICT;

CREATE INDEX legacy_member_import_rows_email_idx ON legacy_member_import_rows (lower(email));
CREATE INDEX legacy_member_import_rows_staff_id_idx ON legacy_member_import_rows (legacy_staff_id);

CREATE TABLE legacy_member_claim_tokens (
  id          TEXT PRIMARY KEY,
  row_id      TEXT NOT NULL UNIQUE REFERENCES legacy_member_import_rows (id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at  INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
) STRICT;

CREATE INDEX legacy_member_claim_tokens_expiry_idx ON legacy_member_claim_tokens (expires_at) WHERE consumed_at IS NULL;
