// CSV import pipeline for Akkutausch devices.
//
// Devices are stored locally in Dexie and pushed through the normal outbox
// pipeline.
//
// The import is deliberately tolerant: real exports contain rows with
// missing values, duplicated devices and unescaped semicolons inside text
// fields. Such rows must not abort the whole import:
//
//   * rows whose column count does not match the header are realigned when
//     the result is unambiguous (see `netzteil-reparatur.ts`), otherwise they
//     are skipped and reported;
//   * rows without battery data (capacity, date, interval) are skipped and
//     reported — the database does not allow NULL there;
//   * a missing "Anzahl" falls back to 1 and is reported as a note;
//   * devices that appear more than once in the file are merged — the last
//     complete row wins.
//
// Device identity is natural: `anlage + objekt + name`. Re-importing the same
// CSV therefore updates matching rows instead of creating duplicates.

import { getDb } from '../../db/database'
import { faelligkeit } from '../../domain/akkutausch/berechnung'
import type { Netzteil } from '../../domain/akkutausch/types'
import { jetztIso, neueUuid } from '../../domain/ids'
import { ImportValidierungError } from '../../domain/errors'
import { queueOp } from '../sync/worker'
import { reparereZeile, repariereGeklebtenHeader } from './netzteil-reparatur'
import type { NetzteilFeld, NetzteilMapping } from './netzteil-mapping'
import {
  KANONISCHE_NETZTEIL_HEADER,
  netzteilIdFuerSchluessel,
  netzteilSchluessel,
  normalisierterText,
  parseIntervallJahre,
  parseNetzteilDatum,
  parseNetzteilKapazitaet,
  parsePositiveInt,
  pflichtText,
} from './netzteil-mapping'
import type { ValidierungsProblem } from './validierung'

/** Columns that may contain free text (and therefore a stray semicolon). */
const TEXT_FELDER = new Set<NetzteilFeld>(['objekt', 'gruppe', 'name', 'vdsAnerkennung'])

/** Columns that must be mapped — the identity of a device. */
const PFLICHT_SPALTEN: NetzteilFeld[] = ['anlage', 'objekt', 'name']

/** A single finding about one CSV row. */
export interface NetzteilImportBefund {
  /** 0-based index of the row inside the data rows. */
  index: number
  /** Line number in the source file (header = line 1). */
  zeile: number
  /** Human-readable message. */
  meldung: string
  /** Kind of the finding. */
  art: 'repariert' | 'uebersprungen' | 'hinweis'
}

/** Pre-flight result shown before the import runs. */
export interface NetzteilImportPruefung {
  /** No blocking problem — the import can run. */
  ok: boolean
  /** Blocking problems (missing/ambiguous column mapping). */
  probleme: ValidierungsProblem[]
  /** Number of rows that will be imported. */
  importierbar: number
  /** Number of rows that will be skipped. */
  uebersprungen: number
  /** Rows that are importable but still miss battery data. */
  unvollstaendig: number
  /** Per-row findings (repairs, defaults, skips). */
  befunde: NetzteilImportBefund[]
}

export interface NetzteilImportBericht {
  netzteilAngelegt: number
  netzteilAktualisiert: number
  /** Existing devices that were already up to date. */
  netzteilUebersprungen: number
  /** CSV rows that could not be imported (no identity). */
  uebersprungeneZeilen: number
  /** CSV rows that were realigned before the import. */
  reparierteZeilen: number
  /** Imported devices that still miss battery data. */
  unvollstaendigeZeilen: number
  befunde: NetzteilImportBefund[]
  warnungen: string[]
  konflikte: string[]
}

export interface NetzteilImportEingabe {
  rows: string[][]
  headers: string[]
  mapping: NetzteilMapping
  /** Offset for the file line number (1 when the header line carried the first row). */
  zeilenOffset?: number
}

type NetzteilImportDaten = Pick<
  Netzteil,
  | 'anlage'
  | 'objekt'
  | 'name'
  | 'einbaudatum'
  | 'intervallJahre'
  | 'kapazitaetAh'
  | 'anzahl'
  | 'gruppe'
  | 'plz'
  | 'vdsAnerkennung'
>

interface NetzteilImportPlan {
  probleme: ValidierungsProblem[]
  zeilen: Array<{ index: number; zeile: number; daten: NetzteilImportDaten }>
  befunde: NetzteilImportBefund[]
}

