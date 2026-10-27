-- castel: Akkutausch — optionale Akku-Daten (Migration 0023).
--
-- Aus CSV-Importen stammen Geraete, fuer die noch nicht alle Werte
-- vorliegen (z. B. fehlende Kapazitaet, kein Einbaudatum bekannt). Solche
-- Geraete sollen importierbar sein und spaeter in der PWA ergaenzt werden.
--
-- Dazu werden die vier NOT NULL-Constraints entfernt. Die CHECK-Constraints
-- bleiben bestehen: in Postgres ist das Ergebnis eines CHECK mit NULL
-- "unknown" und damit erlaubt — 0 oder negative Werte bleiben also weiterhin
-- ausgeschlossen, nur "noch nicht bekannt" wird jetzt akzeptiert.
--
-- Idempotent: DROP NOT NULL ist ein No-Op, wenn die Spalte bereits nullable
-- ist.

ALTER TABLE akku_netzteile ALTER COLUMN einbaudatum DROP NOT NULL;
ALTER TABLE akku_netzteile ALTER COLUMN intervall_jahre DROP NOT NULL;
ALTER TABLE akku_netzteile ALTER COLUMN kapazitaet_ah DROP NOT NULL;
ALTER TABLE akku_netzteile ALTER COLUMN anzahl DROP NOT NULL;
