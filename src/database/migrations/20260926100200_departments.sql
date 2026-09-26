-- Pemilik: features/departments (docs/modules/05-departments.md)
--
-- `code` ialah kunci URL (/admin/departments/:code) - tidak boleh ada '/'.
-- Seed = senarai asal marc_go; produksi akan ditindih oleh import data.

CREATE TABLE departments (
  code       TEXT PRIMARY KEY CHECK (instr(code, '/') = 0 AND length(trim(code)) > 0),
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  added_by   TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
) STRICT;

INSERT INTO departments (code, name, sort_order) VALUES
  ('PEJ. SU-KPE', 'PEJABAT SETIAUSAHA / KETUA PEGAWAI EKSEKUTIF', 10),
  ('BKP', 'BAHAGIAN KHIDMAT PENGURUSAN', 20),
  ('BPI', 'BAHAGIAN PEMBANGUNAN INSAN', 30),
  ('MCL', 'MAIWP CAWANGAN LABUAN', 40),
  ('BPPH', 'BAHAGIAN PEMBANGUNAN DAN PELABURAN HARTANAH', 50),
  ('BAZ', 'BAHAGIAN AGIHAN ZAKAT', 60),
  ('UUU', 'UNIT UNDANG-UNDANG', 70),
  ('BWP', 'BAHAGIAN KEWANGAN DAN PELABURAN', 80),
  ('BPA', 'BAHAGIAN PEMBANGUNAN ASNAF', 90),
  ('UAD', 'UNIT AUDIT DALAM', 100),
  ('BPSM', 'BAHAGIAN PEMBANGUNAN SUMBER MANUSIA', 110),
  ('PEJ. TKPEP', 'PEJABAT TIMBALAN KETUA PEGAWAI EKSEKUTIF PENGURUSAN', 120),
  ('IKB', 'INSTITUT KEMAHIRAN BAITULMAL', 130),
  ('UKK', 'UNIT KOMUNIKASI KORPORAT', 140),
  ('UIP', 'UNIT INTEGRITI DAN PEMATUHAN', 150),
  ('BWA', 'BAHAGIAN WAKAF DAN SUMBER AM', 160),
  ('PEJ. TKPEO', 'PEJABAT TIMBALAN KETUA EKSEKUTIF OPERASI', 170);
