-- Fixture dev SAHAJA (`bun run db:seed`, tiada --remote). Idempoten:
-- INSERT OR IGNORE dengan id tetap, jadi boleh dijalankan berulang kali.
-- Data rujukan produksi (roles, kategori, templat sijil) ialah MIGRASI, bukan di sini.
--
-- Diisi bersama skema dalam Fasa 1. Wrangler menolak fail tanpa statement.
SELECT 1;
