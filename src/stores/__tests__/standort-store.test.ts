// Tests für den Store `standort`:
//   * Umbenennen aendert den Namen lokal und queued einen `update`-Op.
//   * Umbenennen ist auch moeglich, wenn Buchungen auf den Standort zeigen
//     (der Server wertet `update` per LWW ohne Abhaengigkeits-Pruefung aus).
//   * Loeschen wird blockiert, wenn Buchungen verweisen — es entsteht kein
//     Outbox-Item, das der Server mit `HAS_DEPENDENCIES` in die Quarantaene
//     legen wuerde.
//   * Loeschen ohne Buchungen funktioniert und queued einen `delete`-Op.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import 'fake-indexeddb/auto'
import { getDb, setDb } from '../../db/database'
import { clearLocalDbForTests } from '../../services/sync/reset-local-db'
import { StandortHatBuchungenError, useStandortStore } from '../standort'
import type { Buchung, Standort } from '../../db/types'
import { jetztIso } from '../../domain/ids'

function standortAnlage(id: string, name: string, standard = false): Standort {
  const now = jetztIso()
  return {
    id,
    name,
    typ: 'lager',
    projekt: null,
    kennzeichen: null,
    standard,
    archiviert: false,
    geaendertAm: now,
    erstelltAm: now,
  }
}

function buchungsAnlage(
  id: string,
  standortId: string,
  standortZielId: string | null = null,
): Buchung {
  const now = jetztIso()
  return {
    id,
    artikelId: 'a-1',
    standortId,
    standortZielId,
    typ: standortZielId ? 'umlagerung' : 'einlagerung',
    menge: 5,
    paarId: null,
    projekt: null,
    erstelltAm: now,
    clientEingabeAm: now,
    erstelltVon: 'u1',
    kommentar: null,
    mitteilungAn: null,
    stornoVon: null,
    storno: false,
    storniertDurch: null,
    serverId: null,
  }
}

describe('useStandortStore', () => {
  beforeEach(async () => {
    await clearLocalDbForTests()
    setDb(getDb())
    setActivePinia(createPinia())
  })

  afterEach(async () => {
    await clearLocalDbForTests()
  })

  it('umbenennt lokal und queued einen update-Op', async () => {
    const store = useStandortStore()
    await getDb().standorte.add(standortAnlage('s-1', 'Altes Lager'))

    await store.umbenennen('s-1', 'Neues Lager')

    const row = await getDb().standorte.get('s-1')
    expect(row?.name).toBe('Neues Lager')

    const outbox = await getDb().outbox.toArray()
    expect(outbox).toHaveLength(1)
    expect(outbox[0]?.entity).toBe('standort')
    expect(outbox[0]?.op).toBe('update')
    expect(JSON.parse(outbox[0]?.payload ?? '{}')).toMatchObject({
      id: 's-1',
      name: 'Neues Lager',
    })
  })

  it('umbenennt auch dann, wenn Buchungen auf den Standort verweisen', async () => {
    const store = useStandortStore()
    await getDb().standorte.add(standortAnlage('s-1', 'Altes Lager'))
    await getDb().buchungen.add(buchungsAnlage('b-1', 's-1'))

    await expect(store.umbenennen('s-1', 'Neues Lager')).resolves.toBeUndefined()

    const row = await getDb().standorte.get('s-1')
    expect(row?.name).toBe('Neues Lager')
    const outbox = await getDb().outbox.toArray()
    expect(outbox.map((o) => o.op)).toEqual(['update'])
  })

  it('lehnt einen leeren Namen ab', async () => {
    const store = useStandortStore()
    await getDb().standorte.add(standortAnlage('s-1', 'Lager'))

    await expect(store.umbenennen('s-1', '   ')).rejects.toThrow()
    const row = await getDb().standorte.get('s-1')
    expect(row?.name).toBe('Lager')
    expect(await getDb().outbox.count()).toBe(0)
  })

  it('blockiert das Loeschen, wenn Buchungen auf den Standort verweisen', async () => {
    const store = useStandortStore()
    await getDb().standorte.add(standortAnlage('s-1', 'Lager'))
    await getDb().buchungen.add(buchungsAnlage('b-1', 's-1'))

    await expect(store.loeschen('s-1')).rejects.toBeInstanceOf(StandortHatBuchungenError)

    // Kein Outbox-Item — es darf kein doomed `delete` entstehen.
    expect(await getDb().outbox.count()).toBe(0)
    // Der Standort bleibt erhalten.
    expect(await getDb().standorte.get('s-1')).toBeDefined()
  })

  it('zaehlt auch Buchungen, bei denen der Standort das Um Lagerungsziel ist', async () => {
    const store = useStandortStore()
    await getDb().standorte.add(standortAnlage('s-1', 'Lager'))
    await getDb().buchungen.add(buchungsAnlage('b-1', 's-2', 's-1'))

    await expect(store.referenzierteBuchungen('s-1')).resolves.toBe(1)
    await expect(store.loeschen('s-1')).rejects.toBeInstanceOf(StandortHatBuchungenError)
  })

  it('loescht einen Standort ohne Buchungen und queued einen delete-Op', async () => {
    const store = useStandortStore()
    await getDb().standorte.add(standortAnlage('s-1', 'Lager'))

    await store.loeschen('s-1')

    expect(await getDb().standorte.get('s-1')).toBeUndefined()
    const outbox = await getDb().outbox.toArray()
    expect(outbox).toHaveLength(1)
    expect(outbox[0]?.entity).toBe('standort')
    expect(outbox[0]?.op).toBe('delete')
  })

  it('archiviert einen Standort mit Buchungen und queued einen update-Op', async () => {
    const store = useStandortStore()
    await getDb().standorte.add(standortAnlage('s-1', 'Lager'))
    await getDb().buchungen.add(buchungsAnlage('b-1', 's-1'))

    await store.archivieren('s-1')

    const row = await getDb().standorte.get('s-1')
    expect(row?.archiviert).toBe(true)
    const outbox = await getDb().outbox.toArray()
    expect(outbox.map((o) => o.op)).toEqual(['update'])
  })

  it('archiviert das Hauptlager nicht', async () => {
    const store = useStandortStore()
    await getDb().standorte.add(standortAnlage('s-1', 'Hauptlager', true))

    await expect(store.archivieren('s-1')).rejects.toThrow()
    expect(await getDb().outbox.count()).toBe(0)
  })
})
