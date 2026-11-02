// Tests der KommissionSelect-Komponente.
//
// Erwartetes Verhalten:
//   - Die Auswahl listet die konfigurierten Kommissionen (globale
//     Einstellung) plus die Option "keine Kommission".
//   - Ein ausgewählter Wert landet über `update:modelValue` in der Buchung.
//   - Jeder User kann direkt eine neue Kommission anlegen; der Name wird
//     in die globale Liste geschrieben und ausgewählt.
//   - Der eingefügte Auftrags-Text-Scan ("Sannen") und der Link zur
//     Kommissionen-Verwaltung sind entfallen.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import KommissionSelect from '../KommissionSelect.vue'
import { useSettingsStore } from '../../stores/settings'
import { resetDbForTests } from '../../db/database'
import { clearLocalDbForTests } from '../../services/sync/reset-local-db'
import { sessionSchreiben } from '../../auth/session'
import { jetztIso } from '../../domain/ids'
import { i18n } from '../../i18n'

// Die Kamera-Komponente wird hier durch einen Stub ersetzt — sie hat
// eigene Tests. Geprueft wird nur die Verdrahtung (Event-Weitergabe).
vi.mock('../KommissionKameraScan.vue', () => ({
  default: {
    name: 'KommissionKameraScan',
    props: ['modelValue', 'disabled'],
    emits: ['update:modelValue'],
    template:
      '<button class="kamera-stub" @click="$emit(\'update:modelValue\', \'AA 4711\')">stub</button>',
  },
}))

let pinia: Pinia

function routerMit() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/einstellungen/kommissionen', component: { template: '<div />' } }],
  })
}

function session(rolle: 'admin' | 'user'): void {
  sessionSchreiben({
    userId: 'user-1',
    email: 'user@example.com',
    rolle,
    anzeigename: 'Test User',
    loginAm: jetztIso(),
    mustChangePassword: false,
    jwtExpiresAt: jetztIso(),
  })
}

async function warteAufStore(): Promise<void> {
  await flushPromises()
  await new Promise<void>((r) => setTimeout(r, 60))
  await flushPromises()
}

