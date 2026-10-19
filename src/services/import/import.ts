// CSV-Import-Pipeline.
//
// Drei Eintrittspunkte:
//   - importArtikelAusCsv(...)   – nur Stammdaten (Lager-CSV)
//   - importWarenAusCsv(...)     – nur Bewegungen (Warenfluss-CSV), Artikel müssen existieren
//   - importAusCsv(...)          – kombiniert beide in einer Transaktion (für Erstimport)
//
// Bei Validierungs-/Konfliktfehlern wird die jeweilige Transaktion zurückgerollt.

import { getDb } from '../../db/database'
import type { Artikel, Buchung } from '../../db/types'
import { neueUuid, jetztIso } from '../../domain/ids'
import { ImportValidierungError } from '../../domain/errors'
import { queueOp } from '../sync/worker'
import type { ArtikelMapping, WarenMapping } from './mapping'
import {
  normalizeArtikelStatus,
  normalizeNachbestellHinweis,
  normalizeWarenTyp,
  parseInt0,
  parseIntOrNull,
  parseIsoDatum,
} from './mapping'
import { validiereArtikelDaten, validiereWarenDaten } from './validierung'

export interface ImportBericht {
  artikelAngelegt: number
  buchungenAngelegt: number
  konflikte: string[]
}

interface ArtikelCacheEintrag {
  id: string
  sharePointId: number | null
  titelLower: string
}

export interface ArtikelImportEingabe {
  rows: string[][]
  headers: string[]
  mapping: ArtikelMapping
}

export interface WarenImportEingabe {
  rows: string[][]
  headers: string[]
  mapping: WarenMapping
  /** Name des Haupt-Standorts, an den Buchungen ohne Standort-Zuordnung gehen. */
  hauptLagerName: string
}

/**
 * Stellt sicher, dass der Haupt-Standort existiert und als Standard markiert ist.
 * Erwartet, innerhalb einer bereits laufenden `db.transaction('rw', [db.standorte, db.outbox, db.auditLog])` aufgerufen zu werden.
 * Enqueued die nötigen `create`/`update`-Ops in die Outbox, damit der Server-
 * Sync den Standort mitbekommt.
 */
async function stelleHauptLagerSicher(name: string): Promise<string> {
  const db = getDb()
  // Indexierter Zugriff auf `name` (Dexie v1+).
  const vorhanden = await db.standorte.where('name').equals(name).first()
  if (vorhanden) {
    if (!vorhanden.standard) {
      const now = jetztIso()
      await db.standorte.update(vorhanden.id, { standard: true, geaendertAm: now })
      const refreshed = await db.standorte.get(vorhanden.id)
      if (refreshed) await queueOp('standort', 'update', refreshed)
    }
    return vorhanden.id
  }
  const now = jetztIso()
  const neu = {
    id: neueUuid(),
    name,
    typ: 'lager' as const,
    projekt: null,
    kennzeichen: null,
    standard: true,
    archiviert: false,
    geaendertAm: now,
    erstelltAm: now,
  }
  await db.standorte.add(neu)
  await db.auditLog.add({
    id: neueUuid(),
    aktion: 'csv-import.lager-autocreate',
    entitaet: 'standort',
    entitaetId: neu.id,
    daten: JSON.stringify(neu),
    zeit: jetztIso(),
  })
  await queueOp('standort', 'create', neu)
  return neu.id
}

