// Validierung für den CSV-Import (Artikel-Stammdaten): prüft Mapping-
// Vollständigkeit, Pflichtfelder, Enum-Werte, sharePointId-Duplikate.
//
// Zwei Stufen:
//   1) validiereArtikelMapping — Schema-Voll­ständigkeit (Pflichtfelder
//      gemappt? Werte in den Pflichtzeilen befüllt? sharePointId-Duplikate?).
//   2) validiereArtikelDaten — Dry-Run pro Zeile: wirft der Server-
//      Push-Schema einen Fehler, wenn wir die Zeile so uebernehmen?
//      Konkret: leerer `status`-Fremdwert, nicht parsebares `geaendertAm`,
//      leere/ungueltige `verpackungseinheit`, … Diese Stufe deckt den
//      Klassiker ab, dass eine Spalte fehlt oder leer ist und der Outbox-
//      Payload dadurch ungueltig wird (siehe `import.ts` `mappeArtikelZeile`
//      — der Fallback ist eine Notbremse, die Validierung ist der
//      Frueh-Warnung).

import type { ArtikelFeld, ArtikelMapping } from './mapping'
import { ARTIKEL_STATUS_WERTE, parseInt0, parseIsoDatum } from './mapping'

export interface ValidierungsProblem {
  /** Zeilenindex in der Quelldatei (0-basiert, ohne Header). */
  zeile: number
  /** Spaltenname aus der CSV. */
  spalte?: string
  /** Problembeschreibung. */
  meldung: string
}

export interface ValidierungsErgebnis {
  ok: boolean
  probleme: ValidierungsProblem[]
}

/** Pflichtfelder, die in der CSV gemappt sein müssen. */
const PFLICHT_ARTIKEL: ArtikelFeld[] = ['titel', 'typ']

export function validiereArtikelMapping(
  mapping: ArtikelMapping,
  rows: string[][],
  headers: string[],
): ValidierungsErgebnis {
  const probleme: ValidierungsProblem[] = []

  for (const pf of PFLICHT_ARTIKEL) {
    const gefunden = (Object.values(mapping) as Array<ArtikelFeld | null | undefined>).includes(pf)
    if (!gefunden) {
      probleme.push({
        zeile: -1,
        meldung: `Pflichtfeld "${pf}" ist nicht gemappt.`,
      })
    }
  }

  // Zeilenprüfung: Titel und Typ müssen befüllt sein.
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (!row) continue
    for (const h of headers) {
      const feld = mapping[h]
      if (!feld) continue
      if (feld === 'titel' || feld === 'typ') {
        const v = row[headers.indexOf(h)] ?? ''
        if (!v.trim()) {
          probleme.push({
            zeile: i,
            spalte: h,
            meldung: `Pflichtfeld "${feld}" ist in Zeile ${i + 2} leer.`,
          })
        }
      }
    }
  }

  // sharePointId-Duplikate.
  const seen = new Set<number>()
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (!row) continue
    const headerId = headers.find((h) => mapping[h] === 'sharePointId')
    if (!headerId) continue
    const raw = row[headers.indexOf(headerId)] ?? ''
    const id = Number.parseInt(raw, 10)
    if (!Number.isFinite(id)) continue
    if (seen.has(id)) {
      probleme.push({
        zeile: i,
        spalte: headerId,
        meldung: `Doppelte sharePointId ${id} in Zeile ${i + 2}.`,
      })
    }
    seen.add(id)
  }

  return { ok: probleme.length === 0, probleme }
}

// ---------- Daten-Validierung (Dry-Run pro Zeile) ----------
//
// Diese Stufe simuliert, was `mappeArtikelZeile` aus jeder Zeile machen
// wuerde, und meldet Felder, deren Wert zu einem Push-Fehler fuehren
// wuerde. So sehen wir Probleme VOR dem Import — der Outbox-Payload
// waere sonst zwar lokal ablegbar (die Dexie-Typen erlauben `null`),
// der Server-Sync wuerde aber mit `VALIDATION: expected string, received
// null` abbrechen.

/**
 * Pro Zeile: simuliert die Mapping-Funktion und meldet, wenn ein
 * gemappter Wert zu einem ungueltigen Outbox-Payload fuehren wuerde.
 * Pflicht-Mapping-Probleme (leerer Titel, …) gehoeren weiterhin in
 * `validiereArtikelMapping`.
 */
export function validiereArtikelDaten(
  mapping: ArtikelMapping,
  rows: string[][],
  headers: string[],
): ValidierungsErgebnis {
  const probleme: ValidierungsProblem[] = []

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (!row) continue

    // `status` muss zu einer gueltigen ArtikelStatus normalisierbar sein.
    const headerStatus = headers.find((h) => mapping[h] === 'status')
    if (headerStatus) {
      const raw = (row[headers.indexOf(headerStatus)] ?? '').trim()
      if (raw) {
        // Spiegel von normalizeArtikelStatus: was nicht matcht, faellt
        // dort still auf 'verfuegbar' zurueck. Wir wollen aber lieber
        // laut sein, statt still zu korrigieren — der CSV-Wert ist
        // moeglicherweise ein Tippfehler.
        const k = raw.toLowerCase()
        const ok =
          k === 'verfuegbar' ||
          k === 'verfügbar' ||
          k === 'reserviert' ||
          k === 'gesperrt' ||
          k === 'ausgesondert' ||
          k === 'ausgemustert' ||
          k === 'archiviert'
        if (!ok) {
          probleme.push({
            zeile: i,
            spalte: headerStatus,
            meldung: `Zeile ${i + 2}: unbekannter Status "${raw}" (erlaubt: ${ARTIKEL_STATUS_WERTE.join(', ')}).`,
          })
        }
      }
    }

    // `geaendertAm` muss parsebar sein. Wenn die Spalte gar nicht
    // gemappt ist, faellt der Import auf erstelltAm (now) zurueck —
    // das ist eine bewusste Notbremse und kein Fehler.
    const headerGeaendert = headers.find((h) => mapping[h] === 'geaendertAm')
    if (headerGeaendert) {
      const raw = (row[headers.indexOf(headerGeaendert)] ?? '').trim()
      if (raw && parseIsoDatum(raw) === null) {
        probleme.push({
          zeile: i,
          spalte: headerGeaendert,
          meldung: `Zeile ${i + 2}: "geaendertAm" "${raw}" ist kein gueltiges ISO-8601-Datum.`,
        })
      }
    }
    // Numerische Felder: nur `verpackungseinheit` ist am Server
    // `z.number().int().positive()` (required) — die anderen
    // (`mindestbestand`, `listenpreis`) sind am Server
    // `nullable().optional()` und werden im Import still auf `null`
    // gemappt, wenn sie unparsebar sind. Den Server-Payload wuerde das
    // also NICHT brechen — Validierung wuerde nur Rauschen erzeugen.
    const headerVe = headers.find((h) => mapping[h] === 'verpackungseinheit')
    if (headerVe) {
      const raw = (row[headers.indexOf(headerVe)] ?? '').trim()
      if (!raw) {
        probleme.push({
          zeile: i,
          spalte: headerVe,
          meldung: `Zeile ${i + 2}: "verpackungseinheit" ist leer (Pflichtfeld).`,
        })
      } else {
        const parsed = parseInt0(raw)
        if (parsed <= 0) {
          probleme.push({
            zeile: i,
            spalte: headerVe,
            meldung: `Zeile ${i + 2}: "verpackungseinheit" muss > 0 sein, ist ${parsed}.`,
          })
        }
      }
    }
  }

  return { ok: probleme.length === 0, probleme }
}
