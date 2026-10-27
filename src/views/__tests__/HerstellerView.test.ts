// Tests der Lieferantenverwaltung: Ø-Rabatt pflegen und daraus die
// Einkaufspreise der Artikel neu berechnen.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import 'fake-indexeddb/auto'
import HerstellerView from '../HerstellerView.vue'
import { i18n } from '../../i18n'
import { getDb, resetDbForTests } from '../../db/database'
import { clearLocalDbForTests } from '../../services/sync/reset-local-db'
import type { Artikel, Hersteller } from '../../db/types'

function herstellerAnlegen(over: Partial<Hersteller> = {}): Hersteller {
  return {
    id: 'h-1',
    name: 'Muster GmbH',
    bestellEmail: null,
    bestellWebseite: null,
    rabattsatz: 0,
    geaendertAm: '2026-10-19T12:00:00.000Z',
    erstelltAm: '2026-10-19T12:00:00.000Z',
    ...over,
  }
}

function artikelAnlegen(over: Partial<Artikel> = {}): Artikel {
  return {
    id: 'art-1',
    sharePointId: null,
    titel: 'Schraube M6',
    status: 'verfuegbar',
    typ: 'Demo',
    lieferant: 'Muster GmbH',
    verpackungseinheit: 1,
    mindestbestand: null,
    nachbestellHinweis: null,
    bestellnummer: null,
    barcode: null,
    etikettenNeu: true,
    listenpreis: 10000,
    einkaufspreis: null,
    herstellerId: 'h-1',
    bestellstatus: 'offen',
    bestelltAm: null,
    bestelltVon: null,
    geaendertAm: '2026-10-19T12:00:00.000Z',
    erstelltAm: '2026-10-19T12:00:00.000Z',
    ...over,
  }
}

async function setupView() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(HerstellerView, { global: { plugins: [pinia, i18n] } })
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

describe('HerstellerView — Ø-Rabatt', () => {
  beforeEach(async () => {
    resetDbForTests()
    await clearLocalDbForTests()
  })

  afterEach(async () => {
    await clearLocalDbForTests()
    resetDbForTests()
  })

  it('zeigt den Rabattsatz des Lieferanten an', async () => {
    await getDb().hersteller.add(herstellerAnlegen({ rabattsatz: 20 }))
    const { wrapper } = await setupView()
    expect(wrapper.text()).toContain('− 20 % Rabatt')
    wrapper.unmount()
  })

  it('berechnet die Einkaufspreise der Artikel neu, wenn der Rabatt gespeichert wird', async () => {
    await getDb().hersteller.add(herstellerAnlegen())
    await getDb().artikel.add(artikelAnlegen())
    const { wrapper } = await setupView()

    await knopf(wrapper as never, 'Bearbeiten')?.trigger('click')
    await flushPromises()

    const rabattFeld = wrapper.get('[data-testid="hersteller-rabattsatz-bearbeiten"]')
    await rabattFeld.setValue('20')
    await wrapper.find('form.edit-form').trigger('submit')
    await flushPromises()
    await new Promise<void>((resolve) => setTimeout(resolve, 30))
    await flushPromises()

    // 100,00 EUR Listenpreis - 20 % = 80,00 EUR EK
    expect((await getDb().artikel.get('art-1'))?.einkaufspreis).toBe(8000)
    // Der Lieferant selbst bekommt den neuen Satz.
    expect((await getDb().hersteller.get('h-1'))?.rabattsatz).toBe(20)
    wrapper.unmount()
  })

  it('legt einen neuen Lieferanten mit Rabattsatz an', async () => {
    const { wrapper } = await setupView()

    const felder = wrapper.findAll('input')
    const nameFeld = felder.find((f) => (f.element as HTMLInputElement).type === 'text')!
    await nameFeld.setValue('Neuer Lieferant')
    await wrapper.get('[data-testid="hersteller-rabattsatz"]').setValue('15')
    await wrapper.find('form.neu-form').trigger('submit')
    await flushPromises()
    await new Promise<void>((resolve) => setTimeout(resolve, 30))
    await flushPromises()

    const alle = await getDb().hersteller.toArray()
    expect(alle).toHaveLength(1)
    expect(alle[0]?.name).toBe('Neuer Lieferant')
    expect(alle[0]?.rabattsatz).toBe(15)
    wrapper.unmount()
  })

  it('lehnt einen Rabatt ausserhalb 0…100 % ab', async () => {
    const { wrapper } = await setupView()

    const felder = wrapper.findAll('input')
    const nameFeld = felder.find((f) => (f.element as HTMLInputElement).type === 'text')!
    await nameFeld.setValue('Neuer Lieferant')
    await wrapper.get('[data-testid="hersteller-rabattsatz"]').setValue('120')
    await wrapper.find('form.neu-form').trigger('submit')
    await flushPromises()

    expect(wrapper.text()).toContain('Der Rabatt muss zwischen 0 und 100 % liegen.')
    expect(await getDb().hersteller.count()).toBe(0)
    wrapper.unmount()
  })
})
