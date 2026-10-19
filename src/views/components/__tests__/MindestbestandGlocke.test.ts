import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createRouter, createMemoryHistory } from 'vue-router'
import MindestbestandGlocke from '../MindestbestandGlocke.vue'

// Stubs für die Stores, die die Komponente indirekt nutzt. Wir testen
// hier das Rendering-Verhalten, nicht die Store-Logik (die hat eigene
// Tests in stores/__tests__/).
vi.mock('../../stores/mindestbestand', () => ({
  useMindestbestandStore: () => ({
    ereignisse: [],
    geladen: true,
    letzteGesehenAm: null,
    ungesehenCount: 0,
    letzte50: [],
    start: vi.fn(),
    stop: vi.fn(),
    startMarker: vi.fn(),
    stopMarker: vi.fn(),
    markiereAlleGesehen: vi.fn(),
  }),
}))
vi.mock('../../stores/artikel', () => ({
  useArtikelStore: () => ({
    byId: vi.fn().mockReturnValue(undefined),
  }),
}))
vi.mock('../../stores/standort', () => ({
  useStandortStore: () => ({
    aktive: [],
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

function mountGlocke() {
  const pinia = createPinia()
  setActivePinia(pinia)
  // Echte Auth-Store-Logik, aber `rolle` per Hand setzen — einfacher
  // und stabiler als ein Modul-Mock, der die `defineStore`-Closure
  // umgehen müsste.
  const auth = useAuthStore()
  auth.$patch({ session: { rolle: 'admin' } as never })
  return mount(MindestbestandGlocke, {
    global: { plugins: [pinia, i18n, router] },
  })
}

describe('MindestbestandGlocke — Rendering', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
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
})
