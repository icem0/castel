-- castel: Anzeigename für User ergänzen.
-- Migration 0002. Idempotent (IF NOT EXISTS) — sicher gegen mehrfaches Ausführen.
--
-- Hintergrund: Beim ersten Setup (LoginView, keine User vorhanden) muss der
-- erste Account mit Anzeigename, E-Mail und Passwort angelegt werden. Der
-- Anzeigename ist optional und wird überall in der UI statt der E-Mail
-- angezeigt, wo ein Personenname sinnvoll ist.

ALTER TABLE users ADD COLUMN IF NOT EXISTS anzeigename TEXT NOT NULL DEFAULT '';
