// Tests der Standortverwaltung:
//   * Umbenennen ueber den Inline-Dialog aendert den Namen und queued einen
//     `update`-Op.
//   * Umbenennen/Archivieren funktionieren auch dann, wenn bereits Buchungen
//     auf den Standort verweisen (der Server prueft Abhaengigkeiten nur beim
//     Loeschen).
//   * Loeschen mit referenzierenden Buchungen wird mit einer klaren Meldung
//     abgewiesen — es entsteht kein Outbox-Item fuer einen `delete`, den der
//     Server ohnehin mit `HAS_DEPENDENCIES` ablehnen wuerde.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import 'fake-indexeddb/auto'
import StandortListView from '../StandortListView.vue'
import { i18n } from '../../i18n'
import { getDb, resetDbForTests } from '../../db/database'
import { clearLocalDbForTests } from '../../services/sync/reset-local-db'
import type { Buchung, Standort } from '../../db/types'

function standortAnlegen(over: Partial<Standort> = {}): Standort {
  return {
    id: 's-1',
    name: 'Altes Lager',
    typ: 'lager',
    projekt: null,
    kennzeichen: null,
    standard: false,
    archiviert: false,
    geaendertAm: '2026-10-29T12:00:00.000Z',
    erstelltAm: '2026-10-29T12:00:00.000Z',
    ...over,
  }
}

function buchungsAnlegen(id: string, standortId: string): Buchung {
  const now = '2026-10-29T12:00:00.000Z'
  return {
    id,
    artikelId: 'a-1',
    standortId,
    standortZielId: null,
    typ: 'einlagerung',
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

async function setupView() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(StandortListView, { global: { plugins: [pinia, i18n] } })
  await flushPromises()
  // Die Stores lesen per liveQuery aus IndexedDB — der erste Tick braucht
  // einen Moment.
  await new Promise<void>((resolve) => setTimeout(resolve, 30))
  await flushPromises()
  return { wrapper }
}

function knopf(
  wrapper: {
    findAll: (s: string) => Array<{ text: () => string; trigger: (e: string) => Promise<unknown> }>
  },
  text: string,
) {
  return wrapper.findAll('button').find((b) => (b.text() ?? '').trim() === text)
}

describe('StandortListView — Umbenennen / Loeschen', () => {
  beforeEach(async () => {
    resetDbForTests()
    await clearLocalDbForTests()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await clearLocalDbForTests()
    resetDbForTests()
  })

  it('umbenennt einen Standort mit Buchungen ueber den Inline-Dialog', async () => {
    await getDb().standorte.add(standortAnlegen())
    await getDb().buchungen.add(buchungsAnlegen('b-1', 's-1'))
    const { wrapper } = await setupView()

    await knopf(wrapper as never, 'Umbenennen')?.trigger('click')
    await flushPromises()

    const feld = wrapper.get('input.umbenennen-input')
    await feld.setValue('Neues Lager')
    await knopf(wrapper as never, 'Neuer Name')?.trigger('click')
    await flushPromises()
    await new Promise<void>((resolve) => setTimeout(resolve, 30))
    await flushPromises()

    expect((await getDb().standorte.get('s-1'))?.name).toBe('Neues Lager')
    const outbox = await getDb().outbox.toArray()
    expect(outbox.map((o) => o.op)).toEqual(['update'])
    expect(JSON.parse(outbox[0]?.payload ?? '{}')).toMatchObject({ name: 'Neues Lager' })
    wrapper.unmount()
  })

  it('archiviert einen Standort mit Buchungen', async () => {
    await getDb().standorte.add(standortAnlegen())
    await getDb().buchungen.add(buchungsAnlegen('b-1', 's-1'))
    const { wrapper } = await setupView()

    await knopf(wrapper as never, 'Archivieren')?.trigger('click')
    await flushPromises()
    await new Promise<void>((resolve) => setTimeout(resolve, 30))
    await flushPromises()

    expect((await getDb().standorte.get('s-1'))?.archiviert).toBe(true)
    const outbox = await getDb().outbox.toArray()
    expect(outbox.map((o) => o.op)).toEqual(['update'])
    wrapper.unmount()
  })

  it('weist das Loeschen ab, wenn Buchungen auf den Standort verweisen', async () => {
    await getDb().standorte.add(standortAnlegen())
    await getDb().buchungen.add(buchungsAnlegen('b-1', 's-1'))
    const { wrapper } = await setupView()

    await knopf(wrapper as never, 'Löschen')?.trigger('click')
    await flushPromises()
    await new Promise<void>((resolve) => setTimeout(resolve, 30))
    await flushPromises()

    expect(wrapper.text()).toContain('1 Buchung(en) verweisen auf ihn')
    // Kein doomed delete-Op — der Server wuerde es mit HAS_DEPENDENCIES ablehnen.
    expect(await getDb().outbox.count()).toBe(0)
    expect(await getDb().standorte.get('s-1')).toBeDefined()
    wrapper.unmount()
  })

  it('loescht einen Standort ohne Buchungen', async () => {
    await getDb().standorte.add(standortAnlegen())
    const { wrapper } = await setupView()

    await knopf(wrapper as never, 'Löschen')?.trigger('click')
    await flushPromises()
    await new Promise<void>((resolve) => setTimeout(resolve, 30))
    await flushPromises()

    expect(await getDb().standorte.get('s-1')).toBeUndefined()
    const outbox = await getDb().outbox.toArray()
    expect(outbox.map((o) => o.op)).toEqual(['delete'])
    wrapper.unmount()
  })
})
