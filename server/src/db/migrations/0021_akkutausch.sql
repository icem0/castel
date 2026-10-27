-- castel: Akkutausch — Netzteile und Projektakkus (Migration 0021).
--
-- Zwei neue Tabellen fuer das Akkutausch-Tool:
--
--   * akku_netzteile  — eingebaute Geraete, deren Akku in einem festen
--                       Intervall getauscht wird (Einbaudatum + Intervall).
--   * akku_projekte   — Projektbatterien, die fuer ein Quartal bestellt
--                       werden (Projekt, Menge, Art in Ah, Quartal, Jahr).
--
-- Beide Tabellen sind LWW-stuendig (geaendert_am) und werden ueber den
-- Snapshot-Endpoint inkrementell gespiegelt. `geloescht` ist ein
-- Soft-Delete: die Zeile bleibt erhalten, damit die Loeschung auch auf
-- anderen Geraeten ankommt (Tombstone). Die PWA filtert geloeschte Zeilen
-- aus der Anzeige heraus.
--
-- Die Akku-Groessen selbst liegen in der globalen Einstellung `akkuTypen`
-- (JSON) — sie brauchen keine eigene Tabelle. Der Mindestbestand der
-- Akku-Artikel liegt in `artikel_standort_mindestbestaende` (Migration 0020).

CREATE TABLE IF NOT EXISTS akku_netzteile (
    id                 TEXT PRIMARY KEY,
    anlage             TEXT NOT NULL,
    objekt             TEXT NOT NULL,
    name               TEXT NOT NULL,
    einbaudatum        DATE NOT NULL,
    intervall_jahre    INTEGER NOT NULL,
    kapazitaet_ah      NUMERIC(8, 2) NOT NULL,
    anzahl             INTEGER NOT NULL,
    gruppe             TEXT,
    plz                TEXT,
    vds_anerkennung    TEXT,
    bemerkung          TEXT,
    geloescht          BOOLEAN NOT NULL DEFAULT FALSE,
    geaendert_am       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    erstellt_am        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT akku_netzteile_intervall_check CHECK (intervall_jahre >= 1),
    CONSTRAINT akku_netzteile_kapazitaet_check CHECK (kapazitaet_ah > 0),
    CONSTRAINT akku_netzteile_anzahl_check CHECK (anzahl >= 1)
);

-- Snapshot-Endpoint filtert auf `geaendert_am > since` — Index ist Pflicht.
CREATE INDEX IF NOT EXISTS akku_netzteile_geaendert_am_idx
    ON akku_netzteile (geaendert_am);

CREATE TABLE IF NOT EXISTS akku_projekte (
    id                 TEXT PRIMARY KEY,
    projekt            TEXT NOT NULL,
    menge              INTEGER NOT NULL,
    art_ah             NUMERIC(8, 2) NOT NULL,
    quartal            INTEGER NOT NULL,
    jahr               INTEGER NOT NULL,
    geloescht          BOOLEAN NOT NULL DEFAULT FALSE,
    geaendert_am       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    erstellt_am        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT akku_projekte_menge_check CHECK (menge >= 1),
    CONSTRAINT akku_projekte_art_check CHECK (art_ah > 0),
    CONSTRAINT akku_projekte_quartal_check CHECK (quartal BETWEEN 1 AND 4),
    CONSTRAINT akku_projekte_jahr_check CHECK (jahr BETWEEN 2000 AND 2100)
);

-- Snapshot-Endpoint filtert auf `geaendert_am > since` — Index ist Pflicht.
CREATE INDEX IF NOT EXISTS akku_projekte_geaendert_am_idx
    ON akku_projekte (geaendert_am);
-- Die Planung filtert nach Quartal + Jahr.
CREATE INDEX IF NOT EXISTS akku_projekte_quartal_jahr_idx
    ON akku_projekte (jahr, quartal);

-- ---------- Audit-Log-Entitaet erweitern ----------
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_entitaet_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_entitaet_check
    CHECK (entitaet IN (
        'artikel', 'standort', 'buchung', 'kommission', 'foto', 'user',
        'einstellung', 'lieferant', 'hersteller', 'hersteller_artikel',
        'datanorm_import', 'artikel_standort_mindestbestand',
        'akku_netzteil', 'akku_projekt'
    ));
