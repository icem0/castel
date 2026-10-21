-- castel: Hersteller-Katalog via DATANORM (Migration 0013).
--
-- DATANORM ist das de-facto-Standardformat fuer Artikelstammdaten im
-- deutschen Fachgrosshandel (SHK, Elektro, Maler). Die Dateien sind ein
-- Legacy-Format: Satzzeichen am Zeilenanfang, unterschiedliche Feldlayouts
-- je Satzart und Version, CP850-Encoding in v4.
--
-- Architektur-Intention (bewusste Entkopplung):
--   * `hersteller_artikel` ist eine reine DATANORM-Spiegelung. Sie hat
--     KEINEN Foreign Key auf `artikel`. Die castel-Artikel bleiben die
--     fuehrende Entitaet, der Hersteller-Katalog ist eine Quelle, aus der
--     der User beim Anlegen/Bearbeiten Felder uebernimmt.
--   * Bestand wird nie aus DATANORM importiert (B-Saetze werden in v4 als
--     EAN-Quelle, in v5 als Delete-Marker gelesen — siehe parser).
--     Die AGENTS.md-Invariante "Bestand = Summe der Buchungen" bleibt
--     damit unangetastet.
--
-- Idempotent: alle DDL mit IF NOT EXISTS / DROP IF EXISTS.

