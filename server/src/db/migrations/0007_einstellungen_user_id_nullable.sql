-- castel: `einstellungen.user_id` auf NULL zuruecknehmen.
-- Migration 0007. Idempotent (information_schema-Pruefung statt DO $$ ... $$).
--
-- Hintergrund: Die produktive DB wurde in einer fruehen Phase mit einer
-- Schema-Version angelegt, in der `user_id` als NOT NULL definiert war.
-- Seit Migration 0005 ist die Spalte NULL, weil dort auch globale Settings
-- (artikelTypen, kommissionen, companyName) liegen, die keinem konkreten
-- User gehoeren. `CREATE TABLE IF NOT EXISTS` (in 0005) hat die alte
-- Spaltendefinition nicht angefasst — die DB hat den Drift behalten.
--
-- Folge: jeder Push eines globalen Settings-Eintrags knallte mit
-- `null value in column "user_id" of relation "einstellungen" violates
-- not-null constraint`. Diese Migration entfernt den Constraint, falls
-- er noch existiert. Wenn er nie gesetzt war, ist die Pruefung no-op.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name   = 'einstellungen'
          AND column_name  = 'user_id'
          AND is_nullable  = 'NO'
    ) THEN
        ALTER TABLE einstellungen ALTER COLUMN user_id DROP NOT NULL;
    END IF;
END $$;