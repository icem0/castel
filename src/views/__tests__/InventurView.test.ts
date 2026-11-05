// The inventory settings live on /einstellungen/inventur — not in the main
// settings page — and the form must never queue a date the server rejects.
//
// Regression: the old form concatenated the month and day inputs blindly, so a
// day left empty produced `11-00`. The server answered `VALIDATION: Tag muss
// zwischen 1 und 31 liegen` on every push and the outbox kept failing.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import InventurView from '../InventurView.vue'
import { i18n } from '../../i18n'
import { useSettingsStore } from '../../stores/settings'
import { getDb, resetDbForTests, setDb } from '../../db/database'
import { jetztIso } from '../../domain/ids'
import { sessionSchreiben } from '../../auth/session'

const LS_SESSION = 'castel.auth.session'

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/', component: { template: '<div />' } },
    { path: '/einstellungen', component: { template: '<div />' } },
    { path: '/einstellungen/inventur', component: { template: '<div />' } },
  ],
})

function offeneEinstellungsOps(): Promise<Array<{ payload: string }>> {
  return getDb()
    .outbox.toArray()
    .then((alle) =>
      alle
        .filter((o) => o.entity === 'einstellung' && o.syncedAt == null)
        .map((o) => ({ payload: o.payload })),
    )
}

