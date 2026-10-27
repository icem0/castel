-- castel: Hersteller-Stammdaten + Bestellvorgang je Hersteller.
-- Migration 0019. Idempotent (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
--
-- Bisher war `artikel.lieferant` nur ein Freitext-Feld ohne Fremdschluessel.
-- Ab jetzt gibt es eine eigene `hersteller`-Tabelle mit dem Bestellkontakt
-- (E-Mail ODER Webseite) und `artikel.hersteller_id` als Referenz. Der
-- Freitext bleibt aus Kompatibilitaetsgruenden (DATANORM, CSV-Import)
-- erhalten und wird beim Speichern aus dem Herstellernamen gespiegelt.
--
-- `bestellstatus` ist der pro Artikel gespeicherte Bestellzustand des
-- Mindestbestandsalarms ("offen" = noch nicht bestellt, "bestellt" =
-- bestellt). `bestellt_von` ist der Anzeigename des Users, der die
-- Bestellung ausgeloest hat (das Kuerzel wird in der UI abgeleitet).

CREATE TABLE IF NOT EXISTS hersteller (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    bestell_email     TEXT,
    bestell_webseite  TEXT,
    geaendert_am      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    erstellt_am       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Snapshot-Endpoint filtert auf `geaendert_am > since` — Index Pflicht.
CREATE INDEX IF NOT EXISTS hersteller_geaendert_am_idx
    ON hersteller (geaendert_am);
-- Name-Lookup fuer den Picker (case-insensitiv), bewusst NICHT unique:
-- Offline angelegte Hersteller koennen denselben Namen tragen, ein
-- Unique-Constraint wuerde den Sync-Push in die Quarantaene schicken.
CREATE INDEX IF NOT EXISTS hersteller_name_lower_idx
    ON hersteller (LOWER(name));

ALTER TABLE artikel
  ADD COLUMN IF NOT EXISTS hersteller_id TEXT
    REFERENCES hersteller(id) ON DELETE SET NULL;
ALTER TABLE artikel
  ADD COLUMN IF NOT EXISTS bestellstatus TEXT NOT NULL DEFAULT 'offen';
ALTER TABLE artikel
  ADD COLUMN IF NOT EXISTS bestellt_am TIMESTAMPTZ;
ALTER TABLE artikel
  ADD COLUMN IF NOT EXISTS bestellt_von TEXT;

ALTER TABLE artikel DROP CONSTRAINT IF EXISTS artikel_bestellstatus_check;
ALTER TABLE artikel ADD CONSTRAINT artikel_bestellstatus_check
    CHECK (bestellstatus IN ('offen', 'bestellt'));

CREATE INDEX IF NOT EXISTS artikel_hersteller_idx
    ON artikel (hersteller_id);

-- Backfill: bestehende Freitext-Lieferanten werden zu Herstellern und die
-- Artikel werden per Namen (case-insensitiv, getrimmt) verknuepft. Leere
-- oder reine Whitespace-Werte erzeugen keinen Hersteller.
WITH kandidaten AS (
    SELECT LOWER(TRIM(lieferant)) AS norm, MIN(TRIM(lieferant)) AS name
    FROM artikel
    WHERE lieferant IS NOT NULL AND TRIM(lieferant) <> ''
    GROUP BY LOWER(TRIM(lieferant))
)
INSERT INTO hersteller (id, name, geaendert_am, erstellt_am)
SELECT gen_random_uuid(), k.name, NOW(), NOW()
FROM kandidaten k
WHERE NOT EXISTS (
    SELECT 1 FROM hersteller h WHERE LOWER(TRIM(h.name)) = k.norm
);

UPDATE artikel a
SET hersteller_id = h.id
FROM hersteller h
WHERE a.hersteller_id IS NULL
  AND a.lieferant IS NOT NULL
  AND LOWER(TRIM(a.lieferant)) = LOWER(TRIM(h.name));

-- ---------- Audit-Log-Entitaet erweitern ----------
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_entitaet_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_entitaet_check
    CHECK (entitaet IN (
        'artikel', 'standort', 'buchung', 'kommission', 'foto', 'user',
        'einstellung', 'lieferant', 'hersteller', 'hersteller_artikel',
        'datanorm_import'
    ));
