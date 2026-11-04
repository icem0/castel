-- castel: Inventur-Berechtigungen.
-- Migration 0032. Idempotent (ON CONFLICT DO NOTHING).
--
-- Seedt die neuen Berechtigungen `inventur.*` für die Rollen `lagerist`
-- und `admin` (Admin bekommt sie implizit über den Short-Circuit in
-- `berechtigungenFuer`, wird aber trotzdem explizit geseedt, damit die
-- Rollen-UI sie als bekannt anzeigt).
--
-- Bestehende Installationen erhalten die Berechtigungen erst durch diese
-- Migration; neuere Installationen bauen auf dem Seed auf.

-- ---------- Seed: Berechtigungen für 'lagerist' ----------
INSERT INTO rollen_berechtigungen (rolle_id, berechtigung) VALUES
    ('lagerist', 'inventur.stichtag'),
    ('lagerist', 'inventur.lesen'),
    ('lagerist', 'inventur.erstellen'),
    ('lagerist', 'inventur.abschliessen'),
    ('lagerist', 'inventur.export')
ON CONFLICT DO NOTHING;

-- ---------- Seed: Berechtigungen für 'admin' ----------
INSERT INTO rollen_berechtigungen (rolle_id, berechtigung) VALUES
    ('admin', 'inventur.stichtag'),
    ('admin', 'inventur.lesen'),
    ('admin', 'inventur.erstellen'),
    ('admin', 'inventur.abschliessen'),
    ('admin', 'inventur.export')
ON CONFLICT DO NOTHING;
