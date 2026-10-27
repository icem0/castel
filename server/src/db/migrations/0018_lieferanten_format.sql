-- castel: DATANORM-Format am Lieferanten speichern (Migration 0018).
--
-- Das Format eines Lieferanten-Exports (DATANORM 4 oder 5) ist eine
-- Eigenschaft des Lieferanten und ändert sich nicht von Upload zu Upload.
-- Bisher musste der Admin das Format bei jedem Upload neu waehlen bzw. die
-- Auto-Erkennung nutzen. Mit dieser Spalte wird die Einstellung am
-- Lieferanten gespeichert und beim naechsten Upload vorgeschlagen.
--
-- 'auto' = erkennen (Vorgabe). 'v4'/'v5' = fest vorgegeben.

ALTER TABLE lieferanten
    ADD COLUMN IF NOT EXISTS format TEXT NOT NULL DEFAULT 'auto';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'lieferanten_format_check'
    ) THEN
        ALTER TABLE lieferanten
            ADD CONSTRAINT lieferanten_format_check
            CHECK (format IN ('auto', 'v4', 'v5'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS lieferanten_format_idx
    ON lieferanten (format);

-- ---------- Parser-Version an der hochgeladenen Datei ----------
--
-- Die Datei-Merkzahl allein erkennt Duplikate. Nach einer Korrektur des
-- Parsers ist dieselbe Datei aber KEIN Duplikat mehr — sonst wuerde der
-- erneute Upload still uebersprungen und die kaputten Katalogzeilen
-- blieben stehen. Deshalb wird die Parser-Version mitgespeichert und beim
-- Duplikatsvergleich beruecksichtigt.
--
-- 1 = erste Implementierung (feste Spaltenbreiten — fuer keine echte
--     Lieferantendatei richtig)
-- 2 = semikolongetrennte Felder gemaess DATANORM-Spezifikation

ALTER TABLE datanorm_dateien
    ADD COLUMN IF NOT EXISTS parser_version INTEGER NOT NULL DEFAULT 1;
