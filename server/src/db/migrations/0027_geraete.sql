-- castel: Geraete-Registry fuer den serverseitig ausgeloesten lokalen
-- DB-Reset pro Endgeraet (Reset-Flag).
-- Migration 0027. Idempotent.
--
-- Ein Endgeraet meldet sich per Heartbeat (/api/sync/device-heartbeat) mit
-- einer clientseitig erzeugten Geräte-UUID. Der Server setzt reset_am,
-- um das Endgeraet zur Selbst-Loescheung der lokalen IndexedDB und zum
-- Neuaufbau vom Server zu zwingen (siehe worker.ts `handleDeviceReset`).

CREATE TABLE IF NOT EXISTS geraete (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    fingerprint text NOT NULL DEFAULT '{}',
    reset_am timestamp with time zone,
    registriert_am timestamp with time zone NOT NULL DEFAULT now(),
    zuletzt_gesehen_am timestamp with time zone NOT NULL DEFAULT now()
);

-- Alle Geraete eines Users auflisten.
CREATE INDEX IF NOT EXISTS geraete_user_idx ON geraete(user_id);

-- Geraete mit ausstehendem Reset finden.
CREATE INDEX IF NOT EXISTS geraete_reset_am_idx ON geraete(reset_am) WHERE reset_am IS NOT NULL;
