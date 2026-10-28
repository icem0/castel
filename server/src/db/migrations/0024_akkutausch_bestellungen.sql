-- castel: Akkutausch — archivierte Bestellungen (Migration 0024).
--
-- Each "als bestellt markiert" action freezes the current planning table
-- (Groesse, Soll, Bestand, Reserve, Verfuegbar, Bedarf) together with the
-- inventory cut-off and the initials of the person who triggered it.
--
-- Append-only: a row is never edited or deleted. A repeated order for the
-- same quarter creates a new snapshot, so the archive keeps the history.
-- `bestellt_am` is assigned by the server; the incremental snapshot query
-- filters on it, therefore the index is mandatory.

CREATE TABLE IF NOT EXISTS akku_bestellungen (
    id                     TEXT PRIMARY KEY,
    jahr                   INTEGER NOT NULL,
    quartal                INTEGER NOT NULL,
    bestellt_am            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    bestellt_von           TEXT NOT NULL,
    bestellt_von_kuerzel   TEXT NOT NULL,
    inventur_datum         DATE,
    inventur_von_kuerzel   TEXT,
    zeilen                 JSONB NOT NULL,
    CONSTRAINT akku_bestellungen_quartal_check CHECK (quartal BETWEEN 1 AND 4),
    CONSTRAINT akku_bestellungen_jahr_check CHECK (jahr BETWEEN 2000 AND 2100)
);

CREATE INDEX IF NOT EXISTS akku_bestellungen_bestellt_am_idx
    ON akku_bestellungen (bestellt_am);
CREATE INDEX IF NOT EXISTS akku_bestellungen_quartal_jahr_idx
    ON akku_bestellungen (jahr, quartal);

-- ---------- Audit-Log-Entitaet erweitern ----------
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_entitaet_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_entitaet_check
    CHECK (entitaet IN (
        'artikel', 'standort', 'buchung', 'kommission', 'foto', 'user',
        'einstellung', 'lieferant', 'hersteller', 'hersteller_artikel',
        'datanorm_import', 'artikel_standort_mindestbestand',
        'akku_netzteil', 'akku_projekt', 'akku_bestellung'
    ));
