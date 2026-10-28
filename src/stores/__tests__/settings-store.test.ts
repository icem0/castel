// Regression-Tests für useSettingsStore: die Subscription muss die
// aktuelle userId bei jedem Update frisch aus der Session lesen, nicht
// in der Closure festhalten. Sonst ignoriert sie nach einem Login die
// frisch gespeicherte per-User-Einstellung, weil sie noch mit der
// userId=null aus der Pre-Login-Startphase filtert (Settings-View
// "Standard-Standort" blieb "noch nicht festgelegt").

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import 'fake-indexeddb/auto'
import { useSettingsStore } from '../settings'
import { getDb, resetDbForTests, setDb } from '../../db/database'
import { jetztIso } from '../../domain/ids'
import { sessionSchreiben } from '../../auth/session'
import type { Einstellung } from '../../db/types'

const LS_SESSION = 'castel.auth.session'

describe('useSettingsStore — currentUserId wird dynamisch gelesen', () => {
  beforeEach(() => {
    resetDbForTests()
    setDb(getDb())
    setActivePinia(createPinia())
    localStorage.removeItem(LS_SESSION)
  })

  afterEach(() => {
    localStorage.removeItem(LS_SESSION)
  })

  it('zeigt per-User-Einstellung nach Login an (Subscription startete vor Login mit userId=null)', async () => {
    const store = useSettingsStore()

    // 1. Subscription starten BEVOR ein User eingeloggt ist (wie in main.ts).
    //    currentUserId wird in der alten (gebrokenen) Implementierung als
    //    null in der Closure eingefroren.
    store.start()

    // Kurz warten, bis das initiale liveQuery-Emit durchgelaufen ist.
    await new Promise<void>((r) => setTimeout(r, 10))
    expect(store.settings.standardStandortId).toBeNull()

    // 2. User loggt sich ein (Session wird in localStorage geschrieben).
    sessionSchreiben({
      userId: 'user-a',
      email: 'a@example.com',
      rolle: 'user',
      anzeigename: 'A',
      loginAm: jetztIso(),
      mustChangePassword: false,
      jwtExpiresAt: jetztIso(),
    })

    // 3. Per-User-Einstellung direkt in die DB schreiben (so wie
    //    setStandardStandort() es täte).
    const now = jetztIso()
    const row: Einstellung = {
      key: 'standardStandortId',
      userId: 'user-a',
      value: 'standort-xyz',
      geaendertAm: now,
    }
    await getDb().einstellungen.put({ ...row, userId: 'user-a' })

    // 4. liveQuery muss den Store aktualisieren — und zwar mit dem
    //    aktuellen userId, nicht dem eingefrorenen null.
    await new Promise<void>((r) => setTimeout(r, 50))
    expect(store.settings.standardStandortId).toBe('standort-xyz')

    store.stop()
  })

  it('blendet per-User-Einstellungen eines anderen Users weiterhin aus', async () => {
    const store = useSettingsStore()
    store.start()

    sessionSchreiben({
      userId: 'user-b',
      email: 'b@example.com',
      rolle: 'user',
      anzeigename: 'B',
      loginAm: jetztIso(),
      mustChangePassword: false,
      jwtExpiresAt: jetztIso(),
    })

    const now = jetztIso()
    // Einstellung von user-a liegt in der DB. user-b darf sie NICHT sehen.
    await getDb().einstellungen.put({
      key: 'standardStandortId',
      userId: 'user-a',
      value: 'standort-von-a',
      geaendertAm: now,
    })
    // Einstellung von user-b wird korrekt übernommen.
    await getDb().einstellungen.put({
      key: 'standardStandortId',
      userId: 'user-b',
      value: 'standort-von-b',
      geaendertAm: now,
    })

    await new Promise<void>((r) => setTimeout(r, 50))
    expect(store.settings.standardStandortId).toBe('standort-von-b')

    store.stop()
  })

  it('reagiert auf Logout: per-User-Einstellungen verschwinden wieder', async () => {
    const store = useSettingsStore()
    store.start()

    sessionSchreiben({
      userId: 'user-c',
      email: 'c@example.com',
      rolle: 'user',
      anzeigename: 'C',
      loginAm: jetztIso(),
      mustChangePassword: false,
      jwtExpiresAt: jetztIso(),
    })

    await getDb().einstellungen.put({
      key: 'standardStandortId',
      userId: 'user-c',
      value: 'standort-c',
      geaendertAm: jetztIso(),
    })
    await new Promise<void>((r) => setTimeout(r, 50))
    expect(store.settings.standardStandortId).toBe('standort-c')

    // Logout: Session entfernen. Subscription läuft weiter, muss jetzt
    // aber wieder mit userId=null filtern. Wir lösen den liveQuery-Callback
    // aus, indem wir die per-user-Zeile löschen — das simuliert, dass der
    // Auth-Store bei Logout den settings.stop() / settings.start()-Pfad
    // durchläuft (in Produktion würde App.vue das über watchEffect tun).
    sessionSchreiben(null)
    await getDb().einstellungen.delete(['standardStandortId', 'user-c'])
    await new Promise<void>((r) => setTimeout(r, 50))
    expect(store.settings.standardStandortId).toBeNull()

    store.stop()
  })
})

