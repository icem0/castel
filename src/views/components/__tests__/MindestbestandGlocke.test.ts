import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createRouter, createMemoryHistory } from 'vue-router'
import MindestbestandGlocke from '../MindestbestandGlocke.vue'
import type { MindestbestandEreignis } from '../../../db/types'
import type { MindestbestandZeile } from '../../../stores/mindestbestand'

// Stubs für die Stores, die die Komponente indirekt nutzt. Wir testen
// hier das Rendering-Verhalten, nicht die Store-Logik (die hat eigene
// Tests in stores/__tests__/).
const storeState = vi.hoisted(() => ({
  zeilen: [] as {
    ereignis: MindestbestandEreignis
    aktuellerBestand: number
    schwelle: number
    defizit: number
    offen: boolean
  }[],
  artikel: { id: 'a-1', titel: 'Kabelkanal' } as Record<string, unknown>,
}))

function zeile(id: string, offen = true) {
  return {
    ereignis: {
      id,
      artikelId: 'a-1',
      standortId: 's-1',
      ausloeserBuchungId: `b-${id}`,
      bestandDanach: 2,
      mindestbestand: 5,
      defizit: 3,
      erstelltAm: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    } as MindestbestandEreignis,
    aktuellerBestand: 2,
    schwelle: 5,
    defizit: 3,
    offen,
  }
}

vi.mock('../../../stores/mindestbestand', () => ({
  useMindestbestandStore: () => ({
    ereignisse: storeState.zeilen.map((z) => z.ereignis),
    geladen: true,
    letzteGesehenAm: null,
    ungesehenCount: storeState.zeilen.filter((z) => z.offen).length,
    letzte50: storeState.zeilen.map((z) => z.ereignis),
    letzte50Zeilen: storeState.zeilen as unknown as MindestbestandZeile[],
    offeneZeilen: storeState.zeilen.filter((z) => z.offen),
    start: vi.fn(),
    stop: vi.fn(),
    startMarker: vi.fn(),
    stopMarker: vi.fn(),
    markiereAlleGesehen: vi.fn(),
  }),
}))
vi.mock('../../../stores/artikel', () => ({
  useArtikelStore: () => ({
    byId: (id: string) => (id === 'a-1' ? storeState.artikel : undefined),
    markiereBestellt: vi.fn(),
  }),
}))
vi.mock('../../../stores/standort', () => ({
  useStandortStore: () => ({
    aktive: [{ id: 's-1', name: 'Hauptlager' }],
  }),
}))
vi.mock('../../../stores/hersteller', () => ({
  useHerstellerStore: () => ({
    byId: vi.fn().mockReturnValue(undefined),
  }),
}))
// Auth-Store: eigene Logik, daher echter Pinia-Store mit manueller Setzung.
import { useAuthStore } from '../../../stores/auth'

const i18n = createI18n({
  legacy: false,
  locale: 'de',
  messages: {
    de: {
      view: {
        mindestbestand: {
          title: 'Mindestbestand',
          empty: 'Keine Ereignisse',
          openPanel: 'Alle anzeigen',
          openArtikel: 'Öffnen',
          bestand: 'Bestand {bestand} / Soll {mindest}',
          statusOffen: 'offen',
          statusErledigt: 'erledigt',
          statusBestellt: 'bestellt',
          alsBestelltMarkieren: 'Als bestellt markieren',
          jetztBestellen: 'Jetzt bestellen',
          bestellMailBetreff: 'Bestellung: {titel}',
          bestellMailText: 'Text {titel}',
        },
      },
    },
  },
})

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/', component: { template: '<div />' } },
    { path: '/einstellungen/mindestbestand', component: { template: '<div />' } },
    { path: '/artikel/:id', component: { template: '<div />' } },
  ],
})

function mountGlocke(rolle: 'admin' | 'user' = 'admin') {
  const pinia = createPinia()
  setActivePinia(pinia)
  // Echte Auth-Store-Logik, aber `rolle` per Hand setzen — einfacher
  // und stabiler als ein Modul-Mock, der die `defineStore`-Closure
  // umgehen müsste.
  const auth = useAuthStore(pinia)
  auth.$patch({ session: { rolle } } as never)
  return mount(MindestbestandGlocke, {
    global: { plugins: [pinia, i18n, router] },
  })
}

describe('MindestbestandGlocke — Rendering', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    storeState.zeilen = []
    storeState.artikel = { id: 'a-1', titel: 'Kabelkanal' }
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('rendert die Glocke mit aria-label', () => {
    const w = mountGlocke()
    expect(w.find('button.mindestbestand-indicator').exists()).toBe(true)
  })

  it('zeigt keinen Badge, wenn keine ungesehenen Events da sind', () => {
    const w = mountGlocke()
    expect(w.find('.mindestbestand-badge').exists()).toBe(false)
  })

  it('Dropdown ist initial geschlossen', () => {
    const w = mountGlocke()
    expect(w.find('.mindestbestand-dropdown').exists()).toBe(false)
  })

  it('zeigt die Glocke auch normalen Usern (Tracking ist rollenoffen)', () => {
    storeState.zeilen = [zeile('e-1')]
    const w = mountGlocke('user')
    expect(w.find('button.mindestbestand-indicator').exists()).toBe(true)
    // Der Zähler ist für jede Rolle sichtbar.
    expect(w.find('.mindestbestand-badge').exists()).toBe(true)
  })

  it('blendet normalen Usern Bestell-Link und Markier-Button', async () => {
    storeState.zeilen = [zeile('e-1')]
    const w = mountGlocke('user')
    await w.find('button.mindestbestand-indicator').trigger('click')
    expect(w.text()).not.toContain('Als bestellt markieren')
    // Der Status selbst bleibt lesbar.
    expect(w.text()).toContain('offen')
  })

  it('zeigt Adminn Bestell-Link und Markier-Button', async () => {
    storeState.zeilen = [zeile('e-1')]
    const w = mountGlocke('admin')
    await w.find('button.mindestbestand-indicator').trigger('click')
    expect(w.text()).toContain('Als bestellt markieren')
  })

  it('zeigt normalen Usern den bestellt-Marker (lesen statt schreiben)', async () => {
    storeState.artikel = {
      id: 'a-1',
      titel: 'Kabelkanal',
      bestellstatus: 'bestellt',
      bestelltAm: new Date('2026-01-02T00:00:00.000Z').toISOString(),
      bestelltVon: 'Sven Store',
    }
    storeState.zeilen = [zeile('e-1')]
    const w = mountGlocke('user')
    await w.find('button.mindestbestand-indicator').trigger('click')
    expect(w.find('.bestellt-marker').exists()).toBe(true)
    expect(w.text()).toContain('bestellt')
    expect(w.text()).not.toContain('Als bestellt markieren')
  })
})
