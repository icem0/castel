-- castel initial schema
-- Generated manually to match src/db/schema.ts (Drizzle)
-- Run order: this file is the only one in the project. Future migrations append here.

-- ---------- Extensions ----------

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------- Users / Auth ----------

CREATE TABLE users (
    id                    TEXT PRIMARY KEY,
    email                 TEXT NOT NULL,
    password_hash         TEXT NOT NULL,
    rolle                 TEXT NOT NULL CHECK (rolle IN ('admin', 'user')),
    aktiv                 BOOLEAN NOT NULL DEFAULT TRUE,
    erstellt_am           TIMESTAMPTZ NOT NULL,
    letzter_login_am      TIMESTAMPTZ,
    must_change_password  BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));

CREATE TABLE refresh_tokens (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL,
    erstellt_am  TIMESTAMPTZ NOT NULL,
    ablauf_am    TIMESTAMPTZ NOT NULL,
    revoked_at   TIMESTAMPTZ,
    user_agent   TEXT
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_hash_idx ON refresh_tokens (token_hash);

-- ---------- Domäne ----------

CREATE TABLE artikel (
    id                 TEXT PRIMARY KEY,
    share_point_id     INTEGER,
    titel              TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT 'verfuegbar'
                         CHECK (status IN ('verfuegbar', 'reserviert', 'gesperrt', 'ausgesondert')),
    typ                TEXT NOT NULL DEFAULT '',
    lieferant          TEXT,
    verpackungseinheit INTEGER NOT NULL DEFAULT 1,
    mindestbestand     INTEGER,
    nachbestell_hinweis TEXT CHECK (nachbestell_hinweis IN ('i.O', 'bald', 'dringend')),
    bestellnummer      TEXT,
    listenpreis        INTEGER,
    geaendert_am       TIMESTAMPTZ NOT NULL,
    erstellt_am        TIMESTAMPTZ NOT NULL,
    archiviert         BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX artikel_sharepoint_idx ON artikel (share_point_id);
CREATE INDEX artikel_typ_idx       ON artikel (typ);
CREATE INDEX artikel_status_idx    ON artikel (status);
CREATE INDEX artikel_archiviert_idx ON artikel (archiviert);

CREATE TABLE standorte (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    typ          TEXT NOT NULL CHECK (typ IN ('lager', 'auto', 'baustelle', 'extern')),
    projekt      TEXT,
    kennzeichen  TEXT,
    standard     BOOLEAN NOT NULL DEFAULT FALSE,
    archiviert   BOOLEAN NOT NULL DEFAULT FALSE,
    geaendert_am TIMESTAMPTZ NOT NULL,
    erstellt_am  TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX standorte_name_idx ON standorte (name);
CREATE INDEX standorte_typ_idx         ON standorte (typ);
CREATE INDEX standorte_archiviert_idx  ON standorte (archiviert);

CREATE TABLE projekte (
    id           TEXT PRIMARY KEY,
    nummer       TEXT NOT NULL,
    name         TEXT,
    archiviert   BOOLEAN NOT NULL DEFAULT FALSE,
    geaendert_am TIMESTAMPTZ NOT NULL,
    erstellt_am  TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX projekte_nummer_idx ON projekte (nummer);
CREATE INDEX projekte_archiviert_idx    ON projekte (archiviert);

CREATE TABLE buchungen (
    id                 TEXT PRIMARY KEY,
    artikel_id         TEXT NOT NULL REFERENCES artikel(id),
    standort_id        TEXT NOT NULL REFERENCES standorte(id),
    standort_ziel_id   TEXT REFERENCES standorte(id),
    typ                TEXT NOT NULL
                         CHECK (typ IN ('einlagerung', 'entnahme', 'umlagerung', 'inventur', 'kommission', 'storno')),
    menge              INTEGER NOT NULL,
    paar_id            TEXT,
    projekt            TEXT,
    erstellt_am        TIMESTAMPTZ NOT NULL,
    client_eingabe_am  TIMESTAMPTZ,
    erstellt_von       TEXT NOT NULL,
    kommentar          TEXT,
    mitteilung_an      TEXT,
    storno_von         TEXT,
    storno             BOOLEAN NOT NULL DEFAULT FALSE,
    storniert_durch    TEXT
);
CREATE INDEX buchungen_artikel_idx        ON buchungen (artikel_id);
CREATE INDEX buchungen_standort_idx       ON buchungen (standort_id);
CREATE INDEX buchungen_standort_ziel_idx  ON buchungen (standort_ziel_id);
CREATE INDEX buchungen_typ_idx            ON buchungen (typ);
CREATE INDEX buchungen_erstellt_am_idx    ON buchungen (erstellt_am);
CREATE INDEX buchungen_storno_idx         ON buchungen (storno);
CREATE INDEX buchungen_paar_idx           ON buchungen (paar_id);
CREATE INDEX buchungen_bestand_idx        ON buchungen (artikel_id, standort_id);

-- ---------- Fotos ----------

CREATE TABLE fotos (
    id           TEXT PRIMARY KEY,
    artikel_id   TEXT NOT NULL REFERENCES artikel(id) ON DELETE CASCADE,
    pfad         TEXT NOT NULL,
    content_type TEXT NOT NULL,
    groesse      INTEGER NOT NULL,
    erstellt_am  TIMESTAMPTZ NOT NULL,
    erstellt_von TEXT NOT NULL
);
CREATE INDEX fotos_artikel_idx     ON fotos (artikel_id);
CREATE INDEX fotos_erstellt_am_idx ON fotos (erstellt_am);

-- ---------- Audit ----------

CREATE TABLE audit_log (
    id           TEXT PRIMARY KEY,
    aktion       TEXT NOT NULL,
    entitaet     TEXT NOT NULL
                   CHECK (entitaet IN ('artikel', 'standort', 'buchung', 'projekt', 'foto', 'user')),
    entitaet_id  TEXT NOT NULL,
    benutzer_id  TEXT,
    daten        JSONB,
    zeit         TIMESTAMPTZ NOT NULL
);
CREATE INDEX audit_aktion_idx  ON audit_log (aktion);
CREATE INDEX audit_entitaet_idx ON audit_log (entitaet, entitaet_id);
CREATE INDEX audit_zeit_idx    ON audit_log (zeit);