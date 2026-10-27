// Tests für useArtikelStore.berechneEinkaufspreise — die Neuberechnung
// des Einkaufspreises aller Artikel eines Lieferanten, wenn sich dessen
// Ø-Rabatt ändert.
//
// EK = Listenpreis × (1 − Rabatt). Der Listenpreis liegt in Cent.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import 'fake-indexeddb/auto'
import { getDb, setDb } from '../../db/database'
import { clearLocalDbForTests } from '../../services/sync/reset-local-db'
import { useArtikelStore } from '../artikel'
import type { Artikel } from '../../db/types'

function artikelAnlegen(titel: string, over: Partial<Artikel> = {}): Artikel {
  return {
    id: `art-${titel}`,
    sharePointId: null,
    titel,
    status: 'verfuegbar',
    typ: 'Demo',
    lieferant: null,
    verpackungseinheit: 1,
    mindestbestand: null,
    nachbestellHinweis: null,
    bestellnummer: null,
    barcode: null,
    etikettenNeu: true,
    listenpreis: null,
    einkaufspreis: null,
    herstellerId: null,
    bestellstatus: 'offen',
    bestelltAm: null,
    bestelltVon: null,
    geaendertAm: '2026-10-19T12:00:00.000Z',
    erstelltAm: '2026-10-19T12:00:00.000Z',
    ...over,
  }
}

describe('useArtikelStore.berechneEinkaufspreise', () => {
  beforeEach(async () => {
    await clearLocalDbForTests()
    setDb(getDb())
    setActivePinia(createPinia())
  })

  afterEach(async () => {
    await clearLocalDbForTests()
  })

  it('berechnet den EK aller Artikel des Lieferanten neu', async () => {
    await getDb().artikel.add(artikelAnlegen('A', { herstellerId: 'h-1', listenpreis: 10000 }))
    await getDb().artikel.add(artikelAnlegen('B', { herstellerId: 'h-1', listenpreis: 2500 }))

    const store = useArtikelStore()
    const geaendert = await store.berechneEinkaufspreise('h-1', 20)

    expect(geaendert).toBe(2)
    expect((await getDb().artikel.get('art-A'))?.einkaufspreis).toBe(8000)
    expect((await getDb().artikel.get('art-B'))?.einkaufspreis).toBe(2000)
  })

  it('legt einen Outbox-Op je geändertem Artikel an', async () => {
    await getDb().artikel.add(artikelAnlegen('A', { herstellerId: 'h-1', listenpreis: 10000 }))

    const store = useArtikelStore()
    await store.berechneEinkaufspreise('h-1', 20)

    const outbox = await getDb().outbox.toArray()
    expect(outbox).toHaveLength(1)
    expect(outbox[0]?.entity).toBe('artikel')
    expect(outbox[0]?.op).toBe('update')
    const payload = JSON.parse(outbox[0]!.payload) as Artikel
    expect(payload.einkaufspreis).toBe(8000)
  })

  it('lässt Artikel anderer Lieferanten unberührt', async () => {
    await getDb().artikel.add(artikelAnlegen('A', { herstellerId: 'h-1', listenpreis: 10000 }))
    await getDb().artikel.add(artikelAnlegen('B', { herstellerId: 'h-2', listenpreis: 10000 }))

    const store = useArtikelStore()
    const geaendert = await store.berechneEinkaufspreise('h-1', 20)

    expect(geaendert).toBe(1)
    expect((await getDb().artikel.get('art-B'))?.einkaufspreis).toBeNull()
  })

  it('überspringt Artikel ohne Listenpreis', async () => {
    await getDb().artikel.add(artikelAnlegen('A', { herstellerId: 'h-1', listenpreis: null }))

    const store = useArtikelStore()
    const geaendert = await store.berechneEinkaufspreise('h-1', 20)

    expect(geaendert).toBe(0)
    expect((await getDb().artikel.get('art-A'))?.einkaufspreis).toBeNull()
  })

  it('schreibt keinen Op, wenn der EK schon stimmt', async () => {
    await getDb().artikel.add(
      artikelAnlegen('A', { herstellerId: 'h-1', listenpreis: 10000, einkaufspreis: 8000 }),
    )

    const store = useArtikelStore()
    const geaendert = await store.berechneEinkaufspreise('h-1', 20)

    expect(geaendert).toBe(0)
    expect(await getDb().outbox.count()).toBe(0)
  })
})
