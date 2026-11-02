-- Rollen als Array (stapelbare Berechtigungen).
--
-- `users.rolle` bleibt als Legacy-Spalte erhalten (nur 'admin'/'user') und wird
-- weiterhin dual geschrieben — so erkennen aeltere Server-Container waehrend
-- eines Rollouts die Admin-Rolle unveraendert. `users.rollen` ist die neue
-- Quelle der Wahrheit: ein Array, weil die Berechtigungen stapelbar sind
-- (z.B. {user, lagerist}).
--
-- Idempotent: mehrfach ausfuehrbar (der Runner rollt bei Teilfehler zurueck
-- und versucht es beim naechsten Container-Start erneut).

ALTER TABLE users ADD COLUMN IF NOT EXISTS rollen TEXT[] NULL;

UPDATE users
SET rollen = CASE WHEN rolle = 'admin' THEN ARRAY['admin']::TEXT[] ELSE ARRAY['user']::TEXT[] END
WHERE rollen IS NULL;

ALTER TABLE users ALTER COLUMN rollen SET DEFAULT ARRAY['user']::TEXT[];
ALTER TABLE users ALTER COLUMN rollen SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_rollen_check') THEN
    ALTER TABLE users
      ADD CONSTRAINT users_rollen_check
      CHECK (
        rollen <@ ARRAY['user', 'lagerist', 'admin']::TEXT[]
        AND array_length(rollen, 1) >= 1
      );
  END IF;
END $$;
