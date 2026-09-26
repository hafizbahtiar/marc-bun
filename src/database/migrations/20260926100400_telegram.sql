-- Pemilik: features/telegram (docs/modules/02-telegram.md)
--
-- Token deep-link legap (SHA-256), TTL 10 minit, sekali-guna
-- (DELETE … RETURNING). Lajur binding ada pada `profiles`.

CREATE TABLE telegram_link_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
) STRICT;

CREATE INDEX telegram_link_tokens_user_id_idx ON telegram_link_tokens (user_id);
