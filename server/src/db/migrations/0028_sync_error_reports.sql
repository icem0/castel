-- castel: Sync-Fehler-Reports pro Endgeraet.
-- Migration 0028. Idempotent.
--
-- Ein Client pusht bei einem Sync-Fehler einen strukturierten Report
-- (code, message, diagnostics, ...) per POST /api/sync/sync-error-report.
-- Der Server ordnet den Report dem angemeldeten User und seinem Endgeraet
-- zu. Pro Endgeraet werden nur die letzten 2 Reports aufbewahrt (aelteste
-- werden beim Insert geloescht).
--
-- Admin sieht die Reports in der Entwicklung-Ansicht (Geräteverwaltung).

-- pgcrypto fuer gen_random_uuid() benoetigt.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS sync_error_reports (
    id text PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id text NOT NULL REFERENCES geraete(id) ON DELETE CASCADE,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    occurred_at timestamptz NOT NULL,
    source text NOT NULL,
    code text NOT NULL,
    message text NOT NULL,
    http_status integer,
    stack text,
    payload jsonb,
    diagnostics jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Zugriff pro Endgeraet (für Admin-Ansicht).
CREATE INDEX IF NOT EXISTS sync_error_reports_device_idx ON sync_error_reports(device_id);
-- Neueste Reports zuerst.
CREATE INDEX IF NOT EXISTS sync_error_reports_created_idx ON sync_error_reports(created_at DESC);
