import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import BuchungFormView from '../BuchungFormView.vue'
import { i18n } from '../../i18n'
import { resetDbForTests } from '../../db/database'
import { clearLocalDbForTests } from '../../services/sync/reset-local-db'
import { useArtikelStore } from '../../stores/artikel'
import { useStandortStore } from '../../stores/standort'
import { useToastStore } from '../../stores/toast'
import { useSettingsStore } from '../../stores/settings'
import { getDb } from '../../db/database'
import { sessionSchreiben } from '../../auth/session'
import { jetztIso } from '../../domain/ids'
import {
  kommissionMerken,
  kommissionVergessen,
  letzteKommission,
  MERKDAUER_MS,
} from '../../services/kommission/merken'

const mocks = vi.hoisted(() => ({
  syncUndBestaetigeBuchungen: vi.fn(),
}))

vi.mock('../../services/sync/buchung-bestaetigung', () => ({
  syncUndBestaetigeBuchungen: mocks.syncUndBestaetigeBuchungen,
}))

let pinia: Pinia

beforeEach(async () => {
  resetDbForTests()
  await clearLocalDbForTests()
  pinia = createPinia()
  setActivePinia(pinia)
  i18n.global.locale.value = 'de-DE'
  localStorage.removeItem('castel.auth.session')
  kommissionVergessen()
  sessionSchreiben({
    userId: 'user-1',
    email: 'user@example.com',
    rolle: 'user',
    anzeigename: 'Test User',
    loginAm: jetztIso(),
    mustChangePassword: false,
    jwtExpiresAt: jetztIso(),
  })
  mocks.syncUndBestaetigeBuchungen.mockReset()
  mocks.syncUndBestaetigeBuchungen.mockResolvedValue({ status: 'bestaetigt' })
})

afterEach(async () => {
  localStorage.removeItem('castel.auth.session')
  kommissionVergessen()
  await clearLocalDbForTests()
  vi.restoreAllMocks()
})

async function setupView() {
  const standortStore = useStandortStore(pinia)
  const lager = await standortStore.anlegen({ name: 'Lager', typ: 'lager' })
  await standortStore.setStandard(lager.id)
  const artikelStore = useArtikelStore(pinia)
  const artikel = await artikelStore.anlegen({ titel: 'Schraube', typ: 'Material' })
  standortStore.start()
  await new Promise<void>((resolve) => setTimeout(resolve, 30))

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/scan', name: 'scan', component: { template: '<div>scan</div>' } },
      { path: '/buchung/neu', name: 'buchung-neu', component: BuchungFormView },
      {
        path: '/artikel/:id',
        name: 'artikel-detail',
        component: { template: '<div>artikel</div>' },
      },
      { path: '/buchungen', name: 'buchungen', component: { template: '<div>buchungen</div>' } },
    ],
  })
  await router.push({ name: 'buchung-neu', query: { artikelId: artikel.id, from: 'scan' } })
  await router.isReady()

  const w = mount(BuchungFormView, { global: { plugins: [pinia, i18n, router] } })
  await flushPromises()
  await new Promise<void>((resolve) => setTimeout(resolve, 30))
  await flushPromises()
  return { w, router, standortStore }
}

describe('BuchungFormView — Scan-Workflow', () => {
  it('springt nach dem Speichern sofort zurück zum Scanner', async () => {
    const { w, router, standortStore } = await setupView()

    await w.find('form').trigger('submit')
    await flushPromises()
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    await flushPromises()

    expect(router.currentRoute.value.name).toBe('scan')
    expect(mocks.syncUndBestaetigeBuchungen).toHaveBeenCalledTimes(1)
    expect(mocks.syncUndBestaetigeBuchungen.mock.calls[0]?.[0]).toHaveLength(1)

    standortStore.stop()
  })

  it('zeigt die Server-Bestätigung als Toast', async () => {
    const { w, standortStore } = await setupView()
    const toast = useToastStore(pinia)

    await w.find('form').trigger('submit')
    await flushPromises()
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    await flushPromises()

    expect(toast.toasts[0]?.status).toBe('success')
    expect(toast.toasts[0]?.text).toBe('Buchung am Server angekommen')

    standortStore.stop()
  })
})

describe('BuchungFormView — Kommission', () => {
  it('übernimmt die ausgewählte Kommission in die Buchung', async () => {
    const settings = useSettingsStore(pinia)
    settings.start()
    await settings.setKommissionen(['Projekt Müller'])
    await new Promise<void>((resolve) => setTimeout(resolve, 60))

    const { w, standortStore } = await setupView()

    const feld = w.find('.kommission-suche')
    await feld.find('input[type="search"]').trigger('focus')
    await flushPromises()
    const eintrag = feld
      .findAll('.treffer-liste li')
      .find((li) => li.text() === 'Projekt Müller')
    expect(eintrag).toBeDefined()
    await eintrag!.trigger('mousedown')

    await w.find('form').trigger('submit')
    await flushPromises()
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    await flushPromises()

    const buchungen = await getDb().buchungen.toArray()
    expect(buchungen).toHaveLength(1)
    expect(buchungen[0]?.projekt).toBe('Projekt Müller')
    // Die zuletzt gebuchte Kommission wird gemerkt (1 h, pro User).
    expect(letzteKommission('user-1')).toBe('Projekt Müller')

    standortStore.stop()
    settings.stop()
  })

  it('füllt das Formular mit der gemerkten Kommission (unter einer Stunde)', async () => {
    kommissionMerken('user-1', 'Projekt Müller')

    const { w, standortStore } = await setupView()
    const feld = w.find('.kommission-suche')
    expect(feld.find('.auswahl-tag .auswahl-titel').text()).toBe('Projekt Müller')

    standortStore.stop()
  })

  it('füllt NICHT mit einer Kommission, älter als eine Stunde', async () => {
    kommissionMerken('user-1', 'Projekt Müller', Date.now() - MERKDAUER_MS - 5000)

    const { w, standortStore } = await setupView()
    const feld = w.find('.kommission-suche')
    expect(feld.find('.auswahl-tag').exists()).toBe(false)
    expect((feld.find('input[type="search"]').element as HTMLInputElement).value).toBe('')

    standortStore.stop()
  })

  it('füllt nicht mit der Kommission eines anderen Users', async () => {
    kommissionMerken('user-2', 'Fremde Kommission')

    const { w, standortStore } = await setupView()
    const feld = w.find('.kommission-suche')
    expect(feld.find('.auswahl-tag').exists()).toBe(false)
    expect((feld.find('input[type="search"]').element as HTMLInputElement).value).toBe('')

    standortStore.stop()
  })
})
