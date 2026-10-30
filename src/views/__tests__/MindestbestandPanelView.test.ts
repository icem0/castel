// Das Mindestbestand-Panel ist Tracking, keine Konfiguration: jede Rolle
// darf die Ereignisse lesen. Bestell-Link und "als bestellt markieren"
// bleiben Admins vorbehalten.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import MindestbestandPanelView from '../MindestbestandPanelView.vue'
import type { MindestbestandEreignis } from '../../db/types'

const storeState = vi.hoisted(() => ({
  zeilen: [] as {
    ereignis: MindestbestandEreignis
    aktuellerBestand: number
    schwelle: number
    defizit: number
    offen: boolean
  }[],
  artikel: [] as Record<string, unknown>[],
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

vi.mock('../../stores/mindestbestand', () => ({
  useMindestbestandStore: () => ({
    ereignisse: storeState.zeilen.map((z) => z.ereignis),
    zeilen: storeState.zeilen,
    geladen: true,
    letzteGesehenAm: null,
    ungesehenCount: storeState.zeilen.filter((z) => z.offen).length,
    letzte50: storeState.zeilen.map((z) => z.ereignis),
    letzte50Zeilen: storeState.zeilen,
    offeneZeilen: storeState.zeilen.filter((z) => z.offen),
    start: vi.fn(),
    stop: vi.fn(),
    startMarker: vi.fn(),
    stopMarker: vi.fn(),
    markiereAlleGesehen: vi.fn(),
  }),
}))
vi.mock('../../stores/artikel', () => ({
  useArtikelStore: () => ({
    artikel: storeState.artikel,
    byId: (id: string) => storeState.artikel.find((a) => a.id === id),
    markiereBestellt: vi.fn(),
  }),
}))
vi.mock('../../stores/standort', () => ({
  useStandortStore: () => ({
    aktive: [{ id: 's-1', name: 'Hauptlager' }],
  }),
}))
vi.mock('../../stores/hersteller', () => ({
  useHerstellerStore: () => ({
    byId: vi.fn().mockReturnValue(undefined),
  }),
}))
import { useAuthStore } from '../../stores/auth'
import { i18n } from '../../i18n'

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/', component: { template: '<div />' } },
    { path: '/einstellungen', component: { template: '<div />' } },
    { path: '/einstellungen/mindestbestand', component: { template: '<div />' } },
    { path: '/artikel/:id', component: { template: '<div />' } },
  ],
})

function mountPanel(rolle: 'admin' | 'user') {
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore(pinia)
  auth.$patch({ session: { rolle } } as never)
  return mount(MindestbestandPanelView, {
    global: {
      plugins: [pinia, i18n, router],
      stubs: { ArtikelSucheSelect: true, ArtikelLink: true },
    },
  })
}

describe('MindestbestandPanelView — Rollen', () => {
  beforeEach(() => {
    storeState.zeilen = [zeile('e-1')]
    storeState.artikel = [{ id: 'a-1', titel: 'Kabelkanal' }]
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('zeigt normalen Usern die Ereignisliste ohne Bestell-Aktionen', () => {
    const w = mountPanel('user')
    expect(w.findAll('tbody tr')).toHaveLength(1)
    expect(w.text()).toContain('Hauptlager')
    expect(w.text()).toContain('Unter Mindestbestand')
    expect(w.text()).not.toContain('Als bestellt markieren')
    expect(w.find('.bestell-aktionen button').exists()).toBe(false)
    expect(w.find('.bestell-aktionen a').exists()).toBe(false)
  })

  it('zeigt Adminn die Bestell-Aktionen', () => {
    const w = mountPanel('admin')
    expect(w.text()).toContain('Als bestellt markieren')
  })
})
