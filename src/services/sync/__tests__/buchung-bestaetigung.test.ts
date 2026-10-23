import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { CastelDb, getDb, setDb } from '../../../db/database'
import type { OutboxEintrag } from '../../../db/types'
import { jetztIso, neueUuid } from '../../../domain/ids'

const mocks = vi.hoisted(() => ({
  triggerSyncNow: vi.fn().mockResolvedValue(undefined),
  getSyncStatus: vi.fn(),
}))

vi.mock('../worker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../worker')>()
  return {
    ...actual,
    triggerSyncNow: mocks.triggerSyncNow,
    getSyncStatus: mocks.getSyncStatus,
  }
})

import { syncUndBestaetigeBuchungen } from '../buchung-bestaetigung'

function outboxFuerBuchung(buchungId: string, patch: Partial<OutboxEintrag> = {}): Promise<string> {
  const row: OutboxEintrag = {
    id: neueUuid(),
    entity: 'buchung',
    op: 'create',
    payload: JSON.stringify({ id: buchungId }),
    createdAt: jetztIso(),
    syncedAt: null,
    attempts: 0,
    lastError: null,
    quarantinedAt: null,
    quarantineReason: null,
    ...patch,
  }
  return getDb()
    .outbox.add(row)
    .then(() => row.id)
}

describe('syncUndBestaetigeBuchungen', () => {
  beforeEach(() => {
    setDb(new CastelDb(`castel-bestaetigung-${Math.random().toString(36).slice(2)}`))
    mocks.triggerSyncNow.mockClear()
    mocks.getSyncStatus.mockReturnValue({
      status: 'idle',
      nextRetryAt: null,
      lastError: null,
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('meldet bestätigt, sobald alle Buchungen der Outbox synchronisiert sind', async () => {
    const a = neueUuid()
    const b = neueUuid()
    const syncedAt = jetztIso()
    await outboxFuerBuchung(a, { syncedAt })
    await outboxFuerBuchung(b, { syncedAt })

    const result = await syncUndBestaetigeBuchungen([a, b], {
      apiBase: 'http://test.local',
      token: null,
    })

    expect(result).toEqual({ status: 'bestaetigt' })
  })

  it('meldet offline sofort, ohne einen Sync zu starten', async () => {
    const id = neueUuid()
    await outboxFuerBuchung(id)
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)

    const result = await syncUndBestaetigeBuchungen([id], {
      apiBase: 'http://test.local',
      token: null,
      timeoutMs: 1_000,
    })

    expect(result).toEqual({ status: 'ausstehend', grund: 'offline', fehler: null })
    expect(mocks.triggerSyncNow).not.toHaveBeenCalled()
  })

  it('meldet eine Server-Ablehnung aus der Quarantäne', async () => {
    const id = neueUuid()
    await outboxFuerBuchung(id, {
      quarantinedAt: jetztIso(),
      quarantineReason: 'Server lehnt dauerhaft ab (UNKNOWN_REFERENCE)',
    })

    const result = await syncUndBestaetigeBuchungen([id], {
      apiBase: 'http://test.local',
      token: null,
    })

    expect(result.status).toBe('abgelehnt')
    if (result.status === 'abgelehnt') {
      expect(result.grund).toContain('UNKNOWN_REFERENCE')
    }
  })

  it('erkennt eine Ablehnung aus lastError (CONFLICT)', async () => {
    const id = neueUuid()
    await outboxFuerBuchung(id, { lastError: 'CONFLICT: Bestand zu niedrig', attempts: 1 })

    const result = await syncUndBestaetigeBuchungen([id], {
      apiBase: 'http://test.local',
      token: null,
    })

    expect(result).toMatchObject({ status: 'abgelehnt', grund: 'CONFLICT: Bestand zu niedrig' })
  })

  it('stößt einen Sync an und meldet nach dem Timeout ausstehend', async () => {
    const id = neueUuid()
    await outboxFuerBuchung(id)

    const result = await syncUndBestaetigeBuchungen([id], {
      apiBase: 'http://test.local',
      token: null,
      timeoutMs: 10,
    })

    expect(result).toMatchObject({ status: 'ausstehend', grund: 'timeout' })
    expect(mocks.triggerSyncNow).toHaveBeenCalledWith({
      apiBase: 'http://test.local',
      token: null,
    })
  })
})
