-- Pemilik: features/posts (docs/modules/12-posts.md)
--
-- Padam lembut (deleted_at) untuk post & komen. Komen bersarang maks 2 tahap
-- (dikuatkuasakan app - balasan tahap 2 dilekatkan ke induk tahap 1).
-- Like = kunci komposit → like kali kedua ialah ON CONFLICT DO NOTHING,
-- jadi tiada notifikasi berulang.

CREATE TABLE posts (
  id         TEXT PRIMARY KEY,
  author_id  TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type       TEXT NOT NULL DEFAULT 'normal' CHECK (type IN ('normal', 'announcement')),
  content    TEXT NOT NULL,
  edited_at  INTEGER,
  deleted_at INTEGER,
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
) STRICT;

-- Keyset suapan: (created_at, id).
CREATE INDEX posts_created_at_idx ON posts (created_at DESC, id DESC);
CREATE INDEX posts_author_id_idx ON posts (author_id);
CREATE INDEX posts_updated_at_idx ON posts (updated_at);

CREATE TABLE post_images (
  id       TEXT PRIMARY KEY,
  post_id  TEXT NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  r2_key   TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 3)
) STRICT;

CREATE INDEX post_images_post_id_idx ON post_images (post_id);
CREATE INDEX post_images_r2_key_idx ON post_images (r2_key);

CREATE TABLE post_likes (
  post_id    TEXT NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  PRIMARY KEY (post_id, user_id)
) STRICT;

CREATE TABLE comments (
  id                TEXT PRIMARY KEY,
  post_id           TEXT NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  parent_comment_id TEXT REFERENCES comments (id) ON DELETE CASCADE,
  author_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  content           TEXT NOT NULL,
  edited_at         INTEGER,
  deleted_at        INTEGER,
  updated_at        INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  created_at        INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
) STRICT;

CREATE INDEX comments_post_id_idx ON comments (post_id);
CREATE INDEX comments_parent_comment_id_idx ON comments (parent_comment_id);
CREATE INDEX comments_updated_at_idx ON comments (updated_at);

CREATE TABLE comment_likes (
  comment_id TEXT NOT NULL REFERENCES comments (id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  PRIMARY KEY (comment_id, user_id)
) STRICT;
