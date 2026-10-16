-- castel: per-User `standardStandortId` fuer Admins nachtraeglich auf das
-- Hauptlager setzen. Migration 0008. Idempotent.
--
-- Hintergrund: das initiale Setup (POST /api/auth/setup) legt das
-- Hauptlager als `standort.standard = true` an, schreibt aber kein
-- passendes `einstellungen.standardStandortId` fuer den neuen Admin.
-- Folge: im Settings-View-Dropdown stand "noch nicht festgelegt".
-- Dieser Backfill schliesst die Luecke fuer bestehende Installationen.
--
-- Logik:
--   - Pro Admin-User, der noch keine eigene standardStandortId-Zeile hat,
--     schreiben wir (falls ein Standort mit standard=true existiert) die
--     entsprechende Zeile.
--   - geaendertAm = NOW(): die neue Zeile gewinnt im LWW, weil lokal
--     hoechstens ein DEFAULTS-Eintrag (value='') liegt, der via
--     fromRows() als null interpretiert wird und ueberhaupt nicht
--     geschrieben wird.

INSERT INTO einstellungen (key, user_id, value, geaendert_am)
SELECT 'standardStandortId', u.id, s.id, NOW()
FROM users u
CROSS JOIN LATERAL (
    SELECT id
    FROM standorte
    WHERE standard = true
      AND archiviert = false
    ORDER BY erstellt_am ASC
    LIMIT 1
) s
WHERE u.rolle = 'admin'
  AND u.aktiv = true
  AND NOT EXISTS (
    SELECT 1
    FROM einstellungen e
    WHERE e.key = 'standardStandortId'
      AND e.user_id = u.id
  );