/** Importiert nur Artikel-Stammdaten aus einer Lager-CSV. */
export async function importArtikelAusCsv(e: ArtikelImportEingabe): Promise<ImportBericht> {
  // Pre-Flight: Dry-Run ueber jede Zeile. Wenn ein Wert zu einem
  // ungueltigen Outbox-Payload fuehren wuerde (z. B. ein nicht
  // parsebares geaendertAm, ein leerer Status, eine Dezimal-Menge),
  // brechen wir hier ab, BEVOR wir die Dexie-Transaktion starten —
  // sonst wuerde der Server-Push spaeter mit `VALIDATION` abbrechen
  // und der User haette einen halben Import-Zustand, der nur durch
  // DB-Reset aufzuraeumen ist.
  const datenPruefung = validiereArtikelDaten(e.mapping, e.rows, e.headers)
  if (!datenPruefung.ok) {
    throw new ImportValidierungError(
      `Lager-CSV: ${datenPruefung.probleme.length} Daten-Problem(e) — Import abgebrochen.`,
      datenPruefung.probleme,
    )
  }

  const db = getDb()
  const bericht: ImportBericht = {
    artikelAngelegt: 0,
    buchungenAngelegt: 0,
    konflikte: [],
  }

  await db.transaction('rw', [db.artikel, db.outbox, db.auditLog], async () => {
    for (let i = 0; i < e.rows.length; i++) {
      const row = e.rows[i]
      if (!row) continue
      const a: Artikel = mappeArtikelZeile(row, e.headers, e.mapping)
      const existierend =
        a.sharePointId != null
          ? await db.artikel.where('sharePointId').equals(a.sharePointId).first()
          : await db.artikel.where('titel').equals(a.titel).first()
      if (existierend) {
        bericht.konflikte.push(`Artikel "${a.titel}" existiert bereits (Zeile ${i + 2}).`)
        continue
      }
      await db.artikel.add(a)
      bericht.artikelAngelegt += 1
      await queueOp('artikel', 'create', a)
    }

    await db.auditLog.add({
      id: neueUuid(),
      aktion: 'csv-import.artikel',
      entitaet: 'artikel',
      entitaetId: 'batch',
      daten: JSON.stringify({
        artikelAngelegt: bericht.artikelAngelegt,
        konflikte: bericht.konflikte.length,
      }),
      zeit: jetztIso(),
    })
  })

  return bericht
}

/** Importiert nur Waren-Buchungen. Artikel müssen bereits existieren. */
export async function importWarenAusCsv(e: WarenImportEingabe): Promise<ImportBericht> {
  // Pre-Flight (siehe importArtikelAusCsv).
  const datenPruefung = validiereWarenDaten(e.mapping, e.rows, e.headers)
  if (!datenPruefung.ok) {
    throw new ImportValidierungError(
      `Warenfluss-CSV: ${datenPruefung.probleme.length} Daten-Problem(e) — Import abgebrochen.`,
      datenPruefung.probleme,
    )
  }

  const db = getDb()
  const bericht: ImportBericht = {
    artikelAngelegt: 0,
    buchungenAngelegt: 0,
    konflikte: [],
  }

  await db.transaction(
    'rw',
    [db.artikel, db.standorte, db.buchungen, db.outbox, db.auditLog],
    async () => {
      const fallbackStandortId = await stelleHauptLagerSicher(e.hauptLagerName)

      const artikelByTitle = new Map<string, ArtikelCacheEintrag>()
      const alle = await db.artikel.toArray()
      for (const a of alle) {
        const eintrag: ArtikelCacheEintrag = {
          id: a.id,
          sharePointId: a.sharePointId,
          titelLower: a.titel.toLowerCase(),
        }
        artikelByTitle.set(eintrag.titelLower, eintrag)
      }

      for (let i = 0; i < e.rows.length; i++) {
        const row = e.rows[i]
        if (!row) continue
        const b = mappeWarenZeile(row, e.headers, e.mapping, artikelByTitle, fallbackStandortId)
        if (!b) {
          const titelRaw = (() => {
            const h = e.headers.find((x) => e.mapping[x] === 'artikelTitle')
            return h ? (row[e.headers.indexOf(h)] ?? '').trim() : ''
          })()
          bericht.konflikte.push(`Zeile ${i + 2}: Artikel "${titelRaw}" nicht gefunden.`)
          continue
        }
        await db.buchungen.add(b)
        bericht.buchungenAngelegt += 1
        await queueOp('buchung', 'create', b)
      }

      await db.auditLog.add({
        id: neueUuid(),
        aktion: 'csv-import.waren',
        entitaet: 'buchung',
        entitaetId: 'batch',
        daten: JSON.stringify({
          buchungenAngelegt: bericht.buchungenAngelegt,
          konflikte: bericht.konflikte.length,
        }),
        zeit: jetztIso(),
      })
    },
  )

  return bericht
}

export interface ImportEingabe {
  artikel?: ArtikelImportEingabe
  waren?: WarenImportEingabe
}

/**
 * Kombi-Import: nimmt optional Artikel und/oder Waren entgegen.
 * Schreibt alles in einer Transaktion; bei Fehler vollständiger Rollback.
 * Wenn beide leer sind, ist der Aufruf ein No-op und liefert leeren Bericht.
 */