-- ---------- Lieferant ----------
--
-- Ein Lieferant = ein DATANORM-Katalog. Die Identitaet kommt beim Upload
-- vom User (er waehlt einen bestehenden Lieferanten oder legt einen neuen
-- an); der Vorsatz (V-Satz) ist nur eine Anreicherung/Plausibilitaet.
--
-- `matchcode` ist die Lieferanten-Kurzbezeichnung aus dem Vorsatz, falls
-- vorhanden. Unique case-insensitiv, damit "MUELLER" und "Mueller" nicht
-- zwei Lieferanten werden.
CREATE TABLE IF NOT EXISTS lieferanten (
    id                  TEXT PRIMARY KEY,
    matchcode           TEXT,
    name                TEXT NOT NULL,
    strasse             TEXT,
    plz                 TEXT,
    ort                 TEXT,
    land                TEXT DEFAULT 'DE',
    telefon             TEXT,
    email               TEXT,
    ust_idnr            TEXT,
    -- Auto-angelegte Lieferanten starten inaktiv: der Admin bestaetigt sie
    -- in der Lieferantenverwaltung, bevor sie in der PWA-Auswahl auftauchen.
    aktiv               BOOLEAN NOT NULL DEFAULT FALSE,
    geaendert_am        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    erstellt_am         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS lieferanten_matchcode_lower_idx
    ON lieferanten (LOWER(matchcode)) WHERE matchcode IS NOT NULL;
CREATE INDEX IF NOT EXISTS lieferanten_name_idx ON lieferanten (LOWER(name));
CREATE INDEX IF NOT EXISTS lieferanten_aktiv_idx ON lieferanten (aktiv);
CREATE INDEX IF NOT EXISTS lieferanten_geaendert_am_idx ON lieferanten (geaendert_am);

-- ---------- Hersteller-Artikel (DATANORM-Spiegel) ----------
--
-- Identitaet: (lieferant_id, matchcode). Die Matchcode ist die
-- lieferanteneigene Artikelnummer und innerhalb eines Katalogs eindeutig.
--
-- Preise in Cent (INTEGER), konsistent zu `artikel.listenpreis`.
--
-- `preiseinheit` vs. `inhalt` (wichtig, haeufig vermischt):
--   * `mengeneinheit` = die Einheit als Text ("Stueck", "m", "kg")
--   * `preiseinheit`  = Faktor: "dieser Preis gilt fuer N Einheiten".
--                      In v4 ist das auf 1/10/100/1000 beschraenkt.
--   * `inhalt`        = Menge pro verkaufter Einheit (z. B. 12 Stueck je
--                      Packung). castel rechnet NICHT um — Bestand bleibt
--                      in der vom User erfassten Einheit.
--
-- `deaktiviert` wird gesetzt, wenn ein v5-B-Saetz (Delete-Marker) den
-- Artikel nennt. Der Eintrag bleibt sichtbar ("nicht mehr lieferbar"),
-- castel-Artikel werden NICHT angefasst.
CREATE TABLE IF NOT EXISTS hersteller_artikel (
    id                  TEXT PRIMARY KEY,
    lieferant_id        TEXT NOT NULL REFERENCES lieferanten(id) ON DELETE RESTRICT,
    matchcode           TEXT NOT NULL,
    matchcode2          TEXT,
    ean                 TEXT,
    titel               TEXT NOT NULL,
    beschreibung       TEXT,
    mengeneinheit       TEXT,
    preiseinheit        INTEGER,
    inhalt              NUMERIC,
    warengruppe         TEXT,
    preis_netto_cent    INTEGER,
    preis_brutto_cent   INTEGER,
    preis_aktion_cent   INTEGER,
    gueltig_ab          TIMESTAMPTZ,
    steuersatz          NUMERIC,
    gewicht             NUMERIC,
    ersatz_matchcode    TEXT,
    deaktiviert         BOOLEAN NOT NULL DEFAULT FALSE,
    deaktiviert_am      TIMESTAMPTZ,
    deaktiviert_grund   TEXT,
    geaendert_am        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    erstellt_am         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotenz-Stamm: ein Matchcode pro Lieferant.
CREATE UNIQUE INDEX IF NOT EXISTS hersteller_artikel_lieferant_matchcode_idx
    ON hersteller_artikel (lieferant_id, matchcode);

-- EAN ist optional (viele Lieferanten liefern keine) — deshalb partiell.
CREATE UNIQUE INDEX IF NOT EXISTS hersteller_artikel_lieferant_ean_idx
    ON hersteller_artikel (lieferant_id, ean) WHERE ean IS NOT NULL;

-- Lookup-Pfade der PWA.
CREATE INDEX IF NOT EXISTS hersteller_artikel_ean_idx
    ON hersteller_artikel (ean) WHERE ean IS NOT NULL;
CREATE INDEX IF NOT EXISTS hersteller_artikel_lieferant_idx
    ON hersteller_artikel (lieferant_id);
CREATE INDEX IF NOT EXISTS hersteller_artikel_titel_idx
    ON hersteller_artikel (LOWER(titel));
CREATE INDEX IF NOT EXISTS hersteller_artikel_geaendert_am_idx
    ON hersteller_artikel (geaendert_am);

-- ---------- Hochgeladene Dateien ----------
--
-- `datei_hash` (SHA-256) + `lieferant_id` ist unique: derselbe Upload
-- zweimal wird erkannt und nicht erneut geparst.
--
-- `pfad` ist relativ zu DATANORM_DIR — absolute Pfade waeren nach einem
-- Restore in eine andere Installation ungueltig.
CREATE TABLE IF NOT EXISTS datanorm_dateien (
    id                  TEXT PRIMARY KEY,
    lieferant_id        TEXT NOT NULL REFERENCES lieferanten(id) ON DELETE CASCADE,
    pfad                TEXT NOT NULL,
    original_name       TEXT NOT NULL,
    byte_groesse        BIGINT NOT NULL,
    datei_hash          TEXT NOT NULL,
    encoding            TEXT,
    version_erkannt     INTEGER,
    abgelegt_am         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS datanorm_dateien_lieferant_hash_idx
    ON datanorm_dateien (lieferant_id, datei_hash);
CREATE UNIQUE INDEX IF NOT EXISTS datanorm_dateien_pfad_idx
    ON datanorm_dateien (pfad);
-- Cleanup-Cron: aelteste Eintraege pro Lieferant finden, juengster bleibt.
CREATE INDEX IF NOT EXISTS datanorm_dateien_abgelegt_am_idx
    ON datanorm_dateien (abgelegt_am DESC);

-- ---------- Import-Reports ----------
--
-- Append-only Audit-Spur: ein Eintrag je Upload-Versuch, auch bei
-- Fehlern. Wird NIE aufgeraeumt (im Gegensatz zu datanorm_dateien).
CREATE TABLE IF NOT EXISTS datanorm_importe (
    id                      TEXT PRIMARY KEY,
    lieferant_id            TEXT NOT NULL REFERENCES lieferanten(id) ON DELETE CASCADE,
    datei_id                TEXT REFERENCES datanorm_dateien(id) ON DELETE SET NULL,
    original_dateiname      TEXT NOT NULL,
    status                  TEXT NOT NULL DEFAULT 'gestartet'
                                CHECK (status IN ('gestartet', 'erfolg', 'teilfehler', 'fehler')),
    encoding                TEXT,
    version_erkannt         INTEGER,
    artikel_anzahl          INTEGER NOT NULL DEFAULT 0,
    artikel_neu             INTEGER NOT NULL DEFAULT 0,
    artikel_aktualisiert    INTEGER NOT NULL DEFAULT 0,
    artikel_deaktiviert     INTEGER NOT NULL DEFAULT 0,
    uebersprungen           INTEGER NOT NULL DEFAULT 0,
    fehler_anzahl           INTEGER NOT NULL DEFAULT 0,
    fehler_details          JSONB NOT NULL DEFAULT '[]'::jsonb,
    metadaten               JSONB NOT NULL DEFAULT '{}'::jsonb,
    benutzer_id             TEXT REFERENCES users(id) ON DELETE SET NULL,
    gestartet_am            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    beendet_am              TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS datanorm_importe_gestartet_am_idx
    ON datanorm_importe (gestartet_am DESC);
CREATE INDEX IF NOT EXISTS datanorm_importe_lieferant_idx
    ON datanorm_importe (lieferant_id);
CREATE INDEX IF NOT EXISTS datanorm_importe_status_idx
    ON datanorm_importe (status);

-- ---------- Audit-Log-Entitaet erweitern ----------
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_entitaet_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_entitaet_check
    CHECK (entitaet IN (
        'artikel', 'standort', 'buchung', 'kommission', 'foto', 'user',
        'einstellung', 'lieferant', 'hersteller_artikel', 'datanorm_import'
    ));