describe('KommissionSelect', () => {
  beforeEach(async () => {
    resetDbForTests()
    await clearLocalDbForTests()
    pinia = createPinia()
    setActivePinia(pinia)
    i18n.global.locale.value = 'de-DE'
    localStorage.removeItem('castel.auth.session')
    session('user')
  })

  afterEach(async () => {
    localStorage.removeItem('castel.auth.session')
    await clearLocalDbForTests()
  })

  it('listet die konfigurierten Kommissionen und "keine Kommission"', async () => {
    const settings = useSettingsStore(pinia)
    settings.start()
    await settings.setKommissionen(['Projekt Müller', 'Projekt Schmidt'])
    await warteAufStore()

    const w = mount(KommissionSelect, {
      props: { modelValue: '' },
      global: { plugins: [pinia, i18n, routerMit()] },
    })
    await flushPromises()

    await w.find('input[type="search"]').trigger('focus')
    await flushPromises()

    const optionen = w.findAll('.treffer-liste li').map((o) => o.text())
    expect(optionen).toEqual(['— keine Kommission —', 'Projekt Müller', 'Projekt Schmidt'])
    settings.stop()
  })

  it('gibt die Auswahl über update:modelValue weiter', async () => {
    const settings = useSettingsStore(pinia)
    settings.start()
    await settings.setKommissionen(['Projekt Müller'])
    await warteAufStore()

    const w = mount(KommissionSelect, {
      props: { modelValue: '' },
      global: { plugins: [pinia, i18n, routerMit()] },
    })
    await flushPromises()

    await w.find('input[type="search"]').trigger('focus')
    await flushPromises()
    await w.find('.treffer-liste li:nth-child(2)').trigger('mousedown')
    const emittiert = w.emitted('update:modelValue')
    expect(emittiert?.[emittiert.length - 1]).toEqual(['Projekt Müller'])
    settings.stop()
  })

  it('filtert die Optionen live nach der Eingabe', async () => {
    const settings = useSettingsStore(pinia)
    settings.start()
    await settings.setKommissionen(['Projekt Müller', 'Projekt Schmidt', 'Baustelle Nord'])
    await warteAufStore()

    const w = mount(KommissionSelect, {
      props: { modelValue: '' },
      global: { plugins: [pinia, i18n, routerMit()] },
    })
    await flushPromises()

    const input = w.find('input[type="search"]')
    await input.trigger('focus')
    await input.setValue('müll')
    await flushPromises()

    const optionen = w.findAll('.treffer-liste li').map((o) => o.text())
    expect(optionen).toEqual(['— keine Kommission —', 'Projekt Müller'])
    settings.stop()
  })

  it('legt eine neue Kommission an und wählt sie aus', async () => {
    const settings = useSettingsStore(pinia)
    settings.start()
    await warteAufStore()

    const w = mount(KommissionSelect, {
      props: { modelValue: '' },
      global: { plugins: [pinia, i18n, routerMit()] },
    })
    await flushPromises()

    await w.find('.kommission-neu input').setValue('Projekt Neu')
    await w.find('.kommission-neu button').trigger('click')
    await warteAufStore()

    expect(settings.settings.kommissionen).toEqual(['Projekt Neu'])
    const emittiert = w.emitted('update:modelValue')
    expect(emittiert?.[emittiert.length - 1]).toEqual(['Projekt Neu'])
    settings.stop()
  })

  it('meldet einen doppelten Namen, ohne die Liste zu ändern', async () => {
    const settings = useSettingsStore(pinia)
    settings.start()
    await settings.setKommissionen(['Projekt Müller'])
    await warteAufStore()

    const w = mount(KommissionSelect, {
      props: { modelValue: '' },
      global: { plugins: [pinia, i18n, routerMit()] },
    })
    await flushPromises()

    await w.find('.kommission-neu input').setValue('Projekt Müller')
    await w.find('.kommission-neu button').trigger('click')
    await flushPromises()

    expect(w.find('.fehler').text()).toContain('Projekt Müller')
    expect(w.emitted('update:modelValue')).toBeUndefined()
    settings.stop()
  })

  it('zeigt weder den Auftrags-Text-Scan noch den Verwaltungs-Link', async () => {
    // Der Admin sieht die Kommissionen weiterhin nur in den Einstellungen —
    // der Link im Formular und das Textfeld zum Einfügen des Auftrags-Textes
    // sind bewusst entfallen.
    session('admin')
    const settings = useSettingsStore(pinia)
    settings.start()
    await warteAufStore()

    const w = mount(KommissionSelect, {
      props: { modelValue: '' },
      global: { plugins: [pinia, i18n, routerMit()] },
    })
    await flushPromises()

    expect(w.find('.kommission-scan').exists()).toBe(false)
    expect(w.find('textarea').exists()).toBe(false)
    expect(w.find('a[href="/einstellungen/kommissionen"]').exists()).toBe(false)
    settings.stop()
  })

  // --- Kamera-Scan --------------------------------------------------------

  it('zeigt den Kamera-Scan-Block und gibt das Ergebnis weiter', async () => {
    const settings = useSettingsStore(pinia)
    settings.start()
    await warteAufStore()

    const w = mount(KommissionSelect, {
      props: { modelValue: '' },
      global: { plugins: [pinia, i18n, routerMit()] },
    })
    await flushPromises()

    expect(w.find('.kommission-kamera').exists()).toBe(true)

    await w.find('.kamera-stub').trigger('click')
    await flushPromises()

    const emittiert = w.emitted('update:modelValue')
    expect(emittiert?.[emittiert.length - 1]).toEqual(['AA 4711'])
    settings.stop()
  })
})
