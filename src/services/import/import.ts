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
import type { ArtikelMapping, WarenMapping } from './mapping'
import {
  normalizeArtikelStatus,
  normalizeNachbestellHinweis,
  normalizeWarenTyp,
  parseFloatOrNull,
  parseInt0,
  parseIsoDatum,
  parseMenge,
} from './mapping'

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
 * Erwartet, innerhalb einer bereits laufenden `db.transaction('rw', [..., db.standorte, ...])` aufgerufen zu werden.
 */
async function stelleHauptLagerSicher(name: string): Promise<string> {
  const db = getDb()
  // Indexierter Zugriff auf `name` (Dexie v1+).
  const vorhanden = await db.standorte.where('name').equals(name).first()
  if (vorhanden) {
    if (!vorhanden.standard) {
      await db.standorte.update(vorhanden.id, { standard: true })
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
  return neu.id
}

/** Importiert nur Artikel-Stammdaten aus einer Lager-CSV. */
export async function importArtikelAusCsv(e: ArtikelImportEingabe): Promise<ImportBericht> {
  const db = getDb()
  const bericht: ImportBericht = {
    artikelAngelegt: 0,
    buchungenAngelegt: 0,
    konflikte: [],
  }

  await db.transaction('rw', [db.artikel, db.auditLog], async () => {
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
  const db = getDb()
  const bericht: ImportBericht = {
    artikelAngelegt: 0,
    buchungenAngelegt: 0,
    konflikte: [],
  }

  await db.transaction('rw', [db.artikel, db.standorte, db.buchungen, db.auditLog], async () => {
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
  })

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
  const db = getDb()
  const bericht: ImportBericht = {
    artikelAngelegt: 0,
    buchungenAngelegt: 0,
    konflikte: [],
  }
  if (!e.artikel && !e.waren) return bericht

  await db.transaction('rw', [db.artikel, db.standorte, db.buchungen, db.auditLog], async () => {
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
            const h = e.waren.headers.find((x) => e.waren && e.waren.mapping[x] === 'artikelTitle')
            return h ? (row[e.waren.headers.indexOf(h)] ?? '').trim() : ''
          })()
          bericht.konflikte.push(`Zeile ${i + 2}: Artikel "${titelRaw}" nicht gefunden.`)
          continue
        }
        await db.buchungen.add(b)
        bericht.buchungenAngelegt += 1
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
  })

  return bericht
}

function mappeArtikelZeile(row: string[], headers: string[], mapping: ArtikelMapping): Artikel {
  const now = jetztIso()
  const feld = (name: string): string => {
    const h = headers.find((x) => mapping[x] === name)
    if (!h) return ''
    return row[headers.indexOf(h)] ?? ''
  }
  const foto = feld('foto') || null
  return {
    id: neueUuid(),
    sharePointId: parseInt0(feld('sharePointId')) || null,
    foto,
    fotoUrls: foto ? [foto] : [],
    titel: feld('titel'),
    status: normalizeArtikelStatus(feld('status')),
    typ: feld('typ'),
    lieferant: feld('lieferant') || null,
    verpackungseinheit: parseInt0(feld('verpackungseinheit')) || 1,
    mindestbestand: parseFloatOrNull(feld('mindestbestand')),
    nachbestellHinweis: normalizeNachbestellHinweis(feld('nachbestellHinweis')),
    bestellnummer: feld('bestellnummer') || null,
    barcode: feld('barcode') || null,
    listenpreis: parseFloatOrNull(feld('listenpreis')),
    geaendertAm: parseIsoDatum(feld('geaendertAm')),
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
  const mengeRaw = parseMenge(feld('menge'))
  if (!Number.isFinite(mengeRaw) || mengeRaw === 0) return null
  const mengeVorzeichen = typ === 'entnahme' ? -Math.abs(mengeRaw) : Math.abs(mengeRaw)

  return {
    id: neueUuid(),
    artikelId: eintrag.id,
    standortId: fallbackStandortId,
    standortZielId: null,
    typ,
    menge: mengeVorzeichen,
    paarId: null,
    projekt: feld('projekt') || null,
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
