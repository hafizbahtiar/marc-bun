-- Pemilik: features/certificates (docs/modules/17-certificates.md)
--
-- Terbit = metadata + snapshot sahaja; PDF dijana semasa muat turun.
-- `r2_key` marc_go TIDAK dipindah: ia hanya dipakai oleh fasa-2 penerbitan
-- yang sudah jadi kod mati (fillPendingCertificateFiles).
-- Sijil ditarik balik kekal (revoked_at) - pengesahan awam mesti boleh
-- berkata "ditarik balik", bukan "tidak dijumpai".

CREATE TABLE certificate_templates (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  is_active       INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  primary_color   TEXT NOT NULL DEFAULT '#E21E28',
  secondary_color TEXT NOT NULL DEFAULT '#223145',
  logo_url        TEXT NOT NULL DEFAULT '/marc-logo-penuh.png',
  title           TEXT NOT NULL DEFAULT 'Sijil Penyertaan',
  subtitle        TEXT NOT NULL DEFAULT 'MARC',
  body_text       TEXT NOT NULL DEFAULT 'Diberikan kepada [Nama penerima] atas penyertaan dalam aktiviti MARC.',
  issuer_name     TEXT NOT NULL DEFAULT 'MARC',
  signature_name  TEXT NOT NULL DEFAULT 'Pengurusan MARC',
  footer_text     TEXT NOT NULL DEFAULT 'Sijil ini dijana secara rasmi oleh MARC.',
  updated_at      INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  created_at      INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
) STRICT;

-- Tepat satu templat aktif (lalai untuk penerbitan seterusnya).
CREATE UNIQUE INDEX certificate_templates_one_active_idx ON certificate_templates (is_active) WHERE is_active = 1;

INSERT INTO certificate_templates (id, name, is_active) VALUES
  ('00000000-0000-4000-8000-000000000101', 'Template MARC Standard', 1);

CREATE TABLE activity_certificates (
  id                       TEXT PRIMARY KEY,
  activity_id              TEXT NOT NULL REFERENCES activities (id) ON DELETE RESTRICT,
  user_id                  TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  serial                   TEXT NOT NULL UNIQUE,
  verify_token             TEXT NOT NULL UNIQUE,

  -- Snapshot: sijil tidak berubah bila aktiviti/profil/templat berubah kemudian.
  recipient_name           TEXT NOT NULL,
  activity_title           TEXT NOT NULL,
  category_name            TEXT NOT NULL DEFAULT '',
  activity_date            TEXT NOT NULL CHECK (activity_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  template_primary_color   TEXT NOT NULL DEFAULT '#E21E28',
  template_secondary_color TEXT NOT NULL DEFAULT '#223145',
  template_title           TEXT NOT NULL DEFAULT 'Sijil Penyertaan',
  template_subtitle        TEXT NOT NULL DEFAULT 'MARC',
  template_body_text       TEXT NOT NULL DEFAULT 'Diberikan kepada [Nama penerima] atas penyertaan dalam aktiviti MARC.',
  template_issuer_name     TEXT NOT NULL DEFAULT 'MARC',
  template_signature_name  TEXT NOT NULL DEFAULT 'Pengurusan MARC',
  template_footer_text     TEXT NOT NULL DEFAULT 'Sijil ini dijana secara rasmi oleh MARC.',

  issued_at                INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  revoked_at               INTEGER,
  revoked_reason           TEXT,
  UNIQUE (activity_id, user_id)
) STRICT;

CREATE INDEX activity_certificates_user_id_idx ON activity_certificates (user_id);
