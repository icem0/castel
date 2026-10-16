// Tests für das per-User-Tutorial-Gate (`onboardingSeen`).
//
// Erwartung:
//   - Default: onboardingSeen === false (Tutorial zeigen)
//   - Per-User isoliert: User A "fertig" => User B sieht Tutorial beim Login
//   - Setzen via setOnboardingSeen(true) => Store reflektiert true
//   - Zurücksetzen via setOnboardingSeen(false) => Store reflektiert false

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import 'fake-indexeddb/auto'
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
})
