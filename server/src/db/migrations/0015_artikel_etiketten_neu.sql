-- castel: Flag `etiketten_neu` auf `artikel`.
-- Migration 0015. Idempotent (ADD COLUMN IF NOT EXISTS).
--
-- Hintergrund: Der Etiketten-Druck (DIN-A4-Bogen) braucht eine Merkliste
-- fuer "Artikel, die noch kein Etikett bekommen haben". Das Merkmal ist
-- ein reines Stammdaten-Flag am Artikel — es gehoert nicht in die
-- Einstellungen (das waere ein Datensatz pro Artikel in einem
-- Key/Value-Speicher) und nicht in die Buchungen (Artikel sind keine
-- Bewegungen).
--
-- Semantik:
--   * `etiketten_neu = TRUE`  → Artikel ist als "neu" markiert
--   * `etiketten_neu = FALSE` → Marker entfernt (z. B. nach dem Druck
--                               oder per "Alle Tags loeschen")
--
-- Der DEFAULT TRUE setzt den Marker fuer alle bestehenden Artikel: die
-- Migration laeuft genau einmal, danach markiert der Client neue Artikel
-- automatisch (Store `anlegen()`) und der Admin kann die Marker per
-- Button setzen/loeschen. So existiert nach dem Update eine vollstaendige
-- Etikettenliste, die einmal gedruckt und dann abgearbeitet werden kann.
--
-- LWW: Das Flag reist ueber den regulaeren Sync-Payload (Outbox → Push →
-- Snapshot → Pull). Es wird im selben `geaendert_am`-Zeitstempel-Fenster
-- aktualisiert wie der Rest der Artikelzeile.

ALTER TABLE artikel
  ADD COLUMN IF NOT EXISTS etiketten_neu BOOLEAN NOT NULL DEFAULT TRUE;
