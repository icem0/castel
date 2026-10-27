// Tests der KommissionSelect-Komponente.
//
// Erwartetes Verhalten:
//   - Die Auswahl listet die konfigurierten Kommissionen (globale
//     Einstellung) plus die Option "keine Kommission".
//   - Ein ausgewählter Wert landet über `update:modelValue` in der Buchung.
//   - Jeder User kann direkt eine neue Kommission anlegen; der Name wird
//     in die globale Liste geschrieben und ausgewählt.
//   - Der Link zur Kommissionen-Verwaltung erscheint nur für Admins.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

    const optionen = w.findAll('option').map((o) => o.attributes('value'))
    expect(optionen).toEqual(['', 'Projekt Müller', 'Projekt Schmidt'])
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

    await w.find('select').setValue('Projekt Müller')
    const emittiert = w.emitted('update:modelValue')
    expect(emittiert?.[emittiert.length - 1]).toEqual(['Projekt Müller'])
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

  it('zeigt den Verwaltungs-Link nicht fuer normale User', async () => {
    const settings = useSettingsStore(pinia)
    settings.start()
    await warteAufStore()

    const w = mount(KommissionSelect, {
      props: { modelValue: '' },
      global: { plugins: [pinia, i18n, routerMit()] },
    })
    await flushPromises()
    expect(w.find('a[href="/einstellungen/kommissionen"]').exists()).toBe(false)
    settings.stop()
  })

  it('zeigt den Verwaltungs-Link fuer Admins', async () => {
    // Der Auth-Store liest die Session einmalig beim Anlegen — die Session
    // muss deshalb VOR dem ersten Mount gesetzt werden.
    session('admin')
    const settings = useSettingsStore(pinia)
    settings.start()
    await warteAufStore()

    const w = mount(KommissionSelect, {
      props: { modelValue: '' },
      global: { plugins: [pinia, i18n, routerMit()] },
    })
    await flushPromises()
    expect(w.find('a[href="/einstellungen/kommissionen"]').exists()).toBe(true)
    settings.stop()
  })
})
