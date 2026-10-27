// CSV import pipeline for Akkutausch devices.
//
// Devices are stored locally in Dexie and pushed through the normal outbox
// pipeline. The import intentionally runs a full pre-flight before touching
// IndexedDB, because half-imported rows would otherwise only be cleaned up by
// a database reset.
//
// Device identity is natural: `anlage + objekt + name`. Re-importing the same
// CSV therefore updates matching rows instead of creating duplicates.

import { getDb } from '../../db/database'
import { faelligkeit } from '../../domain/akkutausch/berechnung'
import type { Netzteil } from '../../domain/akkutausch/types'
import { jetztIso, neueUuid } from '../../domain/ids'
import { ImportValidierungError } from '../../domain/errors'
import { queueOp } from '../sync/worker'
import type { NetzteilFeld, NetzteilMapping } from './netzteil-mapping'
import {
  PFLICHT_NETZTEIL_FELDER,
  netzteilIdFuerSchluessel,
  netzteilSchluessel,
  normalisierterText,
  parseNetzteilDatum,
  parseNetzteilKapazitaet,
  parsePositiveInt,
  parseIntervallJahre,
  pflichtText,
} from './netzteil-mapping'
import type { ValidierungsErgebnis, ValidierungsProblem } from './validierung'

export interface NetzteilImportBericht {
  netzteilAngelegt: number
  netzteilAktualisiert: number
  netzteilUebersprungen: number
  warnungen: string[]
  konflikte: string[]
}

export interface NetzteilImportEingabe {
  rows: string[][]
  headers: string[]
  mapping: NetzteilMapping
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

/** Checks the selected mapping and every row before any write happens. */
export function validiereNetzteilDaten(
  mapping: NetzteilMapping,
  rows: string[][],
  headers: string[],
): ValidierungsErgebnis {
  const probleme: ValidierungsProblem[] = []
  const headerByFeld = new Map<NetzteilFeld, string[]>()

  for (const header of headers) {
    const feld = mapping[header]
    if (!feld) continue
    headerByFeld.set(feld, [...(headerByFeld.get(feld) ?? []), header])
  }

  for (const feld of PFLICHT_NETZTEIL_FELDER) {
    if (!headerByFeld.has(feld)) {
      probleme.push({
        zeile: -1,
        meldung: `Pflichtfeld "${feld}" ist nicht gemappt.`,
      })
    }
  }

  for (const [feld, mapped] of headerByFeld) {
    if (mapped.length > 1) {
      probleme.push({
        zeile: -1,
        meldung: `Feld "${feld}" ist mehrfach gemappt: ${mapped.join(', ')}.`,
      })
    }
  }

  const seen = new Set<string>()

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (!row) continue

    const anlage = pflichtText(wertInSpalte(row, headers, mapping, 'anlage'))
    const objekt = pflichtText(wertInSpalte(row, headers, mapping, 'objekt'))
    const name = pflichtText(wertInSpalte(row, headers, mapping, 'name'))
    const datum = parseNetzteilDatum(wertInSpalte(row, headers, mapping, 'einbaudatum'))
    const intervallJahre = parseIntervallJahre(
      wertInSpalte(row, headers, mapping, 'intervallJahre'),
    )
    const kapazitaetAh = parseNetzteilKapazitaet(
      wertInSpalte(row, headers, mapping, 'kapazitaetAh'),
    )
    const anzahl = parsePositiveInt(wertInSpalte(row, headers, mapping, 'anzahl'))

    pruefePflichtText(probleme, i, 'anlage', anlage)
    pruefePflichtText(probleme, i, 'objekt', objekt)
    pruefePflichtText(probleme, i, 'name', name)

    if (datum === null) {
      probleme.push({
        zeile: i,
        spalte: spalteFuerFeld(headers, mapping, 'einbaudatum'),
        meldung: `Zeile ${i + 2}: "einbaudatum" ist ungültig (erwartet MM/JJJJ, TT.MM.JJJJ oder YYYY-MM-DD).`,
      })
    }

    if (intervallJahre === null) {
      probleme.push({
        zeile: i,
        spalte: spalteFuerFeld(headers, mapping, 'intervallJahre'),
        meldung: `Zeile ${i + 2}: "intervallJahre" muss mindestens 1 Jahr sein.`,
      })
    }

    if (kapazitaetAh === null) {
      probleme.push({
        zeile: i,
        spalte: spalteFuerFeld(headers, mapping, 'kapazitaetAh'),
        meldung: `Zeile ${i + 2}: "kapazitaetAh" muss > 0 sein.`,
      })
    }

    if (anzahl === null) {
      probleme.push({
        zeile: i,
        spalte: spalteFuerFeld(headers, mapping, 'anzahl'),
        meldung: `Zeile ${i + 2}: "anzahl" muss eine Ganzzahl ≥ 1 sein.`,
      })
    }

    if (anlage && objekt && name) {
      const schluessel = netzteilSchluessel(anlage, objekt, name)
      if (seen.has(schluessel)) {
        probleme.push({
          zeile: i,
          meldung: `Zeile ${i + 2}: doppelte Netzteil-Identität (${anlage} / ${objekt} / ${name}).`,
        })
      }
      seen.add(schluessel)
    }

    if (datum && intervallJahre) {
      const faelligCsvRoh = wertInSpalte(row, headers, mapping, 'faelligkeit')
      if (faelligCsvRoh.trim()) {
        const faelligCsv = parseNetzteilDatum(faelligCsvRoh)
        const erwartet = faelligkeit(datum, intervallJahre)
        if (faelligCsv === null || (erwartet !== null && faelligCsv !== erwartet)) {
          probleme.push({
            zeile: i,
            spalte: spalteFuerFeld(headers, mapping, 'faelligkeit'),
            meldung: `Zeile ${i + 2}: "faelligkeit" passt nicht zu Einbaudatum plus Intervall.`,
          })
        }
      }
    }
  }

