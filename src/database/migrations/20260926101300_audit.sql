-- Pemilik: features/audit (docs/modules/09-audit.md). Ditulis oleh semua
-- feature melalui shared/audit.ts, dalam db.batch() yang sama dengan mutasi.
--
-- Append-only. Satu-satunya UPDATE yang dibenarkan (pariti marc_go
-- 20260809210000): mengosongkan actor_id (FK ON DELETE SET NULL semasa ahli
-- dipadam), ip_address dan user_agent (redaksi PII oleh retention).
-- DELETE dibenarkan - hanya job retention memadam (umur rekod).
-- Perbandingan guna IS NOT supaya NULL = NULL.

CREATE TABLE audit_logs (
  id              INTEGER PRIMARY KEY,
  entity_type     TEXT NOT NULL,
  entity_id       TEXT NOT NULL,
  action          TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
  actor_id        TEXT REFERENCES users (id) ON DELETE SET NULL,
  actor_member_id TEXT,
  actor_role_key  TEXT,
  changed_fields  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(changed_fields) AND json_type(changed_fields) = 'array'),
  old_values      TEXT CHECK (old_values IS NULL OR json_valid(old_values)),
  new_values      TEXT CHECK (new_values IS NULL OR json_valid(new_values)),
  ip_address      TEXT,
  user_agent      TEXT,
  created_at      INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
) STRICT;

CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id, id DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_id, id DESC) WHERE actor_id IS NOT NULL;
CREATE INDEX audit_logs_created_at_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_pii_idx ON audit_logs (created_at) WHERE ip_address IS NOT NULL OR user_agent IS NOT NULL;

CREATE TRIGGER audit_logs_append_only
BEFORE UPDATE ON audit_logs
WHEN NEW.id IS NOT OLD.id
  OR NEW.entity_type IS NOT OLD.entity_type
  OR NEW.entity_id IS NOT OLD.entity_id
  OR NEW.action IS NOT OLD.action
  OR NEW.actor_member_id IS NOT OLD.actor_member_id
  OR NEW.actor_role_key IS NOT OLD.actor_role_key
  OR NEW.changed_fields IS NOT OLD.changed_fields
  OR NEW.old_values IS NOT OLD.old_values
  OR NEW.new_values IS NOT OLD.new_values
  OR NEW.created_at IS NOT OLD.created_at
  OR (NEW.actor_id IS NOT OLD.actor_id AND NEW.actor_id IS NOT NULL)
  OR (NEW.ip_address IS NOT OLD.ip_address AND NEW.ip_address IS NOT NULL)
  OR (NEW.user_agent IS NOT OLD.user_agent AND NEW.user_agent IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'audit_logs append-only: hanya pengosongan actor_id/ip_address/user_agent dibenarkan');
END;
