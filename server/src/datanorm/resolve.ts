// DATANORM Pass 2: resolve.
//
// Pass 1 (parse-pass1.ts) collected every record into keyed maps. This pass
// joins them into one flat row per article, which is what gets persisted.
//
// Join rules per matchcode:
//   A                     → base record (title, prices, unit, group)
//   + B (v4)              → EAN (v4's A record has no room for it)
//   + B (v5, isDelete)    → deaktiviert = true (supplier withdrew it)
//   + D blocks            → description, lines sorted by laufendeNr
//   + T blocks (v5 style) → description, appended after D (T is often used
//                           as a cheaper D by suppliers)
//   + P records           → price overrides, applied in file order
//
// Everything is deterministic and idempotent: resolving the same collected
// data twice yields identical output, which is what makes re-importing a
// supplier's updated catalogue safe.

import type {
  AufgeloesterArtikel,
  GesammelteRecords,
  Parserfehler,
} from './types.js'

export interface ResolveErgebnis {
  artikel: AufgeloesterArtikel[]
  fehler: Parserfehler[]
}

/** Joins D records of one article, ordered by their line number. */
function baueBeschreibung(
  sammel: GesammelteRecords,
  matchcode: string,
): string | null {
  const teile: string[] = []

  const dBlock = sammel.descriptions.get(matchcode)
  if (dBlock && dBlock.length > 0) {
    const sortiert = [...dBlock].sort((a, b) => {
      // laufendeNr is a zero-padded string; numeric compare is what the
      // supplier intends. Fall back to line number for malformed entries.
      const na = Number.parseInt(a.laufendeNr, 10)
      const nb = Number.parseInt(b.laufendeNr, 10)
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
      return a.zeile - b.zeile
    })
    for (const d of sortiert) {
      if (d.text) teile.push(d.text)
    }
  }

  // v5 suppliers often use T in place of D, with the matchcode inline.
  const tBlock = sammel.texteNachMatchcode.get(matchcode)
  if (tBlock && tBlock.length > 0) {
    const sortiert = [...tBlock].sort((a, b) => {
      const na = Number.parseInt(a.laufendeNr ?? '', 10)
      const nb = Number.parseInt(b.laufendeNr ?? '', 10)
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
      return a.zeile - b.zeile
    })
    for (const t of sortiert) {
      if (t.text) teile.push(t.text)
    }
  }

  if (teile.length === 0) return null
  return teile.join('\n')
}

/**
 * Resolves collected records into flat rows ready for persistence.
 *
 * Price precedence: the A record is authoritative. P records only fill in
 * a price the A record left empty — this prevents a stale DATPREIS delta
 * from silently overwriting a full catalogue upload. (P records inside a
 * DATANORM.001 do usually represent a newer price, but we cannot tell
 * which file is newer, so the conservative rule is correct here.)
 */
export function loeseAuf(
  sammel: GesammelteRecords,
  onFortschritt?: (verarbeitet: number, gesamt: number) => void,
): ResolveErgebnis {
  const artikel: AufgeloesterArtikel[] = []
  const fehler: Parserfehler[] = []
  const gesamt = sammel.artikel.size
  let verarbeitet = 0

  for (const [matchcode, a] of sammel.artikel) {
    verarbeitet += 1

    // ---- v4: EAN lives in the B record, not in the A record ----
    let ean = a.ean
    const b = sammel.bRecords.get(matchcode)
    if (b) {
      if (b.ean) ean = b.ean
    }

    // ---- Price overrides from P records ----
    let preisNetto = a.preisNettoCent
    let preisBrutto = a.preisBruttoCent
    let gueltigAb = a.gueltigAb
    const preisRecords = sammel.preise.get(matchcode)
    if (preisRecords) {
      for (const rec of preisRecords) {
        for (const aenderung of rec.aenderungen) {
          if (aenderung.preisCent === null) continue
          // Fill only the gaps the A record left.
          if (preisNetto === null) preisNetto = aenderung.preisCent
          if (preisBrutto === null) preisBrutto = aenderung.preisCent
          if (gueltigAb === null) gueltigAb = aenderung.gueltigAb
        }
      }
    }

    // ---- Description from D and/or T blocks ----
    const beschreibung = baueBeschreibung(sammel, matchcode)

    // ---- v5 delete marker ----
    // The article stays in the catalogue, flagged as no longer available.
    // castel articles are never touched by this — that decision belongs to
    // the user in the PWA.
    const deaktiviert = b?.isDelete === true

    // A record without any title is unusable in the UI; fall back to the
    // matchcode so the admin at least sees the row in the report.
    const titel = a.kurztext !== '' ? a.kurztext : matchcode

    artikel.push({
      matchcode,
      ean,
      titel,
      beschreibung,
      mengeneinheit: a.mengeneinheit,
      preiseinheit: a.preiseinheit,
      inhalt: a.inhalt,
      warengruppe: a.warengruppe,
      preisNettoCent: preisNetto,
      preisBruttoCent: preisBrutto,
      preisAktionCent: a.preisAktionCent,
      gueltigAb,
      ersatzMatchcode: a.ersatzMatchcode,
      deaktiviert,
    })

    if (verarbeitet % 1000 === 0) onFortschritt?.(verarbeitet, gesamt)
  }

  // ---- P records for matchcodes that have no A record ----
  // Common when a supplier ships DATPREIS for items that were never in the
  // base catalogue. We report instead of silently dropping, so the admin
  // can decide whether to add the base catalogue.
  for (const matchcode of sammel.preise.keys()) {
    if (sammel.artikel.has(matchcode)) continue
    fehler.push({
      satzart: 'P',
      zeile: sammel.preise.get(matchcode)?.[0]?.zeile ?? 0,
      code: 'DATANORM_PREIS_OHNE_ARTIKEL',
      meldung: `Preisänderung für ${matchcode}, aber kein A-Satz (Artikelstammsatz) vorhanden — Preis wird ignoriert.`,
    })
  }

  // ---- B delete markers for matchcodes that have no A record ----
  for (const [matchcode, b] of sammel.bRecords) {
    if (sammel.artikel.has(matchcode)) continue
    if (b.isDelete) {
      fehler.push({
        satzart: 'B',
        zeile: b.zeile,
        code: 'DATANORM_DELETE_OHNE_ARTIKEL',
        meldung: `Löschhinweis für ${matchcode}, aber der Artikel ist nicht (mehr) in dieser Datei enthalten.`,
      })
    }
  }

  onFortschritt?.(gesamt, gesamt)
  return { artikel, fehler }
}