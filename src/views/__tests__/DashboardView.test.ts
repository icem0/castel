import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import DashboardView from '../DashboardView.vue'
import { i18n } from '../../i18n'
import { useArtikelStore } from '../../stores/artikel'
import { useStandortStore } from '../../stores/standort'
import { useBuchungStore } from '../../stores/buchung'
import { sessionSchreiben } from '../../auth/session'
import type { Artikel, Buchung, Standort } from '../../db/types'

const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
})

const artikel: Artikel = {
  id: 'a1',
  sharePointId: null,
  titel: 'Schraube',
  status: 'verfuegbar',
  typ: 'Material',
  lieferant: null,
  verpackungseinheit: 10,
  mindestbestand: 20,
  nachbestellHinweis: null,
  bestellnummer: null,
  barcode: null,
  etikettenNeu: false,
  listenpreis: 199,
  einkaufspreis: 500,
  herstellerId: null,
  bestellstatus: 'offen',
  bestelltAm: null,
  bestelltVon: null,
  geaendertAm: '2026-10-01T10:00:00.000Z',
  erstelltAm: '2026-10-01T10:00:00.000Z',
}

const standort: Standort = {
  id: 's1',
  name: 'Lager',
  typ: 'lager',
  projekt: null,
  kennzeichen: null,
  standard: true,
  archiviert: false,
  geaendertAm: '2026-10-01T10:00:00.000Z',
  erstelltAm: '2026-10-01T10:00:00.000Z',
}

const buchung: Buchung = {
  id: 'b1',
  artikelId: 'a1',
  standortId: 's1',
  standortZielId: null,
  typ: 'einlagerung',
  menge: 10,
  paarId: null,
  projekt: null,
  kommentar: null,
  mitteilungAn: null,
  storno: false,
  stornoVon: null,
  storniertDurch: null,
  serverId: null,
  erstelltAm: '2026-10-01T10:00:00.000Z',
  clientEingabeAm: '2026-10-01T10:00:00.000Z',
  erstelltVon: 'admin',
}

function mountDashboard(rolle: 'admin' | 'user') {
  sessionSchreiben({
    userId: 'u1',
    email: 'admin@example.com',
    rolle,
    anzeigename: 'Admin',
    loginAm: '2026-10-01T10:00:00.000Z',
    mustChangePassword: false,
    jwtExpiresAt: '2026-10-02T10:00:00.000Z',
  })
  const pinia = createPinia()
  setActivePinia(pinia)
  useArtikelStore(pinia).artikel = [artikel]
  useStandortStore(pinia).standorte = [standort]
  useBuchungStore(pinia).buchungen = [buchung]
  return mount(DashboardView, {
    global: { plugins: [pinia, i18n, router] },
  })
}

describe('DashboardView — Lagerwert nur für Admins', () => {
  afterEach(() => {
    sessionSchreiben(null)
  })

  it('shows the inventory value section for admins', () => {
    const wrapper = mountDashboard('admin')
    expect(wrapper.text()).toContain('Lagerwert (Einkaufspreis)')
    expect(wrapper.text()).toContain('Gesamt:')
  })

  it('hides the inventory value section for regular users', () => {
    const wrapper = mountDashboard('user')
    expect(wrapper.text()).not.toContain('Lagerwert (Einkaufspreis)')
  })
})
