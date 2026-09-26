-- Pemilik: features/uploads (docs/modules/11-uploads.md)
--
-- pending_uploads: kunci yang sudah ditandatangani tetapi belum dilampir.
--   Tua > 6 jam → reaper menggilirnya ke deleted_uploads.
-- deleted_uploads: gilir padam R2 dengan retry. Reaper ialah SATU-SATUNYA
--   kod yang memadam objek R2.

CREATE TABLE pending_uploads (
  r2_key     TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
) STRICT;

CREATE INDEX pending_uploads_user_id_idx ON pending_uploads (user_id);
CREATE INDEX pending_uploads_created_at_idx ON pending_uploads (created_at);

CREATE TABLE deleted_uploads (
  r2_key          TEXT PRIMARY KEY,
  reason          TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  deleted_at      INTEGER,
  next_attempt_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  created_at      INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
) STRICT;

CREATE INDEX deleted_uploads_pending_idx ON deleted_uploads (next_attempt_at) WHERE deleted_at IS NULL;
