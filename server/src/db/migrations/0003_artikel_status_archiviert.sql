-- castel: Artikel-Archivierung wandert vom `archiviert`-Flag in den Status.
-- Migration 0003. Idempotent.
--
-- Hintergrund: Beim ersten Lauf wurde der CHECK-Constraint anonym (auto-name)
-- angelegt; das in der DB stehende Objekt heißt dann z. B. "artikel_status_check"
-- (oder ein ähnlich generierter Name). Beim Re-Run darf das ADD CONSTRAINT
-- nicht failen — wir droppen vorher JEDEN status-Check, der entweder
--  - den festen Namen "artikel_status_check" trägt ODER
--  - per LIKE-Match auf "CHECK (status IN (%..." identifizierbar ist.
--
-- 1) Bestehende `archiviert=true`-Datensätze bekommen `status='archiviert'`,
--    damit beim späteren Drop der Spalte keine Information verloren geht.
-- 2) Bestehende CHECK-Constraints auf `artikel.status` droppen.
-- 3) Neuen CHECK-Constraint anlegen (Name fest: artikel_status_check).
-- 4) Index `artikel_archiviert_idx` und Spalte `archiviert` entfernen.

UPDATE artikel SET status = 'archiviert' WHERE archiviert = TRUE;

DO $$
DECLARE
    c_name text;
BEGIN
    -- 1) Fest benannten Constraint droppen, falls vorhanden.
    SELECT conname INTO c_name
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'artikel'
      AND con.conname = 'artikel_status_check'
      AND con.contype = 'c';
    IF c_name IS NOT NULL THEN
        EXECUTE 'ALTER TABLE artikel DROP CONSTRAINT artikel_status_check';
    END IF;

    -- 2) Anonyme/anders benannte CHECK-Constraints auf `status` droppen.
    FOR c_name IN
        SELECT con.conname
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        WHERE rel.relname = 'artikel'
          AND con.contype = 'c'
          AND pg_get_constraintdef(con.oid) LIKE 'CHECK (status IN (%'
    LOOP
        EXECUTE format('ALTER TABLE artikel DROP CONSTRAINT %I', c_name);
    END LOOP;
END
$$;

-- Falls der Constraint noch aus einem früheren Lauf existieren sollte
-- (race/teilweise angewendet), erneut versuchen — IF EXISTS ist hier nicht
-- direkt unterstützt, daher der DO-Block oben als Vorbereitung.
ALTER TABLE artikel
    ADD CONSTRAINT artikel_status_check
    CHECK (status IN ('verfuegbar', 'reserviert', 'gesperrt', 'ausgesondert', 'archiviert'));

DROP INDEX IF EXISTS artikel_archiviert_idx;
ALTER TABLE artikel DROP COLUMN IF EXISTS archiviert;