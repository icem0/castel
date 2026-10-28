// Tests der Akkutausch-Ansicht.
//
// Erwartetes Verhalten:
//   - Die Ansicht hat drei Reiter (Planung, Netzteile, Projektakkus).
//   - Der Planungs-Reiter zeigt die Bestellliste des gewaehlten Quartals.
//   - Der Netzteil-Reiter listet die angelegten Geraete mit Faelligkeit.
//   - Mitarbeiter (kein Admin) sehen keine Schreibaktionen.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import AkkutauschView from '../AkkutauschView.vue'
import { i18n } from '../../i18n'
import { resetDbForTests } from '../../db/database'
import { clearLocalDbForTests } from '../../services/sync/reset-local-db'
import { useAkkutauschStore } from '../../stores/akkutausch'
import { useArtikelStore } from '../../stores/artikel'
import { useAuthStore } from '../../stores/auth'
import { useSettingsStore } from '../../stores/settings'
import { getDb } from '../../db/database'
import { jetztIso } from '../../domain/ids'

let pinia: Pinia

async function setupView() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/akkutausch', component: { template: '<div />' } }],
  })
  await router.push('/akkutausch')
  await router.isReady()
  const w = mount(AkkutauschView, {
    global: { plugins: [pinia, i18n, router] },
  })
  await flushPromises()
  await new Promise<void>((r) => setTimeout(r, 80))
  await flushPromises()
  return { w }
}

function buttonMitText(w: ReturnType<typeof mount>, text: string) {
  return w.findAll('button').find((b) => b.text().includes(text))
}

/**
 * Legt die Ausgangslage der Planung an: Hauptlager, Akku-Artikel,
 * Akku-Typ und ein Projektakku im aktuellen Quartal.
 */
async function setupPlanung(): Promise<void> {
  const db = getDb()
  await db.standorte.put({
    id: 's-1',
    name: 'Hauptlager',
    typ: 'lager',
    projekt: null,
    kennzeichen: null,
    standard: true,
    archiviert: false,
    geaendertAm: jetztIso(),
    erstelltAm: jetztIso(),
  })
  await db.artikel.put({
    id: 'a-1',
    sharePointId: null,
    titel: 'Akku 12,5 Ah',
    status: 'verfuegbar',
    typ: 'Akku',
    lieferant: null,
    verpackungseinheit: 1,
    mindestbestand: null,
    nachbestellHinweis: null,
    bestellnummer: null,
    barcode: null,
    etikettenNeu: false,
    listenpreis: null,
    einkaufspreis: null,
    herstellerId: null,
    bestellstatus: 'offen',
    bestelltAm: null,
    bestelltVon: null,
    geaendertAm: jetztIso(),
    erstelltAm: jetztIso(),
  })

  const artikelStore = useArtikelStore(pinia)
  artikelStore.start()
  for (let i = 0; i < 50 && !artikelStore.byId('a-1'); i++) {
    await new Promise((r) => setTimeout(r, 10))
  }

  const settings = useSettingsStore(pinia)
  settings.start()
  await new Promise((r) => setTimeout(r, 30))
  await settings.setAkkuTypen([
    { id: 't1', kapazitaetAh: 12.5, von: 12.0, bis: 12.9, artikelId: 'a-1' },
  ])
  await new Promise((r) => setTimeout(r, 30))

  const store = useAkkutauschStore(pinia)
  store.start()
  await new Promise((r) => setTimeout(r, 80))
  await store.projektSpeichern({
    projekt: 'Bauvorhaben',
    menge: 10,
    artAh: 12.5,
    quartal: store.quartal,
    jahr: store.jahr,
  })
  await new Promise((r) => setTimeout(r, 80))
}

