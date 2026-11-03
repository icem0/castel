// Tests für useArtikelStore.loeschen — der Delete-Pfad legt einen
// `artikel/delete`-Outbox-Op an und entfernt die Zeile aus der DB.
// Wir prüfen die atomare Transaktion und die outbox-Identität.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import 'fake-indexeddb/auto'
import { getDb, setDb } from '../../db/database'
import { clearLocalDbForTests } from '../../services/sync/reset-local-db'
import { BarcodeDuplikatError, useArtikelStore } from '../artikel'
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
    herstellerId: null,
    bestellstatus: 'offen',
    bestelltAm: null,
    bestelltVon: null,
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

describe('useArtikelStore — Barcode-Eindeutigkeit', () => {
  beforeEach(async () => {
    await clearLocalDbForTests()
    setDb(getDb())
    setActivePinia(createPinia())
  })

  afterEach(async () => {
    await clearLocalDbForTests()
  })

  it('lehnt einen neuen Artikel mit einem bereits vergebenen Barcode ab', async () => {
    const vorhanden = artikelAnlegen('Vorhanden')
    vorhanden.barcode = '4006381333931'
    await getDb().artikel.add(vorhanden)

    const store = useArtikelStore()
    await expect(
      store.anlegen({ titel: 'Neu', typ: 'Demo', barcode: '4006381333931' }),
    ).rejects.toBeInstanceOf(BarcodeDuplikatError)

    expect(await getDb().artikel.count()).toBe(1)
    expect(await getDb().outbox.count()).toBe(0)
  })

  it('lehnt ein Update ab, das einen fremden Barcode setzt', async () => {
    const store = useArtikelStore()
    await store.anlegen({ titel: 'A', typ: 'Demo', barcode: '1111111111111' })
    const b = await store.anlegen({ titel: 'B', typ: 'Demo' })

    await expect(store.aktualisieren(b.id, { barcode: '1111111111111' })).rejects.toBeInstanceOf(
      BarcodeDuplikatError,
    )

    expect((await getDb().artikel.get(b.id))?.barcode).toBeNull()
  })

  it('erlaubt dasselbe Barcode-Update, wenn der Artikel ihn bereits selbst hält', async () => {
    const store = useArtikelStore()
    const a = await store.anlegen({ titel: 'A', typ: 'Demo', barcode: '2222222222222' })
    await store.aktualisieren(a.id, { titel: 'A umbenannt', barcode: '2222222222222' })

    expect((await getDb().artikel.get(a.id))?.barcode).toBe('2222222222222')
  })

  it('normalisiert den Barcode beim Anlegen und Aktualisieren', async () => {
    const store = useArtikelStore()
    const a = await store.anlegen({ titel: 'A', typ: 'Demo', barcode: '  ' })
    expect((await getDb().artikel.get(a.id))?.barcode).toBeNull()

    await store.aktualisieren(a.id, { barcode: ' 3333333333333 ' })
    expect((await getDb().artikel.get(a.id))?.barcode).toBe('3333333333333')
  })
})
