-- castel: Indizes auf `geaendert_am` für Sync-Snapshot-Endpoint.
-- Migration 0004. Idempotent (CREATE INDEX IF NOT EXISTS).
--
-- Hintergrund: GET /api/sync/snapshot?since=<iso> filtert auf
-- `geaendert_am > since` (artikel, standorte, projekte). Ohne Index
-- macht Postgres einen Sequential Scan — bei wachsendem Bestand teuer.
-- buchungen hat bereits `buchungen_erstellt_am_idx` (Migration 0001).

CREATE INDEX IF NOT EXISTS artikel_geaendert_am_idx     ON artikel (geaendert_am);
CREATE INDEX IF NOT EXISTS standorte_geaendert_am_idx   ON standorte (geaendert_am);
CREATE INDEX IF NOT EXISTS projekte_geaendert_am_idx    ON projekte (geaendert_am);