/** A CSV that was prepared for the import (header repaired, rows aligned). */
export interface NetzteilCsvDaten {
  headers: string[]
  rows: string[][]
  /** Lines consumed by the header beyond the header itself (1 = glued first row). */
  zeilenOffset: number
  /** Note about a repair that was applied. */
  hinweis: string | null
}

/**
 * Prepares a parsed CSV for the import.
 *
 * Repairs a header line where the first data row was glued to the last
 * column name (`…;Fälligkeit10020_02;OKA …`) — such a file would otherwise
 * shift every column by one.
 */
export function bereiteNetzteilCsvAuf(headers: string[], rows: string[][]): NetzteilCsvDaten {
  const reparatur = repariereGeklebtenHeader(headers, rows, KANONISCHE_NETZTEIL_HEADER)
  if (!reparatur.ersteZeile) {
    return { headers, rows, zeilenOffset: 0, hinweis: reparatur.hinweis }
  }
  return {
    headers: reparatur.headers,
    rows: [reparatur.ersteZeile, ...rows],
    zeilenOffset: 1,
    hinweis: reparatur.hinweis,
  }
}

/**
 * Analyzes the CSV without writing anything: decides which rows are
 * importable, which are skipped and why.
 */
export function planeNetzteilImport(
  mapping: NetzteilMapping,
  rows: string[][],
  headers: string[],
  zeilenOffset = 0,
): NetzteilImportPlan {
  const probleme: ValidierungsProblem[] = []
  const befunde: NetzteilImportBefund[] = []
  const proSchluessel = new Map<
    string,
    { index: number; zeile: number; daten: NetzteilImportDaten }
  >()

  const gemappteFelder = new Set<NetzteilFeld>()
  for (const header of headers) {
    const feld = mapping[header]
    if (feld) gemappteFelder.add(feld)
  }

  for (const feld of PFLICHT_SPALTEN) {
    if (!gemappteFelder.has(feld)) {
      probleme.push({
        zeile: -1,
        meldung: `Pflichtspalte "${feld}" ist nicht gemappt.`,
      })
    }
  }

  const mehrfachGemappt = new Map<NetzteilFeld, string[]>()
  for (const header of headers) {
    const feld = mapping[header]
    if (!feld) continue
    mehrfachGemappt.set(feld, [...(mehrfachGemappt.get(feld) ?? []), header])
  }
  for (const [feld, mapped] of mehrfachGemappt) {
    if (mapped.length > 1) {
      probleme.push({
        zeile: -1,
        meldung: `Feld "${feld}" ist mehrfach gemappt: ${mapped.join(', ')}.`,
      })
    }
  }

  if (probleme.length > 0) return { probleme, zeilen: [], befunde }

  for (let index = 0; index < rows.length; index++) {
    const roh = rows[index] ?? []
    const zeile = index + 2 - zeilenOffset
    let zellen = roh

    if (zellen.length !== headers.length) {
      const reparatur = reparereZeile(
        zellen,
        headers.length,
        (kandidat) => bewerteReparaturKandidat(kandidat, headers, mapping),
        (spaltenIndex) => istTextspalte(spaltenIndex, headers, mapping),
      )
      if (!reparatur) {
        befunde.push({
          index,
          zeile,
          meldung: `Zeile ${zeile}: unerwartete Spaltenzahl (${zellen.length} statt ${headers.length}) — Zeile wird nicht importiert.`,
          art: 'uebersprungen',
        })
        continue
      }
      zellen = reparatur.zellen
      befunde.push({
        index,
        zeile,
        meldung: `Zeile ${zeile}: ${reparatur.hinweis}.`,
        art: 'repariert',
      })
    }

    const auswertung = werteAuswerten(zellen, headers, mapping)
    if (!auswertung.ok) {
      befunde.push({
        index,
        zeile,
        meldung: `Zeile ${zeile}: ${auswertung.grund} — Zeile wird nicht importiert.`,
        art: 'uebersprungen',
      })
      continue
    }

    for (const hinweis of auswertung.hinweise) {
      befunde.push({ index, zeile, meldung: `Zeile ${zeile}: ${hinweis}.`, art: 'hinweis' })
    }

    const schluessel = netzteilSchluessel(
      auswertung.daten.anlage,
      auswertung.daten.objekt,
      auswertung.daten.name,
    )
    const vorhanden = proSchluessel.get(schluessel)
    if (vorhanden) {
      befunde.push({
        index,
        zeile,
        meldung: `Zeile ${zeile}: gleiche Identität wie Zeile ${vorhanden.zeile} — die neuere Zeile ersetzt die ältere.`,
        art: 'hinweis',
      })
    }
    proSchluessel.set(schluessel, { index, zeile, daten: auswertung.daten })
  }

  const zeilen = [...proSchluessel.values()].sort((a, b) => a.index - b.index)
  return { probleme, zeilen, befunde }
}

