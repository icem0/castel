// Tests für den Einstellings-Menü (directory-only, keine inline forms mehr).
//
// Expectations:
//   - Every menu point links to its own page — no inline Account/Benachricht-
//     ings forms left in the hub.
//   - Permission visibility stays client-side: normal users do not see admin
//     points, admins see all.
//   - The live filter at the top narrows the menu points (initialQuery prop is
//     the test hook; typing works the same at runtime).
//   - Every menu point carries an InfoHint badge to its right.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import SettingsView from '../SettingsView.vue'
import { i18n } from '../../i18n'
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
    { path: '/einstellungen/benachrichtigengs', component: { template: '<div />' } },
    { path: '/einstellungen/general', component: { template: '<div />' } },
    { path: '/einstellungen/user', component: { template: '<div />' } },
    { path: '/einstellungen/entwicklung', component: { template: '<div />' } },
    { path: '/einstellungen/artikel-typen', component: { template: '<div />' } },
    { path: '/einstellungen/kommissionen', component: { template: '<div />' } },
    { path: '/einstellungen/artikel-kataloge', component: { template: '<div />' } },
    { path: '/einstellungen/mindestbestand', component: { template: '<div />' } },
    { path: '/einstellungen/backup', component: { template: '<div />' } },
    { path: '/einstellungen/api-keys', component: { template: '<div />' } },
    { path: '/einstellungen/geraet', component: { template: '<div />' } },
    { path: '/einstellungen/rollen', component: { template: '<div />' } },
    { path: '/einstellungen/akku-typen', component: { template: '<div />' } },
    { path: '/einstellungen/hersteller', component: { template: '<div />' } },
    { path: '/einstellungen/inventur', component: { template: '<div />' } },
    { path: '/einstellungen/inventur/archiv', component: { template: '<div />' } },
    { path: '/akkutausch', component: { template: '<div />' } },
    { path: '/passwort-aendern', component: { template: '<div />' } },
    { path: '/info', component: { template: '<div />' } },
    { path: '/import', component: { template: '<div />' } },
    { path: '/etiketten', component: { template: '<div />' } },
    { path: '/standorte', component: { template: '<div />' } },
  ],
})

function mountSettings(props: { initialQuery?: string } = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const w = mount(SettingsView, {
    props,
    global: { plugins: [pinia, i18n, router] },
  })
  return { w, pinia }
}

describe('SettingsView — normal User', () => {
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

  it('shows the own points and hides all admin points', () => {
    const { w } = mountSettings()
    const links = w.findAll('a').map((a) => a.attributes('href'))
    expect(links).toContain('/einstellungen/account')
    expect(links).toContain('/einstellungen/benachrichtigengs')
    expect(links).toContain('/passwort-aendern')
    expect(links).toContain('/info')
    expect(links).toContain('/einstellungen/mindestbestand')
    expect(links).toContain('/etiketten')
    expect(links).toContain('/einstellungen/artikel-kataloge')
    expect(links).toContain('/einstellungen/geraet')
    // Admin-only points must not be visible.
    for (const hidden of [
      '/standorte',
      '/einstellungen/inventur',
      '/einstellungen/inventur/archiv',
      '/einstellungen/general',
      '/einstellungen/user',
      '/einstellungen/rollen',
      '/einstellungen/entwicklung',
      '/einstellungen/backup',
      '/einstellungen/api-keys',
      '/import',
    ]) {
      expect(links).not.toContain(hidden)
    }
    // The Akkutausch is opt-in and off by default.
    expect(links).not.toContain('/akkutausch')
  })

  it('has no inline forms and no inline notification block anymore', () => {
    const { w } = mountSettings()
    expect(w.element.querySelector('form')).toBeNull()
    // The Account/Benachrichtigengs content lives on its own page now — the
    // hub only carries the menu point.
    expect(w.text()).not.toContain('Alarm bei neuen Ereignissen')
    expect(w.text()).not.toContain('Standard-Standort')
  })

  it('renders the live search input at the top', () => {
    const { w } = mountSettings()
    const input = w.element.querySelector('input[type="search"]')
    expect(input).not.toBeNull()
    expect(input!.placeholder).toContain('Find menu')
  })

  it('every menu point carries an InfoHint badge', () => {
    const { w } = mountSettings()
    const links = w.findAll('a').map((a) => a.attributes('href'))
    const badges = w.element.querySelectorAll('.info-hint')
    expect(badges.length).toBe(links.length)
    expect(badges.length).toBeGreaterThan(0)
  })

  it('menu links stay decorated with an app icon', () => {
    const { w } = mountSettings()
    const target = w.element.querySelector('a[href="/einstellungen/geraet"]')
    expect(target?.outerHTML).toContain('app-icon')
  })
})

describe('SettingsView — Admin', () => {
  beforeEach(() => {
    resetDbForTests()
    setDb(getDb())
    i18n.global.locale.value = 'de-DE'
    localStorage.removeItem(LS_SESSION)
    sessionSchreiben({
      userId: 'user-admin',
      email: 'admin@example.com',
      rolle: 'admin',
      anzeigename: 'Admin User',
      loginAm: jetztIso(),
      mustChangePassword: false,
      jwtExpiresAt: jetztIso(),
    })
  })

  afterEach(() => {
    localStorage.removeItem(LS_SESSION)
  })

  it('shows all points to an admin', () => {
    const { w } = mountSettings()
    const links = w.findAll('a').map((a) => a.attributes('href'))
    for (const expected of [
      '/standorte',
      '/einstellungen/inventur',
      '/einstellungen/inventur/archiv',
      '/einstellungen/general',
      '/einstellungen/user',
      '/einstellungen/rollen',
      '/einstellungen/entwicklung',
      '/einstellungen/backup',
      '/einstellungen/api-keys',
      '/import',
    ]) {
      expect(links).toContain(expected)
    }
  })

  it('categories render with an icon and every point with an info badge', () => {
    const { w } = mountSettings()
    const h2s = w.findAll('h2')
    expect(h2s.length).toBeGreaterThan(0)
    for (const h of h2s) {
      expect(h.element.outerHTML).toContain('app-icon')
    }
    const links = w.findAll('a')
    expect(links.length).toBeGreaterThan(0)
    const badges = w.element.querySelectorAll('.info-hint')
    expect(badges.length).toBe(links.length)
  })

  it('the live filter narrows the menu points (backup matches)', () => {
    const { w } = mountSettings({ initialQuery: 'backup' })
    const links = w.findAll('a').map((a) => a.attributes('href'))
    expect(links).toStrictEqual(['/einstellungen/backup'])
  })

  it('the live filter hides everything without a match', () => {
    const { w } = mountSettings({ initialQuery: 'qqzzx' })
    expect(w.findAll('a')).toHaveLength(0)
    expect(w.text()).toContain('No menu point matched')
  })
})
