-- castel: Materialisierter Bestand + Inventur-Sync-Fenster (Migration 0034).
--
-- `bestand` ist der serverseitig gepflegte, materialisierte Bestand je
-- (Artikel, Standort). Er wird vom Rebase-Endpunkt (`/api/inventur/rebase`)
-- und vom Sync-Resolver bei jeder gepushten Buchung auf den aktuellen
-- Journal-Stand gebracht. Die PWA bezieht den Bestand aus dieser Tabelle
-- statt über die Summe lokaler Buchungen — deshalb können alte Buchungen
-- aus dem Sync-Fenster (`inventur.sichtbarAb`) herausfallen, ohne dass
-- der Bestandswert auf den Clients verzerrt wird.
--
-- `inventur.sichtbarAb` (server-interner Einstellungs-Key) markiert den
-- Zeitpunkt ab dem Buchungen an Clients ausgeliefert werden. Ältere
-- Buchungen verbleiben serverseitig im Journal (Archiv-Endpunkt) und
-- werden nicht mehr in die IndexedDB der Clients ausgeliefert, damit
-- der lokale Datensatz nicht aufbläht.
--
-- Idempotenz: mehrfach ausführbar (ON CONFLICT DO NOTHING; Seed nur bei
-- fehlender Zeile).

CREATE TABLE IF NOT EXISTS bestand (
    artikel_id      TEXT NOT NULL REFERENCES artikel (id) ON DELETE CASCADE,
    standort_id     TEXT NOT NULL REFERENCES standorte (id) ON DELETE CASCADE,
    menge           INTEGER NOT NULL DEFAULT 0,
    geaendert_am    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (artikel_id, standort_id)
);

CREATE INDEX IF NOT EXISTS bestand_geaendert_am_idx ON bestand (geaendert_am);

-- Seed: aktueller Bestand je Paar aus dem nicht-stornierten Journal.
INSERT INTO bestand (artikel_id, standort_id, menge, geaendert_am)
    SELECT b.artikel_id, b.standort_id, COALESCE(SUM(b.menge), 0)::int, NOW()
    FROM buchungen b
    WHERE b.storno = FALSE
    GROUP BY b.artikel_id, b.standort_id
    ON CONFLICT (artikel_id, standort_id) DO NOTHING;

-- Audit-Log-Entität für den Rebase-Endpunkt ergänzen.
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_entitaet_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_entitaet_check
    CHECK (entitaet IN (
        'artikel', 'standort', 'buchung', 'kommission', 'foto', 'user',
        'einstellung', 'lieferant', 'hersteller', 'hersteller_artikel',
        'datanorm_import', 'artikel_standort_mindestbestand',
        'akku_netzteil', 'akku_projekt', 'akku_bestellung',
        'inventur_stichtag', 'inventur_position', 'bestand'
    ));

--> statement-breakpoint

-- Keine Daten-Migration nötig über den Seed hinaus.
