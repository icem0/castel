-- castel: audit_log.entitaet CHECK um 'kommission' erweitern (Migration 0010).
-- Idempotent: Constraint wird geloescht und neu erstellt.

ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_entitaet_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_entitaet_check
    CHECK (entitaet IN ('artikel', 'standort', 'buchung', 'projekt', 'kommission', 'foto', 'user', 'einstellung'));