/** Pre-flight for the UI: counts, blocking problems and per-row findings. */
export function pruefeNetzteilImport(
  mapping: NetzteilMapping,
  rows: string[][],
  headers: string[],
  zeilenOffset = 0,
): NetzteilImportPruefung {
  const plan = planeNetzteilImport(mapping, rows, headers, zeilenOffset)
  return {
    ok: plan.probleme.length === 0,
    probleme: plan.probleme,
    importierbar: plan.zeilen.length,
    uebersprungen: plan.befunde.filter((b) => b.art === 'uebersprungen').length,
    unvollstaendig: plan.zeilen.filter((z) => istUnvollstaendig(z.daten)).length,
    befunde: plan.befunde,
  }
}

/** Imports devices into Dexie and queues each changed row for sync. */
export async function importNetzteileAusCsv(
  eingabe: NetzteilImportEingabe,
): Promise<NetzteilImportBericht> {
  const plan = planeNetzteilImport(
    eingabe.mapping,
    eingabe.rows,
    eingabe.headers,
    eingabe.zeilenOffset ?? 0,
  )

  if (plan.probleme.length > 0) {
    throw new ImportValidierungError(
      `CSV: ${plan.probleme.length} Problem(e) — Import abgebrochen.`,
      plan.probleme,
    )
  }

  const db = getDb()
  const bericht: NetzteilImportBericht = {
    netzteilAngelegt: 0,
    netzteilAktualisiert: 0,
    netzteilUebersprungen: 0,
    uebersprungeneZeilen: plan.befunde.filter((b) => b.art === 'uebersprungen').length,
    reparierteZeilen: plan.befunde.filter((b) => b.art === 'repariert').length,
    unvollstaendigeZeilen: plan.zeilen.filter((z) => istUnvollstaendig(z.daten)).length,
    befunde: plan.befunde,
    warnungen: [],
    konflikte: [],
  }

  await db.transaction('rw', [db.akkuNetzteile, db.outbox, db.auditLog], async () => {
    const index = new Map<string, Netzteil>()
    for (const netzteil of await db.akkuNetzteile.toArray()) {
      index.set(netzteilSchluessel(netzteil.anlage, netzteil.objekt, netzteil.name), netzteil)
    }

    for (const zeile of plan.zeilen) {
      const daten = zeile.daten
      const schluessel = netzteilSchluessel(daten.anlage, daten.objekt, daten.name)
      const bestehend = index.get(schluessel)

      if (bestehend && !bestehend.geloescht && netzteilDatenGleich(bestehend, daten)) {
        bericht.netzteilUebersprungen++
        continue
      }

      const now = jetztIso()

      if (bestehend) {
        const aktualisiert: Netzteil = {
          ...bestehend,
          ...daten,
          geloescht: false,
          geaendertAm: now,
        }
        await db.akkuNetzteile.put(aktualisiert)
        await queueOp('akku_netzteil', 'update', aktualisiert)
        index.set(schluessel, aktualisiert)
        bericht.netzteilAktualisiert++
      } else {
        const neu: Netzteil = {
          id: netzteilIdFuerSchluessel(schluessel),
          ...daten,
          bemerkung: null,
          geloescht: false,
          erstelltAm: now,
          geaendertAm: now,
        }
        await db.akkuNetzteile.add(neu)
        await queueOp('akku_netzteil', 'create', neu)
        index.set(schluessel, neu)
        bericht.netzteilAngelegt++
      }
    }

    await db.auditLog.add({
      id: neueUuid(),
      aktion: 'csv-import.netzteile',
      entitaet: 'akku_netzteil',
      entitaetId: 'batch',
      daten: JSON.stringify({
        netzteilAngelegt: bericht.netzteilAngelegt,
        netzteilAktualisiert: bericht.netzteilAktualisiert,
        netzteilUebersprungen: bericht.netzteilUebersprungen,
        uebersprungeneZeilen: bericht.uebersprungeneZeilen,
        reparierteZeilen: bericht.reparierteZeilen,
        befunde: bericht.befunde.length,
      }),
      zeit: jetztIso(),
    })
  })

  return bericht
}