describe('AkkutauschView', () => {
  beforeEach(async () => {
    resetDbForTests()
    await clearLocalDbForTests()
    pinia = createPinia()
    setActivePinia(pinia)
    i18n.global.locale.value = 'de-DE'
  })

  afterEach(async () => {
    await clearLocalDbForTests()
  })

  it('zeigt die drei Reiter', async () => {
    const { w } = await setupView()
    const tabs = w.findAll('[role="tab"]')
    expect(tabs).toHaveLength(3)
    expect(w.text()).toContain('Planung')
    expect(w.text()).toContain('Netzteile')
    expect(w.text()).toContain('Projektakkus')
  })

  it('listet Netzteile mit Faelligkeit', async () => {
    const store = useAkkutauschStore(pinia)
    await store.netzteilSpeichern({
      anlage: 'Anlage 1',
      objekt: 'Objekt 1',
      name: 'Notlichtaggregat',
      einbaudatum: '2020-01-15',
      intervallJahre: 5,
      kapazitaetAh: 12.5,
      anzahl: 2,
      gruppe: null,
      plz: null,
      vdsAnerkennung: null,
      bemerkung: null,
    })
    const { w } = await setupView()
    await buttonMitText(w, 'Netzteile')?.trigger('click')
    await flushPromises()

    expect(w.text()).toContain('Notlichtaggregat')
    expect(w.text()).toContain('12,5 Ah')
    expect(w.text()).toContain('15.01.2025')
  })

  it('zeigt Mitarbeitern keine Schreibaktionen', async () => {
    const auth = useAuthStore(pinia)
    auth.session = {
      userId: 'u1',
      email: 'mitarbeiter@example.com',
      rolle: 'user',
    } as never
    const { w } = await setupView()
    await buttonMitText(w, 'Netzteile')?.trigger('click')
    await flushPromises()

    expect(buttonMitText(w, 'Netzteil anlegen')).toBeUndefined()
    expect(buttonMitText(w, 'Löschen')).toBeUndefined()
  })

  it('zeigt die Bestellliste der Planung', async () => {
    // Akku-Artikel + Typ + Projektakku im aktuellen Quartal anlegen.
    const settings = useSettingsStore(pinia)
    settings.start()
    await new Promise((r) => setTimeout(r, 30))
    await settings.setAkkuTypen([
      { id: 't1', kapazitaetAh: 12.5, von: 12.0, bis: 12.9, artikelId: 'a-1' },
    ])
    await new Promise((r) => setTimeout(r, 30))

    const db = getDb()
    await db.artikel.put({
      id: 'a-1',
      sharePointId: null,
      titel: 'Akku 12–12,9 Ah',
      status: 'verfuegbar',
      typ: 'Akku',
      lieferant: null,
      verpackungseinheit: 1,
      mindestbestand: null,
      nachbestellHinweis: null,
      bestellnummer: null,
      barcode: null,
      etikettenNeu: false,
      listenpreis: null,
      einkaufspreis: null,
      herstellerId: null,
      bestellstatus: 'offen',
      bestelltAm: null,
      bestelltVon: null,
      geaendertAm: jetztIso(),
      erstelltAm: jetztIso(),
    })

    const store = useAkkutauschStore(pinia)
    store.start()
    await new Promise((r) => setTimeout(r, 80))
    await store.projektSpeichern({
      projekt: 'Bauvorhaben',
      menge: 10,
      artAh: 12.5,
      quartal: store.quartal,
      jahr: store.jahr,
    })
    await new Promise((r) => setTimeout(r, 80))

    const { w } = await setupView()
    expect(w.text()).toContain('Bestellliste')
    // 10 Stueck Bedarf, 0 Bestand, 0 Reserve -> 10 Stueck zu bestellen.
    expect(w.text()).toContain('12–12,9 Ah')
    expect(w.text()).toContain('Gesamt')
    expect(w.findAll('tbody tr').length).toBeGreaterThan(0)
  })

  it('zeigt die Spalten Größe, Bedarf, Bestand, zur freien Verfügung und Bestellmenge', async () => {
    await setupPlanung()

    const { w } = await setupView()
    const kopf = w
      .find('table.data')
      .findAll('thead th')
      .map((th) => th.text())
    expect(kopf).toEqual(['Größe', 'Bedarf', 'Bestand', 'zur freien Verfügung', 'Bestellmenge'])
  })

  it('speichert den Puffer aus der Plantabelle', async () => {
    await setupPlanung()

    const { w } = await setupView()
    const eingabe = w.find('table.data tbody tr input[type="number"]')
    expect(eingabe.exists()).toBe(true)
    expect((eingabe.element as HTMLInputElement).value).toBe('0')

    await eingabe.setValue('4')
    await eingabe.trigger('change')
    await flushPromises()

    const eintraege = await getDb().artikelStandortMindestbestaende.toArray()
    expect(eintraege).toHaveLength(1)
    expect(eintraege[0]?.mindestbestand).toBe(4)
  })

  it('nennt die Anlage in Warnungen und springt in die Bearbeitung', async () => {
    const auth = useAuthStore(pinia)
    auth.session = {
      userId: 'admin',
      email: 'admin@example.com',
      rolle: 'admin',
    } as never

    const store = useAkkutauschStore(pinia)
    await store.netzteilSpeichern({
      anlage: 'A-4711',
      objekt: 'Objekt 1',
      name: 'Stromversorgung Zentrale',
      einbaudatum: '2020-01-15',
      intervallJahre: 5,
      kapazitaetAh: 12.5,
      anzahl: null,
      gruppe: null,
      plz: null,
      vdsAnerkennung: null,
      bemerkung: null,
    })

    const { w } = await setupView()
    expect(w.text()).toContain('A-4711')

    const bearbeiten = buttonMitText(w, 'Bearbeiten')
    expect(bearbeiten).toBeDefined()
    await bearbeiten?.trigger('click')
    await flushPromises()

    expect(w.text()).toContain('Netzteil bearbeiten')
    expect(w.find('input').exists()).toBe(true)
  })

  it('speichert ein über den Hinweis geöffnetes Netzteil', async () => {
    const auth = useAuthStore(pinia)
    auth.session = {
      userId: 'admin',
      email: 'admin@example.com',
      rolle: 'admin',
    } as never

    const store = useAkkutauschStore(pinia)
    await store.netzteilSpeichern({
      anlage: 'A-4711',
      objekt: 'Objekt 1',
      name: 'Stromversorgung Zentrale',
      einbaudatum: '2020-01-15',
      intervallJahre: 5,
      kapazitaetAh: 12.5,
      anzahl: null,
      gruppe: null,
      plz: null,
      vdsAnerkennung: null,
      bemerkung: null,
    })
    const { w } = await setupView()
    await buttonMitText(w, 'Bearbeiten')?.trigger('click')
    await flushPromises()

    const anzahl = w
      .findAll('input')
      .find((i) => i.attributes('type') === 'number' && i.element.value === '')
    expect(anzahl).toBeDefined()
    await anzahl?.setValue('2')
    await w.find('form').trigger('submit')
    await flushPromises()

    const gespeichert = await getDb().akkuNetzteile.toCollection().first()
    expect(gespeichert?.anzahl).toBe(2)
  })
})
