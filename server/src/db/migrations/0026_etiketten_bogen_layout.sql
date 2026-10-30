-- castel: Benutzerdefiniertes Bogen-Layout fuer den Barcode-Druck (serverseitig).
-- Migration 0026. Idempotent.
--
-- Jeder User kann genau ein eigenes benutzerdefiniertes Layout speichern.
-- Das Layout ersetzt die bisher nur clientseitig (Vue-Ref, ohne Persistenz)
-- gehaltenen Werte des "Benutzerdefiniert"-Presets.

CREATE TABLE IF NOT EXISTS etiketten_bogen_layout (
    id text PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    layout jsonb NOT NULL,
    geaendert_am timestamp with time zone NOT NULL DEFAULT now(),
    erstellt_am timestamp with time zone NOT NULL DEFAULT now()
);

-- Ein Layout pro User.
CREATE UNIQUE INDEX IF NOT EXISTS etiketten_bogen_layout_user_idx ON etiketten_bogen_layout(user_id);

-- Sync-Snapshot filtert auf `geaendert_am > since` — Index ist Pflicht.
CREATE INDEX IF NOT EXISTS etiketten_bogen_layout_geaendert_am_idx ON etiketten_bogen_layout(geaendert_am);