/**
 * True when the column may contain free text — only those columns may hold a
 * value that was split by an unescaped semicolon. Numeric and date columns
 * are never merged, otherwise the repair would produce plausible but wrong
 * data.
 */
function istTextspalte(spaltenIndex: number, headers: string[], mapping: NetzteilMapping): boolean {
  const header = headers[spaltenIndex]
  if (!header) return true
  const feld = mapping[header]
  if (!feld) return true
  return TEXT_FELDER.has(feld)
}

/**
 * Scores a candidate alignment of a ragged row.
 *
 * Returns `null` when the candidate is implausible — the identity fields
 * have to be present and every value that *is* present has to be parsable
 * (a shifted value like `2.5` in the date column is rejected). Otherwise
 * the score counts how plausible the optional fields look (postal code, due
 * date, date format), so the best alignment wins when several candidates
 * are technically parsable.
 */
function bewerteReparaturKandidat(
  zellen: string[],
  headers: string[],
  mapping: NetzteilMapping,
): number | null {
  const wert = (feld: NetzteilFeld): string => rohWert(zellen, headers, mapping, feld)

  const anlage = pflichtText(wert('anlage'))
  const objekt = pflichtText(wert('objekt'))
  const name = pflichtText(wert('name'))
  if (!anlage || !objekt || !name) return null

  // Values that are present have to be parsable — otherwise the columns are
  // shifted. Missing values are allowed (the device is imported incomplete).
  const datumRoh = wert('einbaudatum').trim()
  if (datumRoh !== '' && parseNetzteilDatum(datumRoh) === null) return null
  const intervallRoh = wert('intervallJahre').trim()
  if (intervallRoh !== '' && parseIntervallJahre(intervallRoh) === null) return null
  const kapazitaetRoh = wert('kapazitaetAh').trim()
  if (kapazitaetRoh !== '' && parseNetzteilKapazitaet(kapazitaetRoh) === null) return null
  const anzahlRoh = wert('anzahl').trim()
  if (anzahlRoh !== '' && parsePositiveInt(anzahlRoh) === null) return null

  let score = 0

  // Postal code: usually digits, sometimes empty — anything else is a sign
  // that the columns are shifted.
  const plz = wert('plz').trim()
  if (plz === '') score += 1
  else if (/^\d{4,10}$/.test(plz)) score += 2
  else score -= 2

  // Plant id: usually a number with a suffix (e.g. "10020_02").
  if (/\d/.test(anlage)) score += 1

  // Due date: has to match installation date plus interval.
  const einbaudatum = datumRoh === '' ? null : parseNetzteilDatum(datumRoh)
  const intervallJahre = intervallRoh === '' ? null : parseIntervallJahre(intervallRoh)
  const faelligCsv = wert('faelligkeit').trim()
  if (faelligCsv === '') score += 1
  else {
    const csv = parseNetzteilDatum(faelligCsv)
    const erwartet =
      einbaudatum !== null && intervallJahre !== null
        ? faelligkeit(einbaudatum, intervallJahre)
        : null
    if (csv !== null && erwartet !== null && csv === erwartet) score += 2
    else score -= 1
  }

  // Month/year notation is the most common format in these exports.
  if (/^\d{1,2}\/\d{4}$/.test(datumRoh)) score += 1

  return score
}

