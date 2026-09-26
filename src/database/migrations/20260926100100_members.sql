-- Pemilik: features/members (docs/modules/04-members.md)
--
-- roles.id kekal INTEGER (marc_go: smallint identity) - profiles.role_id
-- merujuknya. ID seed ditetapkan eksplisit supaya sama dengan produksi
-- marc_go (1-4 dari seed asal, 5-6 dari seed_admin_tester_roles); skrip
-- transformasi data mengesahkannya sebelum import (00001 §6).

CREATE TABLE roles (
  id         INTEGER PRIMARY KEY,
  key        TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  category   TEXT NOT NULL CHECK (category IN ('management', 'ahli')),
  rank       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
) STRICT;

INSERT INTO roles (id, key, name, category, rank) VALUES
  (1, 'ahli', 'Ahli', 'ahli', 10),
  (2, 'supervisor', 'Supervisor', 'management', 50),
  (3, 'manager', 'Manager', 'management', 60),
  (4, 'superadmin', 'Super Admin', 'management', 100),
  (5, 'tester', 'Tester', 'ahli', 5),
  (6, 'admin', 'Admin', 'management', 80);

-- Pembilang atomik: INSERT … ON CONFLICT DO UPDATE … RETURNING (member_id,
-- siri sijil). Kunci marc_go: 'member_seq:ahli', 'member_seq:tester',
-- 'certificate_serial' - mesti sama supaya nilai import bersambung.
CREATE TABLE sequences (
  key           TEXT PRIMARY KEY,
  current_value INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
) STRICT;
