// Tests für useArtikelStore.loeschen — der Delete-Pfad legt einen
// `artikel/delete`-Outbox-Op an und entfernt die Zeile aus der DB.
// Wir prüfen die atomare Transaktion und die outbox-Identität.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import 'fake-indexeddb/auto'
import { getDb, setDb } from '../../db/database'
import { clearLocalDbForTests } from '../../services/sync/reset-local-db'
import { useArtikelStore } from '../artikel'
import type { Artikel } from '../../db/types'

function artikelAnlegen(titel: string): Artikel {
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
    geaendertAm: '2026-10-19T12:00:00.000Z',
    erstelltAm: '2026-10-19T12:00:00.000Z',
  }
}

describe('useArtikelStore.loeschen', () => {
  beforeEach(async () => {
    await clearLocalDbForTests()
    setDb(getDb())
    setActivePinia(createPinia())
  })

  afterEach(async () => {
    await clearLocalDbForTests()
  })

  it('entfernt den Artikel aus der DB und legt einen delete-Outbox-Op an', async () => {
    const a = artikelAnlegen('Demo 1')
    await getDb().artikel.add(a)
    const outboxBefore = await getDb().outbox.count()
    expect(outboxBefore).toBe(0)

    const store = useArtikelStore()
    await store.loeschen(a.id)

    // DB-Eintrag weg
    const inDb = await getDb().artikel.get(a.id)
    expect(inDb).toBeUndefined()

    // Outbox-Op mit entity='artikel', op='delete' und payload = Artikel
    const outbox = await getDb().outbox.toArray()
    expect(outbox).toHaveLength(1)
    const op = outbox[0]!
    expect(op.entity).toBe('artikel')
    expect(op.op).toBe('delete')
    const payload = JSON.parse(op.payload) as Artikel
    expect(payload.id).toBe(a.id)
  })

  it('macht nichts, wenn die ID nicht existiert (idempotent)', async () => {
    const store = useArtikelStore()
    await store.loeschen('gibt-es-nicht')
    const outbox = await getDb().outbox.toArray()
    expect(outbox).toHaveLength(0)
  })
})
