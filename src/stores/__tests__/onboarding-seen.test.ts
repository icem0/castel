// Tests für das per-User-Tutorial-Gate (`onboardingSeen`).
//
// Erwartung:
//   - Default: onboardingSeen === false (Tutorial zeigen)
//   - Per-User isoliert: User A "fertig" => User B sieht Tutorial beim Login
//   - Setzen via setOnboardingSeen(true) => Store reflektiert true
//   - Zurücksetzen via setOnboardingSeen(false) => Store reflektiert false
//   - Cross-Device-Sync: queueOp wird aufgerufen (Outbox-Eintrag), damit der
//     Server den Wert per LWW an alle Geräte des Users verteilt.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import 'fake-indexeddb/auto'

// `queueOp` mocken, damit wir den Sync-Pfad prüfen können. `vi.hoisted` ist
// nötig, weil `vi.mock` Factory-Calls an den Anfang der Datei gehoben
// werden — die Spy-Referenz muss also bereits dort verfügbar sein.
const { queueOpMock } = vi.hoisted(() => ({
  queueOpMock: vi.fn(),
}))
vi.mock('../../services/sync/worker', () => ({
  queueOp: queueOpMock,
}))

import { useSettingsStore } from '../settings'
import { getDb, resetDbForTests } from '../../db/database'
import { jetztIso } from '../../domain/ids'
import { sessionSchreiben } from '../../auth/session'

const LS_SESSION = 'castel.auth.session'

