-- castel: Durchschnittsrabatt je Lieferant (Migration 0022).
--
-- Der Rabattsatz ist die kaufmaennische Grundlage fuer den "wahren Wert"
-- (Einkaufspreis) eines Artikels: EK = Listenpreis * (1 - Rabatt / 100).
--
-- Er liegt am `hersteller`, weil das die Lieferanten-Stammdaten sind, an
-- denen die Artikel haengen (`artikel.hersteller_id`). Der Freitext
-- `artikel.lieferant` bleibt aus Kompatibilitaetsgruenden (DATANORM, CSV)
-- erhalten und wird beim Speichern aus dem Herstellernamen gespiegelt.
--
-- Einheit: Prozent mit zwei Nachkommastellen (NUMERIC(5,2)). 0 = kein
-- Rabatt bekannt. Werte > 100 sind fachlich sinnlos (EK waere negativ)
-- und werden per CHECK-Constraint abgewiesen.
--
-- Vertraulich: der Rabattsatz ist dieselbe Information wie der
-- Einkaufspreis. Der Snapshot liefert ihn nur an Admins aus; der
-- Push-Resolver akzeptiert ihn nur von Admins (analog
-- `artikel.einkaufspreis`, siehe server/src/sync/preise.ts).
--
-- Hinweis zur Ausfuehrung: der Runner (`server/src/db/migrate.ts`)
-- entscheidet anhand des Datei-Hashs, welche Migrationen fehlen — der
-- `when`-Wert im Journal ist rein informativ.

ALTER TABLE hersteller
    ADD COLUMN IF NOT EXISTS rabattsatz NUMERIC(5, 2) NOT NULL DEFAULT 0;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'hersteller_rabattsatz_check'
    ) THEN
        ALTER TABLE hersteller
            ADD CONSTRAINT hersteller_rabattsatz_check
            CHECK (rabattsatz >= 0 AND rabattsatz <= 100);
    END IF;
END $$;
