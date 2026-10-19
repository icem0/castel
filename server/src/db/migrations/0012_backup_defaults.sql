-- castel: Backup-Default-Settings (Migration 0012).
--
-- Die Backup-Funktion (admin/backup.ts) speichert ihre Einstellungen
-- in der `einstellungen`-Tabelle. Wir legen hier nur die Defaults an,
-- damit der Server nach dem Start weiss, was zu tun ist, BEVOR der
-- Admin jemals die Einstellungs-Seite geoeffnet hat.
--
-- - `backup.schedule`     = ''       (Cron aus, bis Admin aktiviert)
-- - `backup.keepCopies`   = '7'      (eine Woche taeglicher Backups behalten)
--
-- ON CONFLICT DO NOTHING, damit ein Update der Defaults (z. B. spaeter
-- '14') nichts ueberschreibt, was der Admin bereits gesetzt hat.
--
-- user_id IS NULL, weil das globale Server-Settings sind (kein Per-User-
-- Wert). Siehe Migration 0005 / 0007 fuer die globale-Variante.

INSERT INTO einstellungen (key, user_id, value, geaendert_am)
VALUES ('backup.schedule', NULL, '', NOW())
ON CONFLICT (key, user_id) DO NOTHING;

INSERT INTO einstellungen (key, user_id, value, geaendert_am)
VALUES ('backup.keepCopies', NULL, '7', NOW())
ON CONFLICT (key, user_id) DO NOTHING;
