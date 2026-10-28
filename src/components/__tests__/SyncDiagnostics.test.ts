// Tests für die Sync-Fehleranalyse (SyncDiagnostics.vue).
//
// Die Komponente ist die "vernünftige Fehlerausgabe": sie muss Findings,
// alle Tabellen, ausstehende Ops und nur-lokal vorhandene Datensätze
// anzeigen — und eine manuelle Analyse auslösen können.

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SyncDiagnostics from '../SyncDiagnostics.vue'
import { useSyncStore } from '../../stores/sync'
import type { SyncDiagnostics as Diagnostics, SyncStatus } from '../../services/sync/worker'

const runDiagnosticsMock = vi.fn()

vi.mock('../../services/sync/worker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/sync/worker')>()
  return {
    ...actual,
    runDiagnostics: (...args: unknown[]) => runDiagnosticsMock(...args),
  }
})

function diagnostics(overrides: Partial<Diagnostics> = {}): Diagnostics {
  return {
    at: '2026-10-28T08:00:00.000Z',
    tables: [
      { table: 'artikel', local: 145, server: 143 },
      { table: 'buchungen', local: 50, server: 50 },
    ],
    divergent: true,
    localOnly: [{ entity: 'artikel', id: 'aaaaaaaa-1111', label: 'Nur lokal' }],
    localOnlyTotal: 1,
    pendingItems: [],
    pendingTotal: 0,
    missingBookings: [],
    missingBookingsTotal: 0,
    quarantinedItems: [],
    findings: [{ level: 'error', text: '2 artikel: nur lokal vorhanden (lokal 145, Server 143).' }],
    idCheckUnsupported: false,
    serverReachable: true,
    ...overrides,
  }
}

async function mountMit(diag: Diagnostics | null) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useSyncStore()
  store.status = {
    ...store.status,
    diagnostics: diag,
  } as SyncStatus
  const wrapper = mount(SyncDiagnostics, { global: { plugins: [pinia] } })
  await flushPromises()
  return { wrapper, store }
}

describe('SyncDiagnostics', () => {
  beforeEach(() => {
    runDiagnosticsMock.mockReset()
    runDiagnosticsMock.mockResolvedValue(diagnostics())
  })

  it('zeigt Befunde, alle Tabellen und nur-lokale Datensätze', async () => {
    const { wrapper } = await mountMit(diagnostics())

    const text = wrapper.text()
    expect(text).toContain('Fehleranalyse')
    expect(text).toContain('nur lokal vorhanden (lokal 145, Server 143)')
    expect(text).toContain('artikel')
    expect(text).toContain('145')
    expect(text).toContain('143')
    expect(text).toContain('Nur lokal')
  })

  it('zeigt ausstehende Ops mit letztem Server-Fehler', async () => {
    const { wrapper } = await mountMit(
      diagnostics({
        pendingTotal: 1,
        pendingItems: [
          {
            outboxId: 'o1',
            entity: 'artikel',
            op: 'create',
            payloadId: 'bbbbbbbb-2222',
            label: 'Neuer Artikel',
            attempts: 3,
            lastError: 'VALIDATION: unbekannte Referenz',
            createdAt: '2026-10-28T07:00:00.000Z',
          },
        ],
      }),
    )

    const text = wrapper.text()
    expect(text).toContain('Ausstehende Änderungen')
    expect(text).toContain('Neuer Artikel')
    expect(text).toContain('VALIDATION: unbekannte Referenz')
  })

  it('meldet einen alten Server, der die ID-Prüfung nicht kennt', async () => {
    const { wrapper } = await mountMit(
      diagnostics({
        idCheckUnsupported: true,
        localOnly: [],
        localOnlyTotal: 0,
        findings: [
          {
            level: 'warn',
            text: 'Der Server unterstützt die ID-Prüfung noch nicht (alte Server-Version).',
          },
        ],
      }),
    )

    expect(wrapper.text()).toContain('ID-Prüfung noch nicht')
  })

  it('startet auf Knopfdruck eine neue Analyse', async () => {
    const { wrapper } = await mountMit(null)

    expect(wrapper.text()).toContain('Fehleranalyse ausführen')
    await wrapper.find('button').trigger('click')
    await flushPromises()

    expect(runDiagnosticsMock).toHaveBeenCalledTimes(1)
  })
})