export async function importAusCsv(e: ImportEingabe): Promise<ImportBericht> {
  // Pre-Flight (siehe importArtikelAusCsv). Beide Pipelines
  // (Stammdaten + Bewegungen) werden getrennt geprueft, damit die
  // Fehlermeldung eindeutig zuordnet, welche CSV schuld ist.
  if (e.artikel) {
    const artikelPruefung = validiereArtikelDaten(
      e.artikel.mapping,
      e.artikel.rows,
      e.artikel.headers,
    )
    if (!artikelPruefung.ok) {
      throw new ImportValidierungError(
        `Lager-CSV: ${artikelPruefung.probleme.length} Daten-Problem(e) — Import abgebrochen.`,
        artikelPruefung.probleme,
      )
    }
  }
  if (e.waren) {
    const warenPruefung = validiereWarenDaten(e.waren.mapping, e.waren.rows, e.waren.headers)
    if (!warenPruefung.ok) {
      throw new ImportValidierungError(
        `Warenfluss-CSV: ${warenPruefung.probleme.length} Daten-Problem(e) — Import abgebrochen.`,
        warenPruefung.probleme,
      )
    }
  }

  const db = getDb()
  const bericht: ImportBericht = {
    artikelAngelegt: 0,
    buchungenAngelegt: 0,
    konflikte: [],
  }
  if (!e.artikel && !e.waren) return bericht

  await db.transaction(
    'rw',
    [db.artikel, db.standorte, db.buchungen, db.outbox, db.auditLog],
    async () => {
      let fallbackStandortId: string | null = null
      if (e.waren) {
        fallbackStandortId = await stelleHauptLagerSicher(e.waren.hauptLagerName)
      }

      const artikelByTitle = new Map<string, ArtikelCacheEintrag>()

      if (e.artikel) {
        for (let i = 0; i < e.artikel.rows.length; i++) {
          const row = e.artikel.rows[i]
          if (!row) continue
          const a: Artikel = mappeArtikelZeile(row, e.artikel.headers, e.artikel.mapping)
          const existierend =
            a.sharePointId != null
              ? await db.artikel.where('sharePointId').equals(a.sharePointId).first()
              : await db.artikel.where('titel').equals(a.titel).first()
          if (existierend) {
            bericht.konflikte.push(`Artikel "${a.titel}" existiert bereits (Zeile ${i + 2}).`)
            continue
          }
          await db.artikel.add(a)
          bericht.artikelAngelegt += 1
          await queueOp('artikel', 'create', a)
          const eintrag: ArtikelCacheEintrag = {
            id: a.id,
            sharePointId: a.sharePointId,
            titelLower: a.titel.toLowerCase(),
          }
          artikelByTitle.set(eintrag.titelLower, eintrag)
        }
      }

      const vorhandene = await db.artikel.toArray()
      for (const a of vorhandene) {
        const eintrag: ArtikelCacheEintrag = {
          id: a.id,
          sharePointId: a.sharePointId,
          titelLower: a.titel.toLowerCase(),
        }
        if (!artikelByTitle.has(eintrag.titelLower)) {
          artikelByTitle.set(eintrag.titelLower, eintrag)
        }
      }

      if (e.waren && fallbackStandortId) {
        for (let i = 0; i < e.waren.rows.length; i++) {
          const row = e.waren.rows[i]
          if (!row) continue
          const b = mappeWarenZeile(
            row,
            e.waren.headers,
            e.waren.mapping,
            artikelByTitle,
            fallbackStandortId,
          )
          if (!b) {
            const titelRaw = (() => {
              if (!e.waren) return ''
              const h = e.waren.headers.find(
                (x) => e.waren && e.waren.mapping[x] === 'artikelTitle',
              )
              return h ? (row[e.waren.headers.indexOf(h)] ?? '').trim() : ''
            })()
            bericht.konflikte.push(`Zeile ${i + 2}: Artikel "${titelRaw}" nicht gefunden.`)
            continue
          }
          await db.buchungen.add(b)
          bericht.buchungenAngelegt += 1
          await queueOp('buchung', 'create', b)
        }
      }

      await db.auditLog.add({
        id: neueUuid(),
        aktion: 'csv-import.kombi',
        entitaet: 'artikel',
        entitaetId: 'batch',
        daten: JSON.stringify({
          artikelAngelegt: bericht.artikelAngelegt,
          buchungenAngelegt: bericht.buchungenAngelegt,
          konflikte: bericht.konflikte.length,
        }),
        zeit: jetztIso(),
      })
    },
  )

  return bericht
}

