// Tests für die Sprach-Auswahl in der Sektion "Account" der Einstellungen.
//
// Erwartetes Verhalten:
//   - Der Sprach-Umschalter steht in der Kategorie "Account", nicht mehr
//     im allgemeinen Einstellungs-Formular.
//   - Die Auswahl wirkt sofort: der Wert landet in der lokalen DB
//     (IndexedDB) und die i18n-Locale wechselt ohne "Speichern"-Klick.
//   - Die Einstellung ist an den eingeloggten User gebunden (per-User-Key).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import SettingsView from '../SettingsView.vue'
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
    { path: '/einstellungen/user', component: { template: '<div />' } },
    { path: '/einstellungen/entwicklung', component: { template: '<div />' } },
    { path: '/einstellungen/artikel-typen', component: { template: '<div />' } },
    { path: '/einstellungen/kommissionen', component: { template: '<div />' } },
    { path: '/einstellungen/artikel-kataloge', component: { template: '<div />' } },
    { path: '/einstellungen/mindestbestand', component: { template: '<div />' } },
    { path: '/einstellungen/backup', component: { template: '<div />' } },
    { path: '/einstellungen/api-keys', component: { template: '<div />' } },
    { path: '/einstellungen/geraet', component: { template: '<div />' } },
    { path: '/akkutausch', component: { template: '<div />' } },
    { path: '/passwort-aendern', component: { template: '<div />' } },
    { path: '/info', component: { template: '<div />' } },
    { path: '/import', component: { template: '<div />' } },
    { path: '/etiketten', component: { template: '<div />' } },
    { path: '/standorte', component: { template: '<div />' } },
  ],
})

function mountSettings() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const w = mount(SettingsView, {
    global: { plugins: [pinia, i18n, router] },
  })
  return { w, pinia }
}

