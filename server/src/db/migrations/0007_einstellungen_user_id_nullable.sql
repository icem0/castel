-- castel: `einstellungen.user_id` auf NULL sicherstellen.
-- Migration 0007. Idempotent.
--
-- Frühere Schema-Versionen legten `einstellungen` mit einem Primärschlüssel
-- (key, user_id) an, wodurch user_id implizit NOT NULL war und globale
-- Einstellungen (user_id IS NULL) nicht speicherbar waren.
-- Diese Migration hebt den Primärschlüssel auf (falls noch vorhanden),
-- macht user_id explizit NULL und ersetzt den Primärschlüssel durch
-- Unique-Indizes, die NULL-Werte erlauben.
--
-- Auf frischen DBs (Migration 0005 ohne PK) ist alles bereits ein No-Op.

DO $$
BEGIN
    -- Alten Primärschlüssel entfernen (verbietet NULL in user_id).
    IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'einstellungen'::regclass
          AND contype = 'p'
    ) THEN
        ALTER TABLE einstellungen DROP CONSTRAINT einstellungen_pkey;
    END IF;

    -- user_id explizit NULL machen (no-op, falls bereits NULL).
    ALTER TABLE einstellungen ALTER COLUMN user_id DROP NOT NULL;
END $$;

-- Unique-Indizes sicherstellen (idempotent, auch wenn 0005 sie schon anlegte).
CREATE UNIQUE INDEX IF NOT EXISTS einstellungen_key_userid_idx
    ON einstellungen (key, user_id);
CREATE UNIQUE INDEX IF NOT EXISTS einstellungen_key_global_idx
    ON einstellungen (key)
    WHERE user_id IS NULL;
CREATE INDEX IF NOT EXISTS einstellungen_user_idx        ON einstellungen (user_id);
CREATE INDEX IF NOT EXISTS einstellungen_geaendert_am_idx ON einstellungen (geaendert_am);
