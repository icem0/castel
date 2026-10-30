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

  // --- Scan ("Sannen") ----------------------------------------------------

  const AUFTRAG_PDF = `Arbeitsauftrag - Nr:Kd.-Nummer:
Beleg-Datum:
Ihre Anfrage vom:
Unser Zeichen:
Telefon Kunde:
Telefon Hausmeister:
Mobiltelefon Kunde:
Seite:

908454
00012775
05.03.2024

cf
+49 (8031) 616970

+49 (160) 93768904`

  it('sannen: legt aus eingefuegtem Text eine neue Kommission an und waehlt sie', async () => {
    const settings = useSettingsStore(pinia)
    settings.start()
    await warteAufStore()

    const w = mount(KommissionSelect, {
      props: { modelValue: '' },
      global: { plugins: [pinia, i18n, routerMit()] },
    })
    await flushPromises()

    await w.find('.kommission-scan textarea').setValue(AUFTRAG_PDF)
    await w.find('.scan-erkennen').trigger('click')
    await flushPromises()

    expect(w.find('.scan-ergebnis strong').text()).toBe('908454')
    expect(w.find('.scan-typ').text()).toBe('Arbeitsauftrag')

    await w.find('.scan-uebernehmen').trigger('click')
    await warteAufStore()

    expect(settings.settings.kommissionen).toEqual(['908454'])
    const emittiert = w.emitted('update:modelValue')
    expect(emittiert?.[emittiert.length - 1]).toEqual(['908454'])
    settings.stop()
  })

  it('sannen: matcht eine bestehende Kommission, ohne neu anzulegen', async () => {
    const settings = useSettingsStore(pinia)
    settings.start()
    await settings.setKommissionen(['AA 908454'])
    await warteAufStore()

    const w = mount(KommissionSelect, {
      props: { modelValue: '' },
      global: { plugins: [pinia, i18n, routerMit()] },
    })
    await flushPromises()

    await w.find('.kommission-scan textarea').setValue(AUFTRAG_PDF)
    await w.find('.scan-erkennen').trigger('click')
    await flushPromises()

    expect(w.text()).toContain('Bestehende Kommission: AA 908454')

    await w.find('.scan-uebernehmen').trigger('click')
    await warteAufStore()

    expect(settings.settings.kommissionen).toEqual(['AA 908454'])
    const emittiert = w.emitted('update:modelValue')
    expect(emittiert?.[emittiert.length - 1]).toEqual(['AA 908454'])
    settings.stop()
  })

  it('sannen: meldet, wenn nichts erkannt wird', async () => {
    const settings = useSettingsStore(pinia)
    settings.start()
    await warteAufStore()

    const w = mount(KommissionSelect, {
      props: { modelValue: '' },
      global: { plugins: [pinia, i18n, routerMit()] },
    })
    await flushPromises()

    await w.find('.kommission-scan textarea').setValue('nur text ohne jeende zahl')
    await w.find('.scan-erkennen').trigger('click')
    await flushPromises()

    expect(w.text()).toContain('Keine Auftragsnummer erkannt')
    expect(w.find('.scan-uebernehmen').exists()).toBe(false)
    settings.stop()
  })
})