// Die Sprache ist eine per-User-Einstellung. Ihre Wirkung ist rein
// clientseitig (die UI schaltet sofort um), der Server speichert sie nur
// als Sync-Metadatum pro User.
describe('useSettingsStore — sprache (per User)', () => {
  beforeEach(() => {
    resetDbForTests()
    setDb(getDb())
    setActivePinia(createPinia())
    localStorage.removeItem(LS_SESSION)
  })

  afterEach(() => {
    localStorage.removeItem(LS_SESSION)
  })

  function login(userId: string): void {
    sessionSchreiben({
      userId,
      email: `${userId}@example.com`,
      rolle: 'user',
      anzeigename: userId,
      loginAm: jetztIso(),
      mustChangePassword: false,
      jwtExpiresAt: jetztIso(),
    })
  }

  it('setSprache schreibt eine per-User-Zeile (userId = aktueller User)', async () => {
    const store = useSettingsStore()
    store.start()
    login('user-lang')

    await store.setSprache('en')

    const row = await getDb().einstellungen.get(['sprache', 'user-lang'])
    expect(row?.value).toBe('en')
    // Kein globaler Wert: die Sprache darf nicht von anderen Usern
    // übernommen werden.
    const globalRow = await getDb().einstellungen.get(['sprache', ''])
    expect(globalRow).toBeUndefined()

    store.stop()
  })

  it('setSprache ohne Session schreibt nichts (kein ungewollter globaler Wert)', async () => {
    const store = useSettingsStore()
    store.start()

    // Die fake-indexeddb-Daten überleben innerhalb der Testdatei, wir
    // messen also die Änderung statt eines Absolutwerts.
    const vorher = await getDb().einstellungen.where('key').equals('sprache').count()
    await store.setSprache('en')
    const nachher = await getDb().einstellungen.where('key').equals('sprache').count()

    expect(nachher).toBe(vorher)
    // Insbesondere keine globale Zeile, die ein später angemeldeter User
    // als eigene Sprache erben würde.
    expect(await getDb().einstellungen.get(['sprache', ''])).toBeUndefined()

    store.stop()
  })

  it('liest die Server-Schreibweise "en-US"/"de-DE" als "en"/"de"', async () => {
    const store = useSettingsStore()
    store.start()
    login('user-locale')

    // Der Setup-Pfad des Servers schreibt 'de-DE'/'en-US' (siehe
    // server/src/auth/setup-routes.ts), der Client selbst 'de'/'en'.
    await getDb().einstellungen.put({
      key: 'sprache',
      userId: 'user-locale',
      value: 'en-US',
      geaendertAm: jetztIso(),
    })

    await new Promise<void>((r) => setTimeout(r, 50))
    expect(store.settings.sprache).toBe('en')

    await getDb().einstellungen.put({
      key: 'sprache',
      userId: 'user-locale',
      value: 'de-DE',
      geaendertAm: jetztIso(),
    })

    await new Promise<void>((r) => setTimeout(r, 50))
    expect(store.settings.sprache).toBe('de')

    store.stop()
  })
})

