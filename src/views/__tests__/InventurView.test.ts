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
    const monat = w.findAll('input[type="number"]')[0]
    if (!monat) throw new Error('Monatsfeld fehlt')
    await monat.setValue('11')
    await monat.trigger('change')
    await new Promise<void>((r) => setTimeout(r, 20))

    expect(await offeneEinstellungsOps()).toHaveLength(0)
    expect(w.find('[role="alert"]').text()).toContain('Monat und Tag ausfüllen')

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
    const monat = inputs[0]
    const tag = inputs[1]
    if (!monat || !tag) throw new Error('Monat/Tag-Felder fehlen')
    await monat.setValue('2')
    await monat.trigger('change')
    await tag.setValue('30')
    await tag.trigger('change')
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
    await store.setKey('inventur.stichtag', '11-00')
    expect(await offeneEinstellungsOps()).toHaveLength(1)

    const w = mount(InventurView, { global: { plugins: [pinia, i18n, router] } })
    await new Promise<void>((r) => setTimeout(r, 30))
    const inputs = w.findAll('input[type="number"]')
    const monat = inputs[0]
    const tag = inputs[1]
    if (!monat || !tag) throw new Error('Monat/Tag-Felder fehlen')
    await monat.setValue('11')
    await monat.trigger('change')
    await tag.setValue('15')
    await tag.trigger('change')
    await new Promise<void>((r) => setTimeout(r, 30))

    const ops = await offeneEinstellungsOps()
    expect(ops).toHaveLength(1)
    expect(JSON.parse(ops[0]!.payload)).toMatchObject({
      key: 'inventur.stichtag',
      value: '11-15',
    })
    expect(store.settings.inventurStichtag).toBe('11-15')
    expect(w.text()).toContain('Inventur-Stichtag gespeichert')

    store.stop()
    w.unmount()
  })

  it('leert die Einstellung, wenn beide Felder leer sind', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useSettingsStore(pinia)
    store.start()
    await store.setInventurStichtag('11-15')

    const w = mount(InventurView, { global: { plugins: [pinia, i18n, router] } })
    await new Promise<void>((r) => setTimeout(r, 30))
    const inputs = w.findAll('input[type="number"]')
    const monat = inputs[0]
    const tag = inputs[1]
    if (!monat || !tag) throw new Error('Monat/Tag-Felder fehlen')
    await monat.setValue('')
    await monat.trigger('change')
    await tag.setValue('')
    await tag.trigger('change')
    await new Promise<void>((r) => setTimeout(r, 30))

    const ops = await offeneEinstellungsOps()
    expect(ops).toHaveLength(1)
    expect(JSON.parse(ops[0]!.payload).value).toBe('')
    expect(store.settings.inventurStichtag).toBeNull()

    store.stop()
    w.unmount()
  })
})
