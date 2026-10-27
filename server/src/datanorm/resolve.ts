// DATANORM Pass 2: resolve.
//
// Pass 1 (parse-pass1.ts) collected every record into keyed maps. This pass
// joins them into one flat row per article, which gets persisted.
//
// Join rules per article number:
//   A                     → base record (title, prices, unit, group)
//   + B (v4)              → EAN, matchcode, pack size, replacement article
//   + B/A "L" flag       → deaktiviert = true (supplier withdrew it)
//   + D blocks            → dimension text, lines sorted by line number
//   + T blocks            → long text, via the Langtextschlüssel of the A
//                           record (v4) or directly via the matchcode (v5)
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
 * Long text of an article, addressed by the Langtextschlüssel of its A
 * record (this is how v4 links an article to a T record).
 */
function baueLangtext(
  sammel: GesammelteRecords,
  langtextschluessel: string | null,
): string | null {
  if (!langtextschluessel) return null
  const block = sammel.texte.get(langtextschluessel)
  if (!block || block.length === 0) return null
  const sortiert = [...block].sort((a, b) => {
    const na = Number.parseInt(a.laufendeNr ?? '', 10)
    const nb = Number.parseInt(b.laufendeNr ?? '', 10)
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
    return a.zeile - b.zeile
  })
  const teile = sortiert.map((t) => t.text).filter((t) => t !== '')
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
    let ersatzMatchcode = a.ersatzMatchcode
    let warengruppe = a.warengruppe
    let inhalt = a.inhalt
    const b = sammel.bRecords.get(matchcode)
    if (b) {
      if (b.ean) ean = b.ean
      if (b.ersatzMatchcode) ersatzMatchcode = b.ersatzMatchcode
      if (!warengruppe && b.warengruppe) warengruppe = b.warengruppe
      if (inhalt === null && b.verpackungsmenge !== null) inhalt = b.verpackungsmenge
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
          if (aenderung.preisKennzeichen === 2) {
            if (preisNetto === null) preisNetto = aenderung.preisCent
          } else if (aenderung.preisKennzeichen === 1) {
            if (preisBrutto === null) preisBrutto = aenderung.preisCent
          } else {
            if (preisNetto === null) preisNetto = aenderung.preisCent
            if (preisBrutto === null) preisBrutto = aenderung.preisCent
          }
          if (gueltigAb === null) gueltigAb = aenderung.gueltigAb
        }
      }
    }

    // ---- Description from D and/or T blocks ----
    const beschreibung = baueBeschreibung(sammel, matchcode)

    // ---- Long text via the Langtextschlüssel of the A record ----
    const langtext = baueLangtext(sammel, a.langtextschluessel)
    const beschreibungVoll =
      [beschreibung, langtext].filter((t) => t !== null && t !== '').join('\n') || null

    // ---- Delete marker ----
    // The article stays in the catalogue, flagged as no longer available.
    // castel articles are never touched by this — that decision belongs to
    // the user in the PWA.
    const deaktiviert = a.isDelete === true || b?.isDelete === true

    // A record without any title is unusable in the UI; fall back to the
    // article number so the admin at least sees the row in the report.
    const titel = a.kurztext !== '' ? a.kurztext : matchcode

    artikel.push({
      matchcode,
      ean,
      titel,
      beschreibung: beschreibungVoll,
      mengeneinheit: a.mengeneinheit,
      preiseinheit: a.preiseinheit,
      inhalt,
      warengruppe,
      preisNettoCent: preisNetto,
      preisBruttoCent: preisBrutto,
      preisAktionCent: a.preisAktionCent,
      gueltigAb,
      ersatzMatchcode,
      deaktiviert,
    })

    if (verarbeitet % 1000 === 0) onFortschritt?.(verarbeitet, gesamt)
  }

  // ---- P records for article numbers that have no A record ----
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

  // ---- B delete markers for article numbers that have no A record ----
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
