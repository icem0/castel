-- castel: Netto-Einkaufspreis je Verpackungseinheit auf `artikel`.
-- Migration 0017. Idempotent (ADD COLUMN IF NOT EXISTS).
--
-- Der Einkaufspreis ist vertraulich: er wird nur an Admins ausgeliefert
-- (siehe server/src/sync/routes.ts) und nur von Admins geschrieben
-- (siehe server/src/sync/resolver.ts). `listenpreis` bleibt oeffentlich.
--
-- Einheit: Ganzzahl in Cent, wie `listenpreis`. Der Preis gilt je
-- Verpackungseinheit (`verpackungseinheit`), nicht je Stueck.

ALTER TABLE artikel
  ADD COLUMN IF NOT EXISTS einkaufspreis INTEGER;
