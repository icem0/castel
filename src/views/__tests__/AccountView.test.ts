// Tests for the new Account page (moved out of the settings hub).
//
// Expectations (same contract as before, just on its own page):
//   - Language and theme apply immediately — no "Save" button, the write lands
//     in the local IndexedDB first (per-user key).
//   - The i18n locale follows the language switch without a reload.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import AccountView from '../AccountView.vue'
import { i18n, bindSpracheAnLocale } from '../../i18n'
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
    { path: '/einstellungen/account', component: { template: '<div />' } },
    { path: '/login', component: { template: '<div />' } },
  ],
})

function mountAccount() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const w = mount(AccountView, {
    global: { plugins: [pinia, i18n, router] },
  })
  return { w, pinia }
}

describe('AccountView — Account settings on its own page', () => {
  beforeEach(() => {
    resetDbForTests()
    setDb(getDb())
    i18n.global.locale.value = 'de-DE'
    localStorage.removeItem(LS_SESSION)
    sessionSchreiben({
      userId: 'user-acc',
      email: 'acc@example.com',
      rolle: 'user',
      anzeigename: 'Account User',
      loginAm: jetztIso(),
      mustChangePassword: false,
      jwtExpiresAt: jetztIso(),
    })
  })

  afterEach(() => {
    localStorage.removeItem(LS_SESSION)
  })

  it('shows language and theme selects', () => {
    const { w } = mountAccount()
    const selects = w.findAll('select')
    expect(selects.length).toBe(2)
    const sprachSelect = selects.find((s) =>
      s.findAll('option').some((o) => o.attributes('value') === 'en'),
    )
    expect(sprachSelect).toBeDefined()
    const themeSelect = selects.find((s) =>
      s.findAll('option').some((o) => o.attributes('value') === 'auto'),
    )
    expect(themeSelect).toBeDefined()
  })

  it('stores the theme per user immediately on change', async () => {
    const { w, pinia } = mountAccount()
    const store = useSettingsStore(pinia)
    store.start()

    const themeSelect = (
      Array.from(w.element.querySelectorAll('select')) as HTMLSelectElement[]
    ).find((s) => Array.from(s.options).some((o) => o.value === 'auto'))
    expect(themeSelect).toBeDefined()

    themeSelect!.value = 'light'
    themeSelect!.dispatchEvent(new Event('change'))
    await new Promise<void>((r) => setTimeout(r, 50))

    const row = await getDb().einstellungen.get(['theme', 'user-acc'])
    expect(row?.value).toBe('light')
    expect(await getDb().einstellungen.get(['theme', ''])).toBeUndefined()
    expect(store.settings.theme).toBe('light')

    store.stop()
  })

  it('applies the new language immediately (local + i18n locale, no "Save")', async () => {
    const { w, pinia } = mountAccount()
    const store = useSettingsStore(pinia)
    store.start()
    bindSpracheAnLocale(() => store.settings.sprache)

    const sprachSelect = w
      .findAll('select')
      .find((s) => s.findAll('option').some((o) => o.attributes('value') === 'en'))!
    await sprachSelect!.setValue('en')
    // The store refreshes itself via liveQuery (asynchronous) — wait shortly.
    await new Promise<void>((r) => setTimeout(r, 50))

    const row = await getDb().einstellungen.get(['sprache', 'user-acc'])
    expect(row?.value).toBe('en')
    expect(await getDb().einstellungen.get(['sprache', ''])).toBeUndefined()

    expect(i18n.global.locale.value).toBe('en-US')
    expect(store.settings.sprache).toBe('en')

    store.stop()
  })
})
