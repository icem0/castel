-- castel: Backfill empty user display names.
-- Migration 0016. Idempotent.
--
-- Bookings store the author's display name in `erstellt_von`. Users created
-- through the admin UI before display names became mandatory had an empty
-- `anzeigename`, so their bookings showed up as "unbekannt". Derive a useful
-- default from the e-mail local part.

UPDATE users
SET anzeigename = split_part(email, '@', 1)
WHERE btrim(anzeigename) = ''
  AND split_part(email, '@', 1) <> '';