function werteAuswerten(
  zellen: string[],
  headers: string[],
  mapping: NetzteilMapping,
): { ok: true; daten: NetzteilImportDaten; hinweise: string[] } | { ok: false; grund: string } {
  const wert = (feld: NetzteilFeld): string => rohWert(zellen, headers, mapping, feld)
  const hinweise: string[] = []

  // Identity: without it the row cannot be assigned to a device at all.
  const anlage = pflichtText(wert('anlage'))
  const objekt = pflichtText(wert('objekt'))
  const name = pflichtText(wert('name'))
  if (!anlage || !objekt || !name) {
    return { ok: false, grund: '"Anlage", "Firma" oder "Name" fehlt' }
  }

  // Battery data: optional. Missing or unparsable values are stored as
  // `null` — the device is imported incomplete and can be completed later.
  const fehlend: string[] = []
  const ungueltig: string[] = []

  const datumRoh = wert('einbaudatum').trim()
  const einbaudatum = datumRoh === '' ? null : parseNetzteilDatum(datumRoh)
  if (einbaudatum === null) {
    ;(datumRoh === '' ? fehlend : ungueltig).push('Einbaudatum')
  }

  const intervallRoh = wert('intervallJahre').trim()
  const intervallJahre = intervallRoh === '' ? null : parseIntervallJahre(intervallRoh)
  if (intervallJahre === null) {
    ;(intervallRoh === '' ? fehlend : ungueltig).push('Austauschintervall')
  }

  const kapazitaetRoh = wert('kapazitaetAh').trim()
  const kapazitaetAh = kapazitaetRoh === '' ? null : parseNetzteilKapazitaet(kapazitaetRoh)
  if (kapazitaetAh === null) {
    ;(kapazitaetRoh === '' ? fehlend : ungueltig).push('Kapazität')
  }

  const anzahlRoh = wert('anzahl').trim()
  const anzahl = anzahlRoh === '' ? null : parsePositiveInt(anzahlRoh)
  if (anzahl === null) {
    ;(anzahlRoh === '' ? fehlend : ungueltig).push('Anzahl der Akkus')
  }

  if (fehlend.length + ungueltig.length > 0) {
    const felder = [...fehlend, ...ungueltig.map((f) => `${f} (ungültig)`)].join(', ')
    hinweise.push(`unvollständig: ${felder} fehlt — bitte im Geräte-Tab nachtragen`)
  }

  const faelligCsvRoh = wert('faelligkeit').trim()
  if (faelligCsvRoh && einbaudatum && intervallJahre) {
    const faelligCsv = parseNetzteilDatum(faelligCsvRoh)
    const erwartet = faelligkeit(einbaudatum, intervallJahre)
    if (faelligCsv === null) {
      hinweise.push(`"Fälligkeit" (${faelligCsvRoh}) ist ungültig — berechnet wurde ${erwartet}`)
    } else if (erwartet !== null && faelligCsv !== erwartet) {
      hinweise.push(`"Fälligkeit" weicht ab (${faelligCsv}) — berechnet wurde ${erwartet}`)
    }
  }

  return {
    ok: true,
    hinweise,
    daten: {
      anlage,
      objekt,
      name,
      einbaudatum,
      intervallJahre,
      kapazitaetAh,
      anzahl,
      gruppe: normalisierterText(wert('gruppe')),
      plz: normalisierterText(wert('plz')),
      vdsAnerkennung: normalisierterText(wert('vdsAnerkennung')),
    },
  }
}

function rohWert(
  zellen: string[],
  headers: string[],
  mapping: NetzteilMapping,
  feld: NetzteilFeld,
): string {
  const header = headers.find((h) => mapping[h] === feld)
  if (!header) return ''
  const index = headers.indexOf(header)
  return index >= 0 ? (zellen[index] ?? '') : ''
}

/** True when the device still misses battery data. */
function istUnvollstaendig(daten: NetzteilImportDaten): boolean {
  return (
    daten.einbaudatum === null ||
    daten.intervallJahre === null ||
    daten.kapazitaetAh === null ||
    daten.anzahl === null
  )
}

function netzteilDatenGleich(bestehend: Netzteil, daten: NetzteilImportDaten): boolean {
  return (
    bestehend.anlage === daten.anlage &&
    bestehend.objekt === daten.objekt &&
    bestehend.name === daten.name &&
    bestehend.einbaudatum === daten.einbaudatum &&
    bestehend.intervallJahre === daten.intervallJahre &&
    bestehend.kapazitaetAh === daten.kapazitaetAh &&
    bestehend.anzahl === daten.anzahl &&
    bestehend.gruppe === daten.gruppe &&
    bestehend.plz === daten.plz &&
    bestehend.vdsAnerkennung === daten.vdsAnerkennung
  )
}