describe('SettingsView — Sprache in der Kategorie "Account"', () => {
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

  it('zeigt den Sprach-Umschalter in der Account-Sektion, nicht im oberen Formular', () => {
    const { w } = mountSettings()

    const selects = w.findAll('select')
    expect(selects.length).toBeGreaterThan(0)

    // Der Sprach-Umschalter ist der einzige Select mit den Sprach-Optionen.
    const sprachSelect = selects.find((s) =>
      s.findAll('option').some((o) => o.attributes('value') === 'en'),
    )
    expect(sprachSelect).toBeDefined()

    // Er steht in der Card unter der Ueberschrift "Account".
    const accountCard = w.findAll('h2').find((h) => h.text() === 'Account')
      ?.element?.nextElementSibling
    expect(accountCard).toBeDefined()
    expect((accountCard as HTMLElement).querySelector('select')).not.toBeNull()

    // Und nicht mehr im oberen Einstellungs-Formular (dort gibt es nur
    // noch den Standard-Standort- und den Barcode-Select).
    const form = w.find('form')
    const sprachSelectImForm = form
      .findAll('select')
      .find((s) => s.findAll('option').some((o) => o.attributes('value') === 'en'))
    expect(sprachSelectImForm).toBeUndefined()
  })

  it('zeigt den Theme-Umschalter in der Account-Sektion und speichert per User', async () => {
    const { w, pinia } = mountSettings()
    const store = useSettingsStore(pinia)
    store.start()

    const accountCard = w.findAll('h2').find((h) => h.text() === 'Account')?.element
      ?.nextElementSibling as HTMLElement | undefined
    expect(accountCard).toBeDefined()

    const themeSelect = Array.from(accountCard!.querySelectorAll('select')).find((s) =>
      Array.from(s.options).some((o) => o.value === 'auto'),
    )
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

  it('zeigt normalen Usern die Benachrichtigungen — Alarm standardmäßig aus', () => {
    const { w } = mountSettings()

    const ueberschrift = w.findAll('h2').find((h) => h.text() === 'Benachrichtigungen')
    expect(ueberschrift).toBeDefined()

    const karte = ueberschrift!.element.nextElementSibling as HTMLElement
    expect(karte).not.toBeNull()
    expect(karte.textContent).toContain('Alarm bei neuen Ereignissen')

    const checkbox = karte.querySelector('input[type="checkbox"]') as HTMLInputElement | null
    expect(checkbox).not.toBeNull()
    // Rollenabhängiger Default: User starten still und schalten selbst an.
    expect(checkbox!.checked).toBe(false)
    // Lautstärke und Wiederholung hängen am Master-Switch.
    expect(karte.querySelector('input[type="range"]')).toBeNull()

    // Tracking bleibt offen: Link zur vollständigen Ereignisliste.
    expect(karte.querySelector('a[href="/einstellungen/mindestbestand"]')).not.toBeNull()
  })

  it('zeigt den Akkutausch-Schalter nicht für normale User', () => {
    const { w } = mountSettings()
    expect(w.text()).not.toContain('Akkutausch-Tool aktivieren')
  })

  it('zeigt normalen Usern kein Standard-Standort-Feld', () => {
    const { w } = mountSettings()
    const form = w.find('form')
    expect(form.find('select').exists()).toBe(false)
    expect(w.text()).not.toContain('Standard-Standort')
  })

  it('versteckt normalen Usern CSV-Import, Backup und API-Keys', () => {
    const { w } = mountSettings()
    const links = w.findAll('a').map((a) => a.attributes('href'))
    expect(links).not.toContain('/import')
    expect(links).not.toContain('/einstellungen/backup')
    expect(links).not.toContain('/einstellungen/api-keys')
    // Der Geräte-Reset bleibt für jede Rolle erreichbar.
    expect(links).toContain('/einstellungen/geraet')
  })

  it('versteckt normalen Usern den Standort-Link im Stammdaten-Block', () => {
    const { w } = mountSettings()
    const links = w.findAll('a').map((a) => a.attributes('href'))
    expect(links).not.toContain('/standorte')
    // Nicht-Stammdaten-Punkte bleiben offen.
    expect(links).toContain('/einstellungen/artikel-kataloge')
    expect(links).toContain('/etiketten')
  })

  it('wendet die neue Sprache sofort an (lokal + i18n-Locale, ohne "Speichern")', async () => {
    const { w, pinia } = mountSettings()
    const store = useSettingsStore(pinia)
    store.start()
    bindSpracheAnLocale(() => store.settings.sprache)

    const sprachSelect = w
      .findAll('select')
      .find((s) => s.findAll('option').some((o) => o.attributes('value') === 'en'))
    expect(sprachSelect).toBeDefined()

    await sprachSelect!.setValue('en')
    // Der Store aktualisiert sich per liveQuery (asynchron) — kurz warten.
    await new Promise<void>((r) => setTimeout(r, 50))

    // 1) Lokal persistiert, an den eingeloggten User gebunden.
    const row = await getDb().einstellungen.get(['sprache', 'user-acc'])
    expect(row?.value).toBe('en')
    expect(await getDb().einstellungen.get(['sprache', ''])).toBeUndefined()

    // 2) Die i18n-Locale ist umgeschaltet — die UI zeigt ab sofort Englisch.
    expect(i18n.global.locale.value).toBe('en-US')
    expect(store.settings.sprache).toBe('en')

    store.stop()
  })
})

describe('SettingsView — Benachrichtigungen (Admin)', () => {
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

  it('zeigt die Mindestbestand-Benachrichtigungen samt Link zur Ereignisliste', () => {
    const { w } = mountSettings()

    const ueberschrift = w.findAll('h2').find((h) => h.text() === 'Benachrichtigungen')
    expect(ueberschrift).toBeDefined()

    const karte = ueberschrift!.element.nextElementSibling as HTMLElement
    expect(karte).not.toBeNull()
    expect(karte.textContent).toContain('Alarm bei neuen Ereignissen')
    expect(karte.querySelector('input[type="checkbox"]')).not.toBeNull()
    // Admin-Default: Alarm an → Lautstärke-Steller sichtbar.
    expect(karte.querySelector('input[type="range"]')).not.toBeNull()

    const link = karte.querySelector('a[href="/einstellungen/mindestbestand"]')
    expect(link).not.toBeNull()
    expect(link?.textContent).toContain('Alle Ereignisse anzeigen')
  })

  it('zeigt Admins den Akkutausch-Schalter in der Kategorie "Werkzeuge"', () => {
    const { w } = mountSettings()

    const ueberschrift = w.findAll('h2').find((h) => h.text() === 'Werkzeuge')
    expect(ueberschrift).toBeDefined()

    const karte = ueberschrift!.element.nextElementSibling as HTMLElement
    expect(karte).not.toBeNull()
    expect(karte.textContent).toContain('Akkutausch-Tool aktivieren')
    expect(karte.querySelector('input[type="checkbox"]')).not.toBeNull()
    // The tool is opt-in: the default checkbox state is unchecked.
    expect((karte.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(false)
  })

  it('zeigt Admins das Standard-Standort-Feld und die Admin-Links', () => {
    const { w } = mountSettings()

    const form = w.find('form')
    expect(form.find('select').exists()).toBe(true)

    const links = w.findAll('a').map((a) => a.attributes('href'))
    expect(links).toContain('/import')
    expect(links).toContain('/einstellungen/backup')
    expect(links).toContain('/einstellungen/api-keys')
    expect(links).toContain('/standorte')
  })
})
