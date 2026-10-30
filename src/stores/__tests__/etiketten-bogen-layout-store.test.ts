// Tests für den Store `etikettenBogenLayout` (Bogen-Layout im Barcode-Druck).
//
// Regression: das Layout liegt pro User genau einmal auf dem Server (unique
// auf `user_id`). Der Client kennt den Server-Stand nicht und queued deshalb
// `upsert` — ein `create`/`update` wurde vom Server ebenso abgelehnt wie ein
// `delete` mit reinem Identitaets-Payload. Beide Faelle bedeuten HTTP 400 auf
// den GESAMTEN Push und legen die ganze Outbox still.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import 'fake-indexeddb/auto'

const { queueOpMock } = vi.hoisted(() => ({ queueOpMock: vi.fn() }))
vi.mock('../../services/sync/worker', () => ({ queueOp: queueOpMock }))

import { useEtikettenBogenLayoutStore } from '../etikettenBogenLayout'
import { resetDbForTests, getDb } from '../../db/database'
import { jetztIso } from '../../domain/ids'
import { sessionSchreiben } from '../../auth/session'

const LS_SESSION = 'castel.auth.session'

const LAYOUT = {
  id: 'benutzerdefiniert',
  layout: 'raster' as const,
  cols: 2,
  rows: 5,
  labelW: 50,
  labelH: 25,
  gapX: 3,
  gapY: 1,
  marginX: null,
  marginY: null,
}

function eingeloggt(userId: string): void {
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

describe('useEtikettenBogenLayoutStore', () => {
  beforeEach(() => {
    resetDbForTests()
    setActivePinia(createPinia())
    localStorage.removeItem(LS_SESSION)
    queueOpMock.mockReset()
  })

  afterEach(() => {
    localStorage.removeItem(LS_SESSION)
  })

  it('queued ein upsert mit vollem Payload (Identitaet ist der User)', async () => {
    eingeloggt('user-a')
    const store = useEtikettenBogenLayoutStore()
    await store.setLayout(LAYOUT)

    expect(queueOpMock).toHaveBeenCalledTimes(1)
    expect(queueOpMock.mock.calls[0]?.[0]).toBe('etiketten_bogen_layout')
    expect(queueOpMock.mock.calls[0]?.[1]).toBe('upsert')
    expect(queueOpMock.mock.calls[0]?.[2]).toMatchObject({
      id: 'benutzerdefiniert',
      userId: 'user-a',
      layout: LAYOUT,
    })

    const row = await getDb().etikettenBogenLayout.get('benutzerdefiniert')
    expect(row?.layout).toEqual(LAYOUT)
  })

  it('queued ein delete mit vollem Datensatz (Reset auf Defaults)', async () => {
    eingeloggt('user-a')
    const store = useEtikettenBogenLayoutStore()
    await store.setLayout(LAYOUT)
    queueOpMock.mockClear()
    await store.deleteLayout()

    expect(queueOpMock).toHaveBeenCalledTimes(1)
    expect(queueOpMock.mock.calls[0]?.[1]).toBe('delete')
    // Der Server validiert das Payload-Schema — ein Payload nur aus
    // (id, userId) wurde abgelehnt.
    expect(queueOpMock.mock.calls[0]?.[2]).toMatchObject({
      id: 'benutzerdefiniert',
      userId: 'user-a',
      layout: LAYOUT,
      geaendertAm: expect.any(String),
      erstelltAm: expect.any(String),
    })
    expect(await getDb().etikettenBogenLayout.get('benutzerdefiniert')).toBeUndefined()
  })

  it('löscht ohne lokale Zeile keinen Sync-Op', async () => {
    eingeloggt('user-a')
    const store = useEtikettenBogenLayoutStore()
    await store.deleteLayout()
    expect(queueOpMock).not.toHaveBeenCalled()
  })

  it('ohne Session wird nichts geschrieben', async () => {
    const store = useEtikettenBogenLayoutStore()
    await store.setLayout(LAYOUT)
    expect(queueOpMock).not.toHaveBeenCalled()
    expect(await getDb().etikettenBogenLayout.get('benutzerdefiniert')).toBeUndefined()
  })
})