function mappeArtikelZeile(row: string[], headers: string[], mapping: ArtikelMapping): Artikel {
  const now = jetztIso()
  const feld = (name: string): string => {
    const h = headers.find((x) => mapping[x] === name)
    if (!h) return ''
    return row[headers.indexOf(h)] ?? ''
  }
  return {
    id: neueUuid(),
    sharePointId: parseInt0(feld('sharePointId')) || null,
    titel: feld('titel'),
    status: normalizeArtikelStatus(feld('status')),
    typ: feld('typ'),
    lieferant: feld('lieferant') || null,
    verpackungseinheit: parseInt0(feld('verpackungseinheit')) || 1,
    // Server-Schema verlangt z.number().int() — parseIntOrNull liefert
    // null bei Dezimalwerten, statt still zu runden.
    mindestbestand: parseIntOrNull(feld('mindestbestand')),
    nachbestellHinweis: normalizeNachbestellHinweis(feld('nachbestellHinweis')),
    bestellnummer: feld('bestellnummer') || null,
    barcode: feld('barcode') || null,
    listenpreis: parseIntOrNull(feld('listenpreis')),
    // Server-Push-Schema verlangt `geaendertAm: string` (kein null). Wenn
    // die CSV-Spalte fehlt oder leer ist, fallen wir auf `erstelltAm` (=
    // Import-Zeitpunkt) zurück — semantisch identisch zu einem frisch
    // angelegten Artikel, der noch nie geaendert wurde. Vorher konnte ein
    // leerer Wert als `null` durchrutschen und den Server-Push mit
    // `VALIDATION: expected string, received null` abbrechen lassen.
    geaendertAm: parseIsoDatum(feld('geaendertAm')) ?? now,
    erstelltAm: now,
  }
}

function mappeWarenZeile(
  row: string[],
  headers: string[],
  mapping: WarenMapping,
  artikelByTitle: Map<string, ArtikelCacheEintrag>,
  fallbackStandortId: string,
): Buchung | null {
  const feld = (name: string): string => {
    const h = headers.find((x) => mapping[x] === name)
    if (!h) return ''
    return row[headers.indexOf(h)] ?? ''
  }

  const titelRaw = feld('artikelTitle').trim()
  if (!titelRaw) return null
  const titelLower = titelRaw.toLowerCase()
  const eintrag = artikelByTitle.get(titelLower)
  if (!eintrag) return null

  const typ = normalizeWarenTyp(feld('typ'))
  // Server-Schema (z.number().int()) lehnt Dezimalmengen ab — parseIntOrNull
  // liefert null bei Nachkommastellen, und der Caller behandelt null als
  // ungültige Zeile (Konflikt-Report).
  const mengeRaw = parseIntOrNull(feld('menge'))
  if (mengeRaw === null || mengeRaw === 0) return null
  const mengeVorzeichen = typ === 'entnahme' ? -Math.abs(mengeRaw) : Math.abs(mengeRaw)

  return {
    id: neueUuid(),
    artikelId: eintrag.id,
    standortId: fallbackStandortId,
    standortZielId: null,
    typ,
    menge: mengeVorzeichen,
    paarId: null,
    // 'commission' ist der WarenFeld, auf den die SharePoint-Spalten
    // "Projekt-AA-SA-Nummer" / "projekt" gemappt werden. Ein feld('projekt')
    // würde nie matchen (kein WarenFeld heißt so) und stillschweigend
    // null liefern — Datenverlust.
    projekt: feld('commission') || null,
    erstelltAm: parseIsoDatum(feld('erstelltAm')) ?? jetztIso(),
    clientEingabeAm: jetztIso(),
    erstelltVon: feld('erstelltVon') || 'csv-import',
    kommentar: feld('kommentar') || null,
    mitteilungAn: feld('mitteilungAn') || null,
    stornoVon: null,
    storno: false,
    storniertDurch: null,
    serverId: null,
  }
}
