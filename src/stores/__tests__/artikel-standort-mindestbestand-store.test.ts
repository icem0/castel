// Tests für den Store `artikelStandortMindestbestand`:
//   * Setzen legt eine Zeile an und erzeugt einen Outbox-Op (`create`).
//   * Erneutes Setzen erzeugt `update` (kein Duplikat).
//   * Wert 0 entfernt die Zeile (sparse) und erzeugt einen `delete`-Op.
//   * `wertFuer` liefert 0 fuer nicht konfigurierte Paare.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import 'fake-indexeddb/auto'
import { getDb, setDb } from '../../db/database'
import { clearLocalDbForTests } from '../../services/sync/reset-local-db'
import { useArtikelStandortMindestbestandStore } from '../artikelStandortMindestbestand'

/** Wartet, bis der liveQuery-Spiegel die Zeilen geliefert hat. */
async function warteAufSpiegel(
  store: ReturnType<typeof useArtikelStandortMindestbestandStore>,
): Promise<void> {
  for (let i = 0; i < 50 && !store.geladen; i++) {
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('useArtikelStandortMindestbestandStore', () => {
  beforeEach(async () => {
    await clearLocalDbForTests()
    setDb(getDb())
    setActivePinia(createPinia())
  })

  afterEach(async () => {
    await clearLocalDbForTests()
  })

  it('legt beim Setzen eine Zeile an und queued einen create-Op', async () => {
    const store = useArtikelStandortMindestbestandStore()
    await store.setzen('a-1', 's-1', 12)

    const row = await getDb().artikelStandortMindestbestaende.get(['a-1', 's-1'])
    expect(row).toMatchObject({ artikelId: 'a-1', standortId: 's-1', mindestbestand: 12 })

    const outbox = await getDb().outbox.toArray()
    expect(outbox).toHaveLength(1)
    expect(outbox[0]?.entity).toBe('artikel_standort_mindestbestand')
    expect(outbox[0]?.op).toBe('create')
    expect(JSON.parse(outbox[0]?.payload ?? '{}')).toMatchObject({
      artikelId: 'a-1',
      standortId: 's-1',
      mindestbestand: 12,
    })
  })

  it('queued beim erneuten Setzen ein update statt eines create', async () => {
    const store = useArtikelStandortMindestbestandStore()
    await store.setzen('a-1', 's-1', 12)
    await store.setzen('a-1', 's-1', 20)

    const outbox = await getDb().outbox.toArray()
    // Reihenfolge im Outbox-Index ist nicht garantiert — wir pruefen die
    // Ops als Menge und den Inhalt des update-Ops.
    expect(outbox.map((o) => o.op).sort()).toEqual(['create', 'update'])
    const update = outbox.find((o) => o.op === 'update')
    expect(JSON.parse(update?.payload ?? '{}')).toMatchObject({ mindestbestand: 20 })
    const row = await getDb().artikelStandortMindestbestaende.get(['a-1', 's-1'])
    expect(row?.mindestbestand).toBe(20)
  })

  it('entfernt die Zeile bei Wert 0 (sparse) und queued einen delete', async () => {
    const store = useArtikelStandortMindestbestandStore()
    await store.setzen('a-1', 's-1', 12)
    await store.setzen('a-1', 's-1', 0)

    const row = await getDb().artikelStandortMindestbestaende.get(['a-1', 's-1'])
    expect(row).toBeUndefined()

    const outbox = await getDb().outbox.toArray()
    expect(outbox.map((o) => o.op).sort()).toEqual(['create', 'delete'])
    const del = outbox.find((o) => o.op === 'delete')
    expect(del?.entity).toBe('artikel_standort_mindestbestand')
    expect(JSON.parse(del?.payload ?? '{}')).toMatchObject({
      artikelId: 'a-1',
      standortId: 's-1',
    })
  })

  it('wertFuer liefert 0 fuer nicht konfigurierte Paare', async () => {
    const store = useArtikelStandortMindestbestandStore()
    store.start()
    await store.setzen('a-1', 's-1', 12)
    await warteAufSpiegel(store)
    expect(store.wertFuer('a-1', 's-1')).toBe(12)
    expect(store.wertFuer('a-1', 's-2')).toBe(0)
    expect(store.wertFuer('a-2', 's-1')).toBe(0)
  })
})
