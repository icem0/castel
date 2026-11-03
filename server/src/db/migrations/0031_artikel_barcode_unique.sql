-- castel: Barcode uniqueness on `artikel`.
-- Migration 0031. Idempotent (the dedupe CTE is a no-op once the index exists).
--
-- Why: the scanner resolves an article by `barcode` and takes the first hit.
-- Two articles sharing one code make the scan ambiguous — stock then moves on
-- the wrong article, which is exactly what the booking system must never do.
--
-- Step 1 (dedupe): existing duplicates must be resolved before the index can
-- be created. The row with the newest `geaendert_am` keeps the code (the same
-- last-writer-wins rule the sync uses); every other row loses it. A barcode is
-- master data, not a booking — dropping it never touches the append-only
-- history.
-- Setting `geaendert_am = now()` on the emptied rows is mandatory: the sync
-- snapshot only ships rows with `geaendert_am > lastPullAt`, so without the
-- bump every client would keep its ghost barcode forever.
--
-- Step 2: partial unique index. `barcode IS NOT NULL` alone is not enough —
-- older clients wrote empty strings, and those would collide with each other.

WITH dups AS (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY barcode
               ORDER BY geaendert_am DESC, erstellt_am DESC, id
           ) AS rn
    FROM artikel
    WHERE barcode IS NOT NULL AND barcode <> ''
)
UPDATE artikel a
SET barcode = NULL,
    geaendert_am = now()
FROM dups d
WHERE a.id = d.id
  AND d.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS artikel_barcode_uniq_idx
    ON artikel (barcode)
    WHERE barcode IS NOT NULL AND barcode <> '';
