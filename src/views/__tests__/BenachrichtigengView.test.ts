// Tests for the new notification-settings page (moved out of the settings hub).
//
// Same contract as the old inline "Benachrichtigengs" block:
//   - Every role may follow its alarms and enable the signal itself.
//   - Role-based default: users start silent, admins start with sound on.
//   - Volume/repetition sliders hang below the master switch.
//   - A link to the full alarm event list stays present.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import BenachrichtigengView from '../BenachrichtigengView.vue'
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
    { path: '/einstellungen/benachrichtigengs', component: { template: '<div />' } },
    { path: '/einstellungen/mindestbestand', component: { template: '<div />' } },
  ],
})

function mountBenach() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const w = mount(BenachrichtigengView, {
    global: { plugins: [pinia, i18n, router] },
  })
  return w
}

describe('BenachrichtigengView — normal User', () => {
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

  it('shows the alarm switch (default off) and the event-list link', () => {
    const w = mountBenach()
    expect(w.text()).toContain('Alarm bei neuen Ereignissen')
    const checkbox = w.element.querySelector('input[type="checkbox"]') as HTMLInputElement | null
    expect(checkbox).not.toBeNull()
    expect(checkbox!.checked).toBe(false)
    // Volume and repetition hang below the master switch — off means gone.
    expect(w.element.querySelector('input[type="range"]')).toBeNull()
    expect(w.element.querySelector('a[href="/einstellungen/mindestbestand"]')).not.toBeNull()
  })
})

describe('BenachrichtigengView — Admin', () => {
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

  it('shows the alarm switch (default on) with volume and repetition', () => {
    const w = mountBenach()
    expect(w.text()).toContain('Alarm bei neuen Ereignissen')
    const checkbox = w.element.querySelector('input[type="checkbox"]') as HTMLInputElement | null
    expect(checkbox).not.toBeNull()
    expect(checkbox!.checked).toBe(true)
    expect(w.element.querySelector('input[type="range"]')).not.toBeNull()
    const link = w.element.querySelector('a[href="/einstellungen/mindestbestand"]')
    expect(link?.textContent).toContain('Alle Ereignisse anzeigen')
  })
})
