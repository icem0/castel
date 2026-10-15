// Tests für die Dexie-Schema-Migration v7 → v8.
// Hintergrund: Migration 0008 fuegt das `barcode`-Feld auf `artikel`
// hinzu. Wir muessen sicherstellen, dass bestehende Datensaetze nach
// dem Upgrade `barcode: null` haben und neue Eintraege das Feld
// mitschreiben koennen.

import { describe, expect, it } from 'vitest'
import 'fake-indexeddb/auto'
import { CastelDb, setDb } from './database'
import type { Artikel } from './types'
import { jetztIso, neueUuid } from '../domain/ids'

function buildArtikel(barcode: string | null): Artikel {
  const now = jetztIso()
  return {
    id: neueUuid(),
    sharePointId: null,
    foto: null,
    fotoUrls: [],
    titel: 'Testartikel',
    status: 'verfuegbar',
    typ: 'Test',
    lieferant: null,
    verpackungseinheit: 1,
    mindestbestand: null,
    nachbestellHinweis: null,
    bestellnummer: null,
    barcode,
    listenpreis: null,
    geaendertAm: now,
    erstelltAm: now,
  }
}

function freshDb(): CastelDb {
  const db = new CastelDb(`castel-v8-test-${Math.random().toString(36).slice(2)}`)
  setDb(db)
  return db
}

describe('Dexie v8 — barcode field', () => {
  it('persistiert barcode auf neu angelegten Artikeln', async () => {
    const db = freshDb()
    const a = buildArtikel('4006381333931')
    await db.artikel.add(a)
    const geladen = await db.artikel.get(a.id)
    expect(geladen?.barcode).toBe('4006381333931')
  })

  it('akzeptiert null als barcode (kein Pflichtfeld)', async () => {
    const db = freshDb()
    const a = buildArtikel(null)
    await db.artikel.add(a)
    const geladen = await db.artikel.get(a.id)
    expect(geladen?.barcode).toBeNull()
  })

  it('lookup ueber barcode-Index findet den Artikel', async () => {
    const db = freshDb()
    const a = buildArtikel('EAN-12345')
    const b = buildArtikel(null)
    await db.artikel.bulkAdd([a, b])
    const gefunden = await db.artikel.where('barcode').equals('EAN-12345').first()
    expect(gefunden?.id).toBe(a.id)
    expect(gefunden?.titel).toBe('Testartikel')
  })
})
