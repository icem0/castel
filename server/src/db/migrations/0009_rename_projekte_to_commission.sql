-- castel: Tabelle `projekte` nach `commission` umbenennen (Migration 0009).
-- Idempotent: Lauf nur, wenn die alte Tabelle noch existiert.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'projekte'
  ) THEN
    ALTER TABLE projekte RENAME TO commission;
  END IF;
END $$;

ALTER INDEX IF EXISTS projekte_nummer_idx RENAME TO commission_nummer_idx;
ALTER INDEX IF EXISTS projekte_archiviert_idx RENAME TO commission_archiviert_idx;
ALTER INDEX IF EXISTS projekte_geaendert_am_idx RENAME TO commission_geaendert_am_idx;
