-- castel: API-Keys fuer KI-Agenten / MCP.
-- Migration 0016. Idempotent (CREATE TABLE / INDEX IF NOT EXISTS).
--
-- Sicherheitsmodell:
--   * Der Klartext-Key wird NIE gespeichert, nur der SHA-256-Hash.
--     Ein kompromittiertes DB-Backup enthaelt damit keine nutzbaren Keys.
--   * `prefix` ist der sichtbare Teil (castel_ab12cd34) fuer die UI.
--   * `scopes` beschraenkt, was ein Agent darf: read, write, admin.
--     Die Rolle des Users wird zusaetzlich geprueft; ein Scope kann
--     Rechte nie erweitern, nur einschraenken.
--   * `revoked_at` / `ablauf_am` machen Keys sofort ungueltig.
CREATE TABLE IF NOT EXISTS api_keys (
    id                 TEXT PRIMARY KEY,
    user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name               TEXT NOT NULL,
    key_hash           TEXT NOT NULL,
    prefix             TEXT NOT NULL,
    scopes             TEXT[] NOT NULL DEFAULT '{}',
    erstellt_am        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    letzte_nutzung_am  TIMESTAMPTZ,
    ablauf_am          TIMESTAMPTZ,
    revoked_at         TIMESTAMPTZ,
    CONSTRAINT api_keys_scopes_check
      CHECK (scopes <@ ARRAY['read', 'write', 'admin']::TEXT[])
);

CREATE UNIQUE INDEX IF NOT EXISTS api_keys_hash_idx ON api_keys (key_hash);
CREATE INDEX IF NOT EXISTS api_keys_user_idx ON api_keys (user_id);
CREATE INDEX IF NOT EXISTS api_keys_prefix_idx ON api_keys (prefix);
