-- castel: Akkutausch — Storno der letzten Bestellung (Migration 0025).
--
-- Wird nach dem "Bestellt"-Vorgang ein Fehler entdeckt, kann die
-- Bestellung rueckgaengig gemacht werden. Die Zeile bleibt erhalten
-- (Historie) und wird mit `storno = true` markiert — analog zum
-- Soft-Delete der Netzteile und Projektakkus.
--
-- `storno_am` ist der Server-Zeitstempel. Der Snapshot-Filter zieht
-- Bestellungen, die nach `since` bestellt ODER storniert wurden — sonst
-- wuerde ein rueckgaengig gemachtes Quartal auf anderen Geraeten nie
-- wieder verschwinden.
--
-- `standort_id` merkt sich das Hauptlager zum Zeitpunkt der Bestellung:
-- der Puffer ("zur freien Verfuegung") liegt dort als Mindestbestand der
-- Akku-Artikel und wird beim Ruecknaehmen dorthin zurueckgeschrieben.

ALTER TABLE akku_bestellungen
    ADD COLUMN IF NOT EXISTS standort_id         TEXT,
    ADD COLUMN IF NOT EXISTS storno              BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS storno_am           TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS storno_von          TEXT,
    ADD COLUMN IF NOT EXISTS storno_von_kuerzel  TEXT;

CREATE INDEX IF NOT EXISTS akku_bestellungen_storno_am_idx
    ON akku_bestellungen (storno_am);
