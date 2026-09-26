-- Pemilik: features/notifications (docs/modules/13-notifications.md)
--
-- `type` senarai tertutup - jenis baharu = migrasi baharu + klien tahu cara
-- memaparkannya. Baris ditulis oleh consumer queue `notify`, bukan pengeluar.

CREATE TABLE notifications (
  id             TEXT PRIMARY KEY,
  recipient_id   TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  actor_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type           TEXT NOT NULL CHECK (type IN (
                   'post_like', 'post_comment', 'comment_like',
                   'member_pending', 'member_approved', 'member_rejected',
                   'activity_published', 'activity_cancelled', 'certificate_ready',
                   'activity_reminder')),
  post_id        TEXT REFERENCES posts (id) ON DELETE CASCADE,
  comment_id     TEXT REFERENCES comments (id) ON DELETE CASCADE,
  activity_id    TEXT REFERENCES activities (id) ON DELETE CASCADE,
  certificate_id TEXT REFERENCES activity_certificates (id) ON DELETE CASCADE,
  read_at        INTEGER,
  created_at     INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
) STRICT;

-- Keyset peti notifikasi: (created_at, id) setiap penerima.
CREATE INDEX notifications_recipient_id_created_at_idx ON notifications (recipient_id, created_at DESC, id DESC);

-- onesignal_id unik global: upsert oleh pengguna lain → 409 (halang rampasan push).
CREATE TABLE device_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  onesignal_id TEXT NOT NULL UNIQUE,
  platform     TEXT,
  created_at   INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at   INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
) STRICT;

CREATE INDEX device_tokens_user_id_idx ON device_tokens (user_id);
