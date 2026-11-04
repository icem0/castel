-- castel: Inventur-Berechtigungen.
-- Migration 0032. Idempotent (ON CONFLICT DO NOTHING).
--
-- Seedt die neue Berechtigung `inventur.stichtag` für die Rolle `lagerist`
-- (Admin bekommt sie implizit über den Short-Circuit in `berechtigungenFuer`
-- und den `KNOWN_PERMISSIONS`-Eintrag, wird aber trotzdem explizit geseedt,
-- damit die Rollen-UI sie als bekannt anzeigt).
--
-- Bestehende Installationen erhalten die Berechtigung erst durch diese
-- Migration; neuere Installationen bauen auf dem Seed auf.

-- ---------- Seed: Berechtigung inventur.stichtag für 'lagerist' ----------
INSERT INTO rollen_berechtigungen (rolle_id, berechtigung) VALUES
    ('lagerist', 'inventur.stichtag')
ON CONFLICT DO NOTHING;

-- ---------- Seed: Berechtigung inventur.stichtag für 'admin' ----------
INSERT INTO rollen_berechtigungen (rolle_id, berechtigung) VALUES
    ('admin', 'inventur.stichtag')
ON CONFLICT DO NOTHING;
