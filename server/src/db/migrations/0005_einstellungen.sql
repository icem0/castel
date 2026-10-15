-- castel: Einstellungen (Cross-Device-Sync).
-- Migration 0005. Idempotent (CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS).
--
-- Hintergrund: PWA-Einstellungen (sprache, standardStandortId, artikelTypen)
-- wurden bisher rein lokal in IndexedDB pro Browser gehalten. Mit dieser
-- Tabelle werden sie geräteübergreifend synchronisiert:
--   - user_id IS NULL  → global (z. B. artikelTypen, vom Admin gepflegt)
--   - user_id = <id>   → pro User (z. B. sprache, standardStandortId)
--
-- PK ist (key, user_id) damit jede Variante eindeutig ist. Last-Writer-Wins
-- auf geaendert_am.

CREATE TABLE IF NOT EXISTS einstellungen (
    key           TEXT NOT NULL,
    user_id       TEXT NULL REFERENCES users(id) ON DELETE CASCADE,
    value         TEXT NOT NULL,
    geaendert_am  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (key, user_id)
);
CREATE INDEX IF NOT EXISTS einstellungen_user_idx        ON einstellungen (user_id);
CREATE INDEX IF NOT EXISTS einstellungen_geaendert_am_idx ON einstellungen (geaendert_am);

-- audit_log.entitaet-Constraint um 'einstellung' erweitern.
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_entitaet_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_entitaet_check
    CHECK (entitaet IN ('artikel', 'standort', 'buchung', 'projekt', 'foto', 'user', 'einstellung'));
