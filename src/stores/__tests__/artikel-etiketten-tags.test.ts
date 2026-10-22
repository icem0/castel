// Tests der Etiketten-Tags (Marker "neu" am Artikel).
//
// Der Marker ist ein mutables Stammdaten-Flag: er reist ueber den
// regulaeren Sync (Outbox-Op je Artikel) und ist server-seitig
// `NOT NULL DEFAULT TRUE`.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import 'fake-indexeddb/auto'
import { getDb } from '../../db/database'
import { clearLocalDbForTests } from '../../services/sync/reset-local-db'
import { useArtikelStore } from '../artikel'
import { etikettenIstNeu } from '../../domain/etiketten'

describe('etiketten-Tags', () => {
  beforeEach(async () => {
    await clearLocalDbForTests()
    setActivePinia(createPinia())
  })

  afterEach(async () => {
    await clearLocalDbForTests()
  })

  it('neue Artikel starten als "neu"', async () => {
    const store = useArtikelStore()
    const a = await store.anlegen({ titel: 'Schraube', typ: 'Material' })
    expect(a.etikettenNeu).toBe(true)
    expect(etikettenIstNeu(a)).toBe(true)
  })

  it('setzt den Marker fuer mehrere Artikel und legt je einen Outbox-Op an', async () => {
    const store = useArtikelStore()
    const a = await store.anlegen({ titel: 'A', typ: 'T' })
    const b = await store.anlegen({ titel: 'B', typ: 'T' })

    const geaendert = await store.markiereEtikettenNeu([a.id, b.id], false)
    expect(geaendert).toBe(2)

    const inDb = await getDb().artikel.get(a.id)
    expect(inDb?.etikettenNeu).toBe(false)
    expect(etikettenIstNeu(inDb!)).toBe(false)

    // Zwei create-Ops (von anlegen) + zwei update-Ops (von markieren)
    const outbox = await getDb().outbox.toArray()
    const updates = outbox.filter((o) => o.op === 'update')
    expect(updates).toHaveLength(2)
    const payload = JSON.parse(updates[0]!.payload) as { etikettenNeu: boolean }
    expect(payload.etikettenNeu).toBe(false)
  })

  it('ueberspringt Artikel, die den Zielwert schon haben', async () => {
    const store = useArtikelStore()
    const a = await store.anlegen({ titel: 'A', typ: 'T' })
    const vorher = await getDb().outbox.count()

    const geaendert = await store.markiereEtikettenNeu([a.id], true)
    expect(geaendert).toBe(0)
    expect(await getDb().outbox.count()).toBe(vorher)
  })

  it('aktualisiert den Aenderungszeitstempel (LWW)', async () => {
    const store = useArtikelStore()
    const a = await store.anlegen({ titel: 'A', typ: 'T' })
    const vorher = a.geaendertAm
    await store.markiereEtikettenNeu([a.id], false)
    const inDb = await getDb().artikel.get(a.id)
    expect(inDb?.geaendertAm).not.toBe(vorher)
  })

  it('setzt den Marker wieder auf "neu"', async () => {
    const store = useArtikelStore()
    const a = await store.anlegen({ titel: 'A', typ: 'T' })
    await store.markiereEtikettenNeu([a.id], false)
    const geaendert = await store.markiereEtikettenNeu([a.id], true)
    expect(geaendert).toBe(1)
    const inDb = await getDb().artikel.get(a.id)
    expect(inDb?.etikettenNeu).toBe(true)
  })

  it('ignoriert unbekannte IDs', async () => {
    const store = useArtikelStore()
    const geaendert = await store.markiereEtikettenNeu(['gibt-es-nicht'], false)
    expect(geaendert).toBe(0)
  })
})