// The theme used to live in localStorage and applied to all users of a
// device. It is now a per-user setting (synced like the language) and the
// old value is migrated once per user.
describe('useSettingsStore — theme (per User)', () => {
  beforeEach(() => {
    resetDbForTests()
    setDb(getDb())
    setActivePinia(createPinia())
    localStorage.removeItem(LS_SESSION)
    localStorage.removeItem('theme')
  })

  afterEach(() => {
    localStorage.removeItem(LS_SESSION)
    localStorage.removeItem('theme')
  })

  function login(userId: string): void {
    sessionSchreiben({
      userId,
      email: `${userId}@example.com`,
      rolle: 'user',
      anzeigename: userId,
      loginAm: jetztIso(),
      mustChangePassword: false,
      jwtExpiresAt: jetztIso(),
    })
  }

  it('setTheme schreibt eine per-User-Zeile (userId = aktueller User)', async () => {
    const store = useSettingsStore()
    store.start()
    login('user-theme')

    await store.setTheme('light')

    const row = await getDb().einstellungen.get(['theme', 'user-theme'])
    expect(row?.value).toBe('light')
    expect(await getDb().einstellungen.get(['theme', ''])).toBeUndefined()

    store.stop()
  })

  it('liest nur gültige Werte und fällt sonst auf den Default zurück', async () => {
    const store = useSettingsStore()
    store.start()
    login('user-theme-invalid')

    await getDb().einstellungen.put({
      key: 'theme',
      userId: 'user-theme-invalid',
      value: 'neon',
      geaendertAm: jetztIso(),
    })

    await new Promise<void>((r) => setTimeout(r, 50))
    expect(store.settings.theme).toBe('dark')

    await getDb().einstellungen.put({
      key: 'theme',
      userId: 'user-theme-invalid',
      value: 'auto',
      geaendertAm: jetztIso(),
    })

    await new Promise<void>((r) => setTimeout(r, 50))
    expect(store.settings.theme).toBe('auto')

    store.stop()
  })

  it('migriert die alte localStorage-Wahl einmalig in die Per-User-Zeile', async () => {
    localStorage.setItem('theme', 'light')
    const store = useSettingsStore()
    store.start()
    login('user-theme-legacy')

    await new Promise<void>((r) => setTimeout(r, 80))

    const row = await getDb().einstellungen.get(['theme', 'user-theme-legacy'])
    expect(row?.value).toBe('light')
    expect(localStorage.getItem('theme')).toBeNull()
    expect(store.settings.theme).toBe('light')

    store.stop()
  })

  it('überschreibt eine vorhandene Per-User-Zeile nicht mit der Legacy-Wahl', async () => {
    await getDb().einstellungen.put({
      key: 'theme',
      userId: 'user-theme-existing',
      value: 'auto',
      geaendertAm: jetztIso(),
    })
    localStorage.setItem('theme', 'light')
    const store = useSettingsStore()
    store.start()
    login('user-theme-existing')

    await new Promise<void>((r) => setTimeout(r, 80))

    const row = await getDb().einstellungen.get(['theme', 'user-theme-existing'])
    expect(row?.value).toBe('auto')

    store.stop()
  })
})

// The Akkutausch tool is opt-in and the switch is a global admin setting.
describe('useSettingsStore — akkutauschAktiv (global)', () => {
  beforeEach(() => {
    resetDbForTests()
    setDb(getDb())
    setActivePinia(createPinia())
    localStorage.removeItem(LS_SESSION)
  })

  afterEach(() => {
    localStorage.removeItem(LS_SESSION)
  })

  it('ist standardmäßig deaktiviert', async () => {
    const store = useSettingsStore()
    store.start()
    await new Promise<void>((r) => setTimeout(r, 20))

    expect(store.settings.akkutauschAktiv).toBe(false)

    store.stop()
  })

  it('setAkkutauschAktiv schreibt eine globale Zeile (userId = "")', async () => {
    const store = useSettingsStore()
    store.start()

    await store.setAkkutauschAktiv(true)

    const row = await getDb().einstellungen.get(['akkutauschAktiv', ''])
    expect(row?.value).toBe('true')
    // Nicht an den User gebunden — die Sichtbarkeit gilt app-weit.
    expect(await getDb().einstellungen.get(['akkutauschAktiv', 'user-x'])).toBeUndefined()

    store.stop()
  })
})
