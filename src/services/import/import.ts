// CSV-Import-Pipeline für Artikel-Stammdaten.
//
// Ein Eintrittspunkt:
//   - importArtikelAusCsv(...)   – nur Stammdaten (eine CSV-Datei)
//
// Bewegungen/Buchungen werden nicht aus einer CSV importiert —
// sie entstehen in der App über die Buchungs-UI oder per Sync.

import { getDb } from '../../db/database'
import type { Artikel } from '../../db/types'
import { neueUuid, jetztIso } from '../../domain/ids'
import { ImportValidierungError } from '../../domain/errors'
import { queueOp } from '../sync/worker'
import type { ArtikelMapping } from './mapping'
import {
  normalizeArtikelStatus,
  normalizeNachbestellHinweis,
  parseInt0,
  parseIntOrNull,
  parseIsoDatum,
} from './mapping'
import { validiereArtikelDaten } from './validierung'

export interface ImportBericht {
  artikelAngelegt: number
  buchungenAngelegt: number
  konflikte: string[]
}

export interface ArtikelImportEingabe {
  rows: string[][]
  headers: string[]
  mapping: ArtikelMapping
}

/** Importiert Artikel-Stammdaten aus einer CSV-Datei. */
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
      `CSV: ${datenPruefung.probleme.length} Daten-Problem(e) — Import abgebrochen.`,
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
    // Importierte Artikel starten als "neu" (Etiketten-Druck) — sie haben
    // noch kein Etikett bekommen.
    etikettenNeu: true,
    listenpreis: parseIntOrNull(feld('listenpreis')),
    einkaufspreis: null,
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
