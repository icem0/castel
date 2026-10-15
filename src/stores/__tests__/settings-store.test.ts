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