-- Pemilik: features/blocked-email-domains (docs/modules/06-blocked-email-domains.md)
--
-- Tambahan manual kepada senarai domain pelupusan terbenam. Domain disimpan
-- huruf kecil (dinormalkan app; CHECK menahan yang terlepas).

CREATE TABLE blocked_email_domains (
  domain     TEXT PRIMARY KEY CHECK (domain = lower(trim(domain)) AND length(domain) > 0),
  added_by   TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
) STRICT;
