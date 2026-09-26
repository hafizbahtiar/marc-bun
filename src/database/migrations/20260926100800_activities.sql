-- Pemilik: features/activities (docs/modules/15-activities.md)
--
-- activity_sessions ialah sumber kebenaran masa; activities.starts_at/ends_at
-- ialah denormalisasi yang dikira semula setiap kali set sesi diganti (PUT).

CREATE TABLE activity_categories (
  id         TEXT PRIMARY KEY,
  key        TEXT NOT NULL UNIQUE CHECK (key <> '' AND key NOT GLOB '*[^a-z0-9_]*'),
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
) STRICT;

CREATE INDEX activity_categories_updated_at_idx ON activity_categories (updated_at);

-- Keadaan akhir seed marc_go (20260810100000 + 20260819120000). ID tetap
-- supaya seed boleh diulang; produksi ditindih oleh import data (00001 §6).
INSERT INTO activity_categories (id, key, name, sort_order, is_active) VALUES
  ('00000000-0000-4000-8000-000000000001', 'hiking', 'Hiking', 10, 1),
  ('00000000-0000-4000-8000-000000000002', 'brisk_walk', 'Brisk Walk', 20, 1),
  ('00000000-0000-4000-8000-000000000003', 'water_rafting', 'Water Rafting', 30, 1),
  ('00000000-0000-4000-8000-000000000004', 'camping', 'Camping', 40, 1),
  ('00000000-0000-4000-8000-000000000005', 'caving', 'Caving', 50, 1),
  ('00000000-0000-4000-8000-000000000006', 'atv', 'ATV', 60, 1),
  ('00000000-0000-4000-8000-000000000007', 'berbasikal', 'Berbasikal', 70, 1),
  ('00000000-0000-4000-8000-000000000008', 'csr', 'CSR', 80, 1),
  ('00000000-0000-4000-8000-000000000009', 'bola_sepak', 'Bola Sepak', 90, 1),
  ('00000000-0000-4000-8000-000000000010', 'badminton', 'Badminton', 100, 1),
  ('00000000-0000-4000-8000-000000000011', 'ping_pong', 'Ping Pong', 110, 1),
  ('00000000-0000-4000-8000-000000000012', 'dart', 'Dart', 120, 1),
  ('00000000-0000-4000-8000-000000000013', 'bola_tampar', 'Bola Tampar', 130, 1),
  ('00000000-0000-4000-8000-000000000014', 'bola_jaring', 'Bola Jaring', 140, 1),
  ('00000000-0000-4000-8000-000000000015', 'riadah', 'Riadah', 150, 1),
  ('00000000-0000-4000-8000-000000000016', 'lain_lain', 'Lain-lain', 160, 1),
  ('00000000-0000-4000-8000-000000000017', 'futsal', 'Futsal', 20, 0),
  ('00000000-0000-4000-8000-000000000018', 'larian', 'Larian', 40, 0);

CREATE TABLE activities (
  id                       TEXT PRIMARY KEY,
  category_id              TEXT NOT NULL REFERENCES activity_categories (id) ON DELETE RESTRICT,
  title                    TEXT NOT NULL,
  description              TEXT NOT NULL DEFAULT '',
  location_name            TEXT NOT NULL,
  location_address         TEXT NOT NULL DEFAULT '',
  starts_at                INTEGER NOT NULL,
  ends_at                  INTEGER NOT NULL,
  registration_opens_at    INTEGER,
  registration_closes_at   INTEGER NOT NULL,
  capacity                 INTEGER CHECK (capacity > 0),
  fee_cents                INTEGER NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  currency                 TEXT NOT NULL DEFAULT 'MYR',
  attendance_threshold_pct INTEGER NOT NULL DEFAULT 100 CHECK (attendance_threshold_pct BETWEEN 1 AND 100),
  status                   TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'cancelled', 'completed')),
  cancelled_reason         TEXT,
  certificates_issued_at   INTEGER,
  reminder_sent_at         INTEGER,
  created_by               TEXT REFERENCES users (id) ON DELETE SET NULL,
  deleted_at               INTEGER,
  updated_at               INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  created_at               INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
) STRICT;

CREATE INDEX activities_status_starts_at_idx ON activities (status, starts_at DESC);
CREATE INDEX activities_category_id_idx ON activities (category_id);

CREATE TABLE activity_sessions (
  id          TEXT PRIMARY KEY,
  activity_id TEXT NOT NULL REFERENCES activities (id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  starts_at   INTEGER NOT NULL,
  ends_at     INTEGER NOT NULL,
  CHECK (ends_at > starts_at),
  UNIQUE (activity_id, seq)
) STRICT;

CREATE INDEX activity_sessions_activity_id_starts_at_idx ON activity_sessions (activity_id, starts_at);
