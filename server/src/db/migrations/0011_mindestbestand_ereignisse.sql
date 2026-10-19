-- castel: Tabelle `mindestbestand_ereignisse` (Migration 0011).
--
-- Append-only Tabelle für unterschrittene Mindestbestände. Jede Zeile ist
-- ein Ereignis: "nach dieser Buchung lag der Bestand am Standort
-- `standort_id` unter dem Mindestbestand des Artikels". Server-seitiger
-- Trigger (sync/resolver.ts) inserted hier innerhalb der Buchungs-Transaktion,
-- damit Konsistenz zwischen DB und Event gewahrt bleibt.
--
-- Idempotent: `CREATE TABLE IF NOT EXISTS`. Zusätzliche Indizes sind
-- ebenfalls idempotent.
--
-- Die PWA spiegelt diese Tabelle 1:1 in IndexedDB (`mindestbestandEreignisse`).
-- Die Felder `zustellung_admin_ids` und `konsumiert_von_mail` sind
-- Server-only und werden beim Snapshot-Endpoint nicht mit ausgeliefert.

CREATE TABLE IF NOT EXISTS mindestbestand_ereignisse (
    id                       TEXT PRIMARY KEY,
    artikel_id               TEXT NOT NULL REFERENCES artikel(id),
    standort_id              TEXT NOT NULL REFERENCES standorte(id),
    ausloeser_buchung_id     TEXT NOT NULL REFERENCES buchungen(id),
    bestand_danach           INTEGER NOT NULL,
    mindestbestand           INTEGER NOT NULL,
    defizit                  INTEGER NOT NULL,
    erstellt_am              TIMESTAMPTZ NOT NULL,
    zustellung_admin_ids     TEXT[] NOT NULL DEFAULT '{}',
    konsumiert_von_mail      BOOLEAN NOT NULL DEFAULT FALSE
);

-- Snapshot-Endpoint filtert auf `erstellt_am > mindestSince` — Index Pflicht.
CREATE INDEX IF NOT EXISTS mindestbestand_ereignisse_erstellt_am_idx
    ON mindestbestand_ereignisse (erstellt_am DESC);

-- Lookup "alle Events für einen Artikel" (Panel-Filter).
CREATE INDEX IF NOT EXISTS mindestbestand_ereignisse_artikel_standort_idx
    ON mindestbestand_ereignisse (artikel_id, standort_id, erstellt_am DESC);