describe('InventurView — Stichtag-Formular', () => {
  beforeEach(async () => {
    resetDbForTests()
    setDb(getDb())
    await Promise.all([getDb().einstellungen.clear(), getDb().outbox.clear()])
    setActivePinia(createPinia())
    localStorage.removeItem(LS_SESSION)
    sessionSchreiben({
      userId: 'user-inv-view',
      email: 'inv@example.com',
      rolle: 'admin',
      anzeigename: 'Inv',
      loginAm: jetztIso(),
      mustChangePassword: false,
      jwtExpiresAt: jetztIso(),
    })
    i18n.global.locale.value = 'de-DE'
  })

  afterEach(() => {
    localStorage.removeItem(LS_SESSION)
  })

  it('pflegt den Stichtag auf der Inventur-Seite, nicht in den Haupteinstellungen', () => {
    const w = mount(InventurView, { global: { plugins: [createPinia(), i18n, router] } })
    const inputs = w.findAll('input[type="number"]')
    expect(inputs.length).toBeGreaterThanOrEqual(3) // Monat, Tag, Vorlauf-Tage
    expect(w.text()).toContain('Monat')
    expect(w.text()).toContain('Tag')
  })

  it('schreibt einen halb ausgefüllten Stichtag nicht in die Outbox', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useSettingsStore(pinia)
    store.start()

    const w = mount(InventurView, { global: { plugins: [pinia, i18n, router] } })
    const tag = w.findAll('input[type="number"]')[0]
    if (!tag) throw new Error('Tag-Feld fehlt')
    await tag.setValue('11')
    await tag.trigger('change')
    await new Promise<void>((r) => setTimeout(r, 20))

    expect(await offeneEinstellungsOps()).toHaveLength(0)
    expect(w.find('[role="alert"]').text()).toContain('Tag, Monat und Jahr ausfüllen')

    store.stop()
    w.unmount()
  })

  it('schreibt ein unmögliches Datum nicht in die Outbox', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useSettingsStore(pinia)
    store.start()

    const w = mount(InventurView, { global: { plugins: [pinia, i18n, router] } })
    const inputs = w.findAll('input[type="number"]')
    const tag = inputs[0]
    const monat = inputs[1]
    const jahr = inputs[2]
    if (!tag || !monat || !jahr) throw new Error('Tag/Monat/Jahr-Felder fehlen')
    await tag.setValue('30')
    await tag.trigger('change')
    await monat.setValue('2')
    await monat.trigger('change')
    await jahr.setValue('2026')
    await jahr.trigger('change')
    await new Promise<void>((r) => setTimeout(r, 20))

    expect(await offeneEinstellungsOps()).toHaveLength(0)
    expect(w.find('[role="alert"]').text()).toContain('Kalenderdatum')

    store.stop()
    w.unmount()
  })

  it('speichert einen vollständigen Stichtag und verdrängt einen alten Fehl-Op', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useSettingsStore(pinia)
    store.start()
    // Leftover of a broken client build: a value the server rejects.
    await store.setKey('inventur.stichtag', '00.11.2026')
    expect(await offeneEinstellungsOps()).toHaveLength(1)

    const w = mount(InventurView, { global: { plugins: [pinia, i18n, router] } })
    await new Promise<void>((r) => setTimeout(r, 30))
    const inputs = w.findAll('input[type="number"]')
    const tag = inputs[0]
    const monat = inputs[1]
    const jahr = inputs[2]
    if (!tag || !monat || !jahr) throw new Error('Tag/Monat/Jahr-Felder fehlen')
    await tag.setValue('15')
    await tag.trigger('change')
    await monat.setValue('11')
    await monat.trigger('change')
    await jahr.setValue('2026')
    await jahr.trigger('change')
    await new Promise<void>((r) => setTimeout(r, 30))

    const ops = await offeneEinstellungsOps()
    expect(ops).toHaveLength(1)
    expect(JSON.parse(ops[0]!.payload)).toMatchObject({
      key: 'inventur.stichtag',
      value: '15.11.2026',
    })
    expect(store.settings.inventurStichtag).toBe('15.11.2026')
    expect(w.text()).toContain('Inventur-Stichtag gespeichert')

    store.stop()
    w.unmount()
  })

  it('übersetzt die Erfolgsbestätigung des Inventur-Erfassens — kein roher Schlüssel', () => {
    // Regression: the message used the named placeholder `{übersprungen}`.
    // vue-i18n rejects non-ASCII placeholder names, the compile threw and the
    // UI showed `view.inventur.hilfeGespeichert` instead of the text.
    const de = i18n.global.t('view.inventur.hilfeGespeichert', { erstellt: 2, uebersprungen: 1 })
    expect(de).not.toContain('view.inventur.hilfeGespeichert')
    expect(de).toContain('2')
    expect(de).toContain('1')

    i18n.global.locale.value = 'en-US'
    const en = i18n.global.t('view.inventur.hilfeGespeichert', { erstellt: 2, uebersprungen: 1 })
    i18n.global.locale.value = 'de-DE'
    expect(en).not.toContain('view.inventur.hilfeGespeichert')
    expect(en).toContain('2')
    expect(en).toContain('1')
  })

  it('rendert den Suchplatzhalter übersetzt, nicht als wörtliches {{ t() }}', async () => {
    const w = mount(InventurView, { global: { plugins: [createPinia(), i18n, router] } })
    await new Promise<void>((r) => setTimeout(r, 30))
    const feld = w.get('input[type="text"]')
    expect(feld.attributes('placeholder')).toBe('Artikel oder Standort …')
    expect(feld.attributes('placeholder')).not.toContain('{{')
    w.unmount()
  })

  it('leert die Einstellung, wenn beide Felder leer sind', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useSettingsStore(pinia)
    store.start()
    await store.setInventurStichtag('15.11.2026')

    const w = mount(InventurView, { global: { plugins: [pinia, i18n, router] } })
    await new Promise<void>((r) => setTimeout(r, 30))
    const inputs = w.findAll('input[type="number"]')
    const tag = inputs[0]
    const monat = inputs[1]
    const jahr = inputs[2]
    if (!tag || !monat || !jahr) throw new Error('Tag/Monat/Jahr-Felder fehlen')
    await tag.setValue('')
    await tag.trigger('change')
    await monat.setValue('')
    await monat.trigger('change')
    await jahr.setValue('')
    await jahr.trigger('change')
    await new Promise<void>((r) => setTimeout(r, 30))

    const ops = await offeneEinstellungsOps()
    expect(ops).toHaveLength(1)
    expect(JSON.parse(ops[0]!.payload).value).toBe('')
    expect(store.settings.inventurStichtag).toBeNull()

    store.stop()
    w.unmount()
  })
})
