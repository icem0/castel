-- castel: Inventur-Snapshots (Migration 0033).
--
-- Legt die Tabellen `inventur_stichtage` (Header: Stichtag, Status, wer hat
-- festgehalten) und `inventur_positionen` (einzelne Positionen des
-- eingefroren Bestands je Artikel/Standort) an.
--
-- Beide Tabellen sind append-only: ein abgeschlossener Stichtag wird nie
-- geaendert, sondern ggf. durch einen neuen Stichtag ersetzt. Der
-- Buchungs-Journal bleibt unangetastet.

CREATE TABLE IF NOT EXISTS inventur_stichtage (
    id                    TEXT PRIMARY KEY,
    stichtag              DATE NOT NULL,
    status                TEXT NOT NULL DEFAULT 'abgeschlossen',
    festgehalten_von      TEXT NOT NULL,
    festgehalten_von_name TEXT,
    erstellt_am           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS inventur_stichtage_stichtag_idx
    ON inventur_stichtage (stichtag);
CREATE INDEX IF NOT EXISTS inventur_stichtage_erstellt_am_idx
    ON inventur_stichtage (erstellt_am);

CREATE TABLE IF NOT EXISTS inventur_positionen (
    id                     TEXT PRIMARY KEY,
    stichtage_id           TEXT NOT NULL
        REFERENCES inventur_stichtage (id) ON DELETE CASCADE,
    artikel_id             TEXT NOT NULL
        REFERENCES artikel (id) ON DELETE CASCADE,
    standort_id            TEXT NOT NULL
        REFERENCES standorte (id) ON DELETE CASCADE,
    titel                  TEXT NOT NULL,
    typ                    TEXT NOT NULL DEFAULT '',
    verpackungseinheit     INTEGER NOT NULL DEFAULT 1,
    menge                  INTEGER NOT NULL,
    einkaufspreis_cent     INTEGER,
    listenpreis_cent       INTEGER,
    wert                   INTEGER NOT NULL DEFAULT 0,
    inventur_geprueft      BOOLEAN NOT NULL DEFAULT FALSE,
    negativer_bestand      BOOLEAN NOT NULL DEFAULT FALSE,
    erstellt_am            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS inventur_positionen_stichtage_id_idx
    ON inventur_positionen (stichtage_id);
CREATE INDEX IF NOT EXISTS inventur_positionen_artikel_id_idx
    ON inventur_positionen (artikel_id);
CREATE INDEX IF NOT EXISTS inventur_positionen_standort_id_idx
    ON inventur_positionen (standort_id);

-- ---------- Audit-Log-Entitaeten erweitern ----------
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_entitaet_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_entitaet_check
    CHECK (entitaet IN (
        'artikel', 'standort', 'buchung', 'kommission', 'foto', 'user',
        'einstellung', 'lieferant', 'hersteller', 'hersteller_artikel',
        'datanorm_import', 'artikel_standort_mindestbestand',
        'akku_netzteil', 'akku_projekt', 'akku_bestellung',
        'inventur_stichtag', 'inventur_position'
    ));

--> statement-breakpoint

-- Idempotent: keine Daten-Seedung noetig, die Tabellen starten leer.