describe('useSettingsStore — onboardingSeen (Tutorial-Gate)', () => {
  beforeEach(() => {
    resetDbForTests()
    setActivePinia(createPinia())
    localStorage.removeItem(LS_SESSION)
    queueOpMock.mockReset()
  })

  afterEach(() => {
    localStorage.removeItem(LS_SESSION)
  })

  it('Default: onboardingSeen ist false (Tutorial zeigen)', async () => {
    sessionSchreiben({
      userId: 'user-a',
      email: 'a@example.com',
      rolle: 'user',
      anzeigename: 'A',
      loginAm: jetztIso(),
      mustChangePassword: false,
      jwtExpiresAt: jetztIso(),
    })
    const store = useSettingsStore()
    store.start()
    await new Promise<void>((r) => setTimeout(r, 30))
    expect(store.settings.onboardingSeen).toBe(false)
    store.stop()
  })

  it('setOnboardingSeen(true) wird im Store reflektiert', async () => {
    sessionSchreiben({
      userId: 'user-a',
      email: 'a@example.com',
      rolle: 'user',
      anzeigename: 'A',
      loginAm: jetztIso(),
      mustChangePassword: false,
      jwtExpiresAt: jetztIso(),
    })
    const store = useSettingsStore()
    store.start()
    await new Promise<void>((r) => setTimeout(r, 30))
    expect(store.settings.onboardingSeen).toBe(false)

    await store.setOnboardingSeen(true)
    await new Promise<void>((r) => setTimeout(r, 30))
    expect(store.settings.onboardingSeen).toBe(true)

    // Persistiert: in der DB liegt ein Eintrag (key+userId=user-a)
    const row = await getDb().einstellungen.get(['onboardingSeen', 'user-a'])
    expect(row?.value).toBe('true')

    store.stop()
  })

  it('setOnboardingSeen(false) macht das Tutorial wieder sichtbar', async () => {
    sessionSchreiben({
      userId: 'user-a',
      email: 'a@example.com',
      rolle: 'user',
      anzeigename: 'A',
      loginAm: jetztIso(),
      mustChangePassword: false,
      jwtExpiresAt: jetztIso(),
    })
    const store = useSettingsStore()
    store.start()
    await new Promise<void>((r) => setTimeout(r, 30))

    await store.setOnboardingSeen(true)
    await new Promise<void>((r) => setTimeout(r, 30))
    expect(store.settings.onboardingSeen).toBe(true)

    await store.setOnboardingSeen(false)
    await new Promise<void>((r) => setTimeout(r, 30))
    expect(store.settings.onboardingSeen).toBe(false)

    store.stop()
  })

  it('Per-User-Isolation: user-a "fertig" blendet das Tutorial für user-b nicht aus', async () => {
    // user-a hat das Tutorial gesehen.
    await getDb().einstellungen.put({
      key: 'onboardingSeen',
      userId: 'user-a',
      value: 'true',
      geaendertAm: jetztIso(),
    })

    // user-b loggt sich ein und darf das Tutorial noch sehen.
    sessionSchreiben({
      userId: 'user-b',
      email: 'b@example.com',
      rolle: 'user',
      anzeigename: 'B',
      loginAm: jetztIso(),
      mustChangePassword: false,
      jwtExpiresAt: jetztIso(),
    })
    const store = useSettingsStore()
    store.start()
    await new Promise<void>((r) => setTimeout(r, 30))
    expect(store.settings.onboardingSeen).toBe(false)
    store.stop()

    // Zurück zu user-a: sieht true.
    sessionSchreiben({
      userId: 'user-a',
      email: 'a@example.com',
      rolle: 'user',
      anzeigename: 'A',
      loginAm: jetztIso(),
      mustChangePassword: false,
      jwtExpiresAt: jetztIso(),
    })
    const store2 = useSettingsStore()
    store2.start()
    await new Promise<void>((r) => setTimeout(r, 30))
    expect(store2.settings.onboardingSeen).toBe(true)
    store2.stop()
  })

  it('onboardingSeen wird per Outbox zum Server synchronisiert', async () => {
    sessionSchreiben({
      userId: 'user-a',
      email: 'a@example.com',
      rolle: 'user',
      anzeigename: 'A',
      loginAm: jetztIso(),
      mustChangePassword: false,
      jwtExpiresAt: jetztIso(),
    })
    const store = useSettingsStore()
    store.start()
    await new Promise<void>((r) => setTimeout(r, 30))

    await store.setOnboardingSeen(true)
    await new Promise<void>((r) => setTimeout(r, 30))

    // Persistiert lokal …
    const row = await getDb().einstellungen.get(['onboardingSeen', 'user-a'])
    expect(row?.value).toBe('true')

    // … und in den Sync-Pfad geschoben: queueOp wird mit dem korrekten
    // (key, userId, value)-Tripel aufgerufen, damit der Server den Wert
    // per LWW auf alle Geräte des Users verteilt. Die echte Outbox-Tabelle
    // bleibt in diesem Unit-Test leer, weil queueOp gemockt ist — der
    // Mock-Aufruf ist hier die maßgebliche Aussage.
    expect(queueOpMock).toHaveBeenCalledTimes(1)
    expect(queueOpMock).toHaveBeenCalledWith(
      'einstellung',
      'upsert',
      expect.objectContaining({
        key: 'onboardingSeen',
        userId: 'user-a',
        value: 'true',
      }),
    )

    // Zurücksetzen erzeugt einen zweiten queueOp-Aufruf mit value='false'.
    await store.setOnboardingSeen(false)
    await new Promise<void>((r) => setTimeout(r, 30))
    expect(queueOpMock).toHaveBeenCalledTimes(2)
    expect(queueOpMock.mock.calls[1]?.[2]).toMatchObject({
      key: 'onboardingSeen',
      userId: 'user-a',
      value: 'false',
    })

    store.stop()
  })

  // ---------- firstLoginDone ----------
  // Der per-User-Marker `firstLoginDone` ist die zuverlässige Bremse
  // gegen das "Modal blitzt auf und ist sofort wieder weg"-Symptom.
  // Er wird gesetzt, sobald das Onboarding-Modal einmal gezeigt oder
  // bewusst ausgelassen wurde, und blockiert Folge-Anzeigen auch dann,
  // wenn die lokale DB die `onboardingSeen=true`-Zeile noch nicht
  // vom Server gepullt hat.

  it('Default: firstLoginDone ist false', async () => {
    sessionSchreiben({
      userId: 'user-a',
      email: 'a@example.com',
      rolle: 'user',
      anzeigename: 'A',
      loginAm: jetztIso(),
      mustChangePassword: false,
      jwtExpiresAt: jetztIso(),
    })
    const store = useSettingsStore()
    store.start()
    await new Promise<void>((r) => setTimeout(r, 30))
    expect(store.settings.firstLoginDone).toBe(false)
    store.stop()
  })

  it('setFirstLoginDone(true) wird im Store reflektiert und synchronisiert', async () => {
    sessionSchreiben({
      userId: 'user-a',
      email: 'a@example.com',
      rolle: 'user',
      anzeigename: 'A',
      loginAm: jetztIso(),
      mustChangePassword: false,
      jwtExpiresAt: jetztIso(),
    })
    const store = useSettingsStore()
    store.start()
    await new Promise<void>((r) => setTimeout(r, 30))

    await store.setFirstLoginDone(true)
    await new Promise<void>((r) => setTimeout(r, 30))

    expect(store.settings.firstLoginDone).toBe(true)
    const row = await getDb().einstellungen.get(['firstLoginDone', 'user-a'])
    expect(row?.value).toBe('true')

    // Cross-Device-Sync: auch dieser Marker wird per LWW verteilt.
    expect(queueOpMock).toHaveBeenCalledWith(
      'einstellung',
      'upsert',
      expect.objectContaining({
        key: 'firstLoginDone',
        userId: 'user-a',
        value: 'true',
      }),
    )

    store.stop()
  })

  it('Per-User-Isolation: firstLoginDone für user-a blendet nichts für user-b aus', async () => {
    await getDb().einstellungen.put({
      key: 'firstLoginDone',
      userId: 'user-a',
      value: 'true',
      geaendertAm: jetztIso(),
    })

    sessionSchreiben({
      userId: 'user-b',
      email: 'b@example.com',
      rolle: 'user',
      anzeigename: 'B',
      loginAm: jetztIso(),
      mustChangePassword: false,
      jwtExpiresAt: jetztIso(),
    })
    const store = useSettingsStore()
    store.start()
    await new Promise<void>((r) => setTimeout(r, 30))
    expect(store.settings.firstLoginDone).toBe(false)
    store.stop()

    sessionSchreiben({
      userId: 'user-a',
      email: 'a@example.com',
      rolle: 'user',
      anzeigename: 'A',
      loginAm: jetztIso(),
      mustChangePassword: false,
      jwtExpiresAt: jetztIso(),
    })
    const store2 = useSettingsStore()
    store2.start()
    await new Promise<void>((r) => setTimeout(r, 30))
    expect(store2.settings.firstLoginDone).toBe(true)
    store2.stop()
  })
})
