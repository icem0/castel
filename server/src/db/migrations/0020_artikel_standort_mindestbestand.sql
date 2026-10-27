-- castel: Mindestbestand je Artikel UND Lager (Migration 0020).
--
-- Bisher war `artikel.mindestbestand` ein globaler Wert, der auf jedem
-- Standort gleichermassen galt. Ab jetzt gilt die Schwelle pro Paar
-- (Artikel, Standort). Die Tabelle ist bewusst sparse: eine Zeile
-- existiert nur, wenn fuer dieses Lager tatsaechlich ein Mindestbestand
-- konfiguriert ist. `mindestbestand <= 0` bedeutet "kein Alarm" (wird
-- vom Resolver und der PWA so ausgewertet).
--
-- Die alte Spalte `artikel.mindestbestand` bleibt vorerst bestehen
-- (Abwaertskompatibilitaet fuer aeltere Clients und die Agenten-API v1),
-- wird aber nicht mehr fuer den Trigger ausgewertet. Der Backfill unten
-- uebernimmt vorhandene globale Werte in das Hauptlager, damit beim
-- Upgrade kein Mindestbestand verloren geht.
--
-- Loeschregeln: `ON DELETE CASCADE` auf beide FKs. Ein geloeschter
-- Artikel/Standort nimmt seine Konfigurationen mit; das Loeschen wird
-- dadurch NICHT blockiert (Buchungen und Mindestbestand-Events tun das
-- weiterhin).

CREATE TABLE IF NOT EXISTS artikel_standort_mindestbestaende (
    artikel_id      TEXT NOT NULL REFERENCES artikel(id)   ON DELETE CASCADE,
    standort_id     TEXT NOT NULL REFERENCES standorte(id) ON DELETE CASCADE,
    mindestbestand  INTEGER NOT NULL DEFAULT 0,
    geaendert_am    TIMESTAMPTZ NOT NULL,
    erstellt_am     TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (artikel_id, standort_id)
);

-- Sync-Snapshot filtert auf `geaendert_am > since` — Index ist Pflicht.
CREATE INDEX IF NOT EXISTS artikel_standort_mindestbestaende_geaendert_am_idx
    ON artikel_standort_mindestbestaende (geaendert_am);

-- Backfill: der bisherige globale Wert wandert in das Hauptlager
-- (aktiver Standard-Standort). Das entspricht der Semantik "es gibt
-- immer ein Hauptlager". Der bestehende Server-Trigger wertete bereits
-- pro Standort aus, nur eben mit derselben Schwelle ueberall.
INSERT INTO artikel_standort_mindestbestaende
    (artikel_id, standort_id, mindestbestand, geaendert_am, erstellt_am)
SELECT a.id, s.id, a.mindestbestand, NOW(), NOW()
FROM artikel a
JOIN standorte s ON s.standard = TRUE AND s.archiviert = FALSE
WHERE a.mindestbestand IS NOT NULL
  AND a.mindestbestand > 0
ON CONFLICT (artikel_id, standort_id) DO NOTHING;

-- ---------- Audit-Log-Entitaet erweitern ----------
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_entitaet_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_entitaet_check
    CHECK (entitaet IN (
        'artikel', 'standort', 'buchung', 'kommission', 'foto', 'user',
        'einstellung', 'lieferant', 'hersteller', 'hersteller_artikel',
        'datanorm_import', 'artikel_standort_mindestbestand'
    ));