  return { ok: probleme.length === 0, probleme }
}

/** Imports devices into Dexie and queues each changed row for sync. */
export async function importNetzteileAusCsv(
  eingabe: NetzteilImportEingabe,
): Promise<NetzteilImportBericht> {
  const validierung = validiereNetzteilDaten(eingabe.mapping, eingabe.rows, eingabe.headers)
  if (!validierung.ok) {
    throw new ImportValidierungError(
      `CSV: ${validierung.probleme.length} Daten-Problem(e) — Import abgebrochen.`,
      validierung.probleme,
    )
  }

  const db = getDb()
  const bericht: NetzteilImportBericht = {
    netzteilAngelegt: 0,
    netzteilAktualisiert: 0,
    netzteilUebersprungen: 0,
    warnungen: [],
    konflikte: [],
  }

  await db.transaction('rw', [db.akkuNetzteile, db.outbox, db.auditLog], async () => {
    const index = new Map<string, Netzteil>()
    for (const netzteil of await db.akkuNetzteile.toArray()) {
      index.set(netzteilSchluessel(netzteil.anlage, netzteil.objekt, netzteil.name), netzteil)
    }

    for (let i = 0; i < eingabe.rows.length; i++) {
      const row = eingabe.rows[i]
      if (!row) continue

      const daten = leseNetzteilZeile(row, eingabe.headers, eingabe.mapping)
      const schluessel = netzteilSchluessel(daten.anlage, daten.objekt, daten.name)
      const bestehend = index.get(schluessel)

      const faelligCsvRoh = wertInSpalte(row, eingabe.headers, eingabe.mapping, 'faelligkeit')
      if (faelligCsvRoh.trim()) {
        const faelligCsv = parseNetzteilDatum(faelligCsvRoh)
        const erwartet = faelligkeit(daten.einbaudatum, daten.intervallJahre)
        if (faelligCsv && erwartet && faelligCsv !== erwartet) {
          bericht.warnungen.push(
            `Zeile ${i + 2}: Fälligkeit weicht ab — importiert ${faelligCsv}, berechnet ${erwartet}.`,
          )
        }
      }

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
        warnungen: bericht.warnungen.length,
        konflikte: bericht.konflikte.length,
      }),
      zeit: jetztIso(),
    })
  })

  return bericht
}

function leseNetzteilZeile(
  row: string[],
  headers: string[],
  mapping: NetzteilMapping,
): NetzteilImportDaten {
  const anlage = pflichtText(wertInSpalte(row, headers, mapping, 'anlage'))
  const objekt = pflichtText(wertInSpalte(row, headers, mapping, 'objekt'))
  const name = pflichtText(wertInSpalte(row, headers, mapping, 'name'))
  const einbaudatum = parseNetzteilDatum(wertInSpalte(row, headers, mapping, 'einbaudatum'))
  const intervallJahre = parseIntervallJahre(wertInSpalte(row, headers, mapping, 'intervallJahre'))
  const kapazitaetAh = parseNetzteilKapazitaet(wertInSpalte(row, headers, mapping, 'kapazitaetAh'))
  const anzahl = parsePositiveInt(wertInSpalte(row, headers, mapping, 'anzahl'))

  if (!anlage || !objekt || !name) throw new Error('Pflichtfelder fehlen trotz Validierung.')
  if (einbaudatum === null) throw new Error(`Ungültiges Einbaudatum trotz Validierung: ${name}`)
  if (intervallJahre === null) throw new Error(`Ungültiges Intervall trotz Validierung: ${name}`)
  if (kapazitaetAh === null) throw new Error(`Ungültige Kapazität trotz Validierung: ${name}`)
  if (anzahl === null) throw new Error(`Ungültige Anzahl trotz Validierung: ${name}`)

  return {
    anlage,
    objekt,
    name,
    einbaudatum,
    intervallJahre,
    kapazitaetAh,
    anzahl,
    gruppe: normalisierterText(wertInSpalte(row, headers, mapping, 'gruppe')),
    plz: normalisierterText(wertInSpalte(row, headers, mapping, 'plz')),
    vdsAnerkennung: normalisierterText(wertInSpalte(row, headers, mapping, 'vdsAnerkennung')),
  }
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

function wertInSpalte(
  row: string[],
  headers: string[],
  mapping: NetzteilMapping,
  feld: NetzteilFeld,
): string {
  const header = spalteFuerFeld(headers, mapping, feld)
  if (!header) return ''
  const index = headers.indexOf(header)
  return index >= 0 ? (row[index] ?? '') : ''
}

function spalteFuerFeld(
  headers: string[],
  mapping: NetzteilMapping,
  feld: NetzteilFeld,
): string | undefined {
  return headers.find((header) => mapping[header] === feld)
}

function pruefePflichtText(
  probleme: ValidierungsProblem[],
  zeile: number,
  feld: NetzteilFeld,
  wert: string | null,
): void {
  if (wert) return
  probleme.push({
    zeile,
    meldung: `Zeile ${zeile + 2}: "${feld}" ist leer oder enthält nur ungültige Zeichen.`,
  })
}
