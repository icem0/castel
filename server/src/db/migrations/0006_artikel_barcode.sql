-- castel: Barcode-Feld auf `artikel`.
-- Migration 0006. Idempotent (ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS).
--
-- Hintergrund: Bisher wurde der gescannte Barcode ueber `bestellnummer`
-- abgebildet (Workaround). Das war fragil, weil:
--   1) `bestellnummer` ist die Lieferanten-Bestellnr. — semantisch ein
--      anderes Feld als der Strichcode am Artikel.
--   2) Beim Anlegen aus dem Scanner heraus wurde der Code nicht in
--      `bestellnummer` geschrieben (Form-View hatte kein Eingabefeld
--      dafuer), also fand der naechste Scan denselben Artikel nicht.
--
-- Loesung: eigenes `barcode`-Feld + Index fuer schnellen Scanner-Lookup.
-- Bestehende Datensaetze bekommen `barcode = NULL` (kein Default-Wert
-- sinnvoll, weil alte Eintraege keine Strichcodes haben).

ALTER TABLE artikel ADD COLUMN IF NOT EXISTS barcode TEXT;

CREATE INDEX IF NOT EXISTS artikel_barcode_idx ON artikel (barcode);
