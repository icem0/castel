-- Rollen als konfigurierbare Entitäten mit zugewiesenen Berechtigungen.
--
-- Bisher waren Rollen und ihre Berechtigungen hardcoded
-- (server/src/domain/rollen.ts). Damit ein Admin sie über das UI anpassen
-- kann (Rollen hinzufügen/löschen, Berechtigungen per Checkbox zuordnen),
-- ziehen sie in die Datenbank.
--
-- `rollen.id` ist der stabile interne Schlüssel (Slug, z. B. 'lagerist').
-- `rollen.name` ist die frei änderbare Anzeige.
-- `rollen_berechtigungen` bildet die n:m-Beziehung Rolle <-> Berechtigung.
-- Admin hat immer alle Berechtigungen und ist nicht löschbar; das wird
-- applikationsseitig erzwungen (siehe /api/rollen und den Sync-Resolver).
--
-- Idempotent: mehrfach ausfuehrbar (der Runner rollt bei Teilfehler zurueck
-- und versucht es beim naechsten Container-Start erneut).

CREATE TABLE IF NOT EXISTS rollen (
    id              TEXT PRIMARY KEY,      -- interner Schlüssel (Slug)
    name            TEXT NOT NULL,         -- Anzeigename, änderbar
    beschreibung    TEXT NOT NULL DEFAULT '',
    aktiv           BOOLEAN NOT NULL DEFAULT TRUE,
    erstellt_am     TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS rollen_berechtigungen (
    rolle_id        TEXT NOT NULL REFERENCES rollen(id) ON DELETE CASCADE,
    berechtigung    TEXT NOT NULL,
    PRIMARY KEY (rolle_id, berechtigung)
);

-- ---------- Seed: initiale Rollen ----------
INSERT INTO rollen (id, name, beschreibung, erstellt_am) VALUES
    ('user', 'User', 'Basiszugriff: lesen, buchen, stornieren.', '2026-01-01T00:00:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO rollen (id, name, beschreibung, erstellt_am) VALUES
    ('lagerist', 'Lagerist', 'Zusätzlich zu User: Artikel und Standorte pflegen, Mindestbestand setzen.', '2026-01-01T00:00:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO rollen (id, name, beschreibung, erstellt_am) VALUES
    ('admin', 'Admin', 'Voller Zugriff auf alle Berechtigungen.', '2026-01-01T00:00:00Z')
ON CONFLICT (id) DO NOTHING;

-- ---------- Seed: Berechtigungen für 'user' ----------
INSERT INTO rollen_berechtigungen (rolle_id, berechtigung) VALUES
    ('user', 'artikel.lesen'),
    ('user', 'standort.lesen'),
    ('user', 'mindestbestand.lesen'),
    ('user', 'katalog.lesen'),
    ('user', 'buchung.erstellen'),
    ('user', 'buchung.storno'),
    ('user', 'kommission.beitragen'),
    ('user', 'etikett.drucken'),
    ('user', 'geraet.lokal')
ON CONFLICT DO NOTHING;

-- ---------- Seed: zusätzliche Berechtigungen für 'lagerist' ----------
INSERT INTO rollen_berechtigungen (rolle_id, berechtigung) VALUES
    ('lagerist', 'artikel.schreiben'),
    ('lagerist', 'artikel.loeschen'),
    ('lagerist', 'standort.schreiben'),
    ('lagerist', 'mindestbestand.schreiben')
ON CONFLICT DO NOTHING;

-- ---------- Seed: alle Berechtigungen für 'admin' ----------
INSERT INTO rollen_berechtigungen (rolle_id, berechtigung) VALUES
    ('admin', 'artikel.lesen'),
    ('admin', 'artikel.schreiben'),
    ('admin', 'artikel.loeschen'),
    ('admin', 'standort.lesen'),
    ('admin', 'standort.schreiben'),
    ('admin', 'standort.loeschen'),
    ('admin', 'mindestbestand.lesen'),
    ('admin', 'mindestbestand.schreiben'),
    ('admin', 'buchung.erstellen'),
    ('admin', 'buchung.storno'),
    ('admin', 'kommission.beitragen'),
    ('admin', 'etikett.drucken'),
    ('admin', 'geraet.lokal'),
    ('admin', 'katalog.lesen'),
    ('admin', 'einkaufspreis'),
    ('admin', 'stammdaten.verwalten'),
    ('admin', 'akkutausch.verwalten'),
    ('admin', 'globalEinstellung'),
    ('admin', 'benutzer.verwalten'),
    ('admin', 'backup.verwalten'),
    ('admin', 'import.fuehren'),
    ('admin', 'apiKey.verwalten'),
    ('admin', 'entwicklung')
ON CONFLICT DO NOTHING;
