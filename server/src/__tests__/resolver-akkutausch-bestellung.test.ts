// Tests für den Sync-Resolver der Akkutausch-Bestellungen
// (`akku_bestellung`).
//
// Kernpunkte:
//   * Das Archiv ist append-only: 'create' legt den Snapshot an, der Server
//     setzt `bestelltAm`.
//   * 'update' nimmt die Bestellung zurück ("rueckgaengig gemacht") —
//     NUR die letzte Bestellung darf storniert werden.
//   * Schreibzugriffe sind Admin-only.

import { describe, expect, it } from 'vitest'
import { resolvePush } from '../sync/resolver.js'

const DRIZZLE_NAME = Symbol.for('drizzle:Name')

function tableId(table: unknown): string {
  if (!table || typeof table !== 'object') return 'unknown'
  const v = (table as Record<symbol, unknown>)[DRIZZLE_NAME]
  if (typeof v === 'string') return v
  const t = table as Record<string, unknown>
  return typeof t.name === 'string' ? t.name : 'unknown'
}

function extractParams(node: unknown, out: unknown[] = [], seen = new Set<unknown>()): unknown[] {
  if (!node || typeof node !== 'object' || seen.has(node)) return out
  seen.add(node)
  const o = node as Record<string, unknown>
  if (o.constructor?.name === 'Param') out.push(o.value)
  if (Array.isArray(o.queryChunks)) o.queryChunks.forEach((c) => extractParams(c, out, seen))
  return out
}

interface MockState {
  bestellungen: Array<Record<string, unknown>>
  inserts: Array<Record<string, unknown>>
  updates: Array<Record<string, unknown>>
}

/**
 * Mock-DB: `select().from(...)` liefert die Zeilen der Tabelle. `where`
 * filtert nach der ID (die erste String-Param-Id), `orderBy` emuliert
 * `ORDER BY bestellt_am DESC` (neueste zuerst).
 */
function makeMockDb(state: MockState): never {
  const txMock = {
    select: () => ({
      from: (table: unknown) => {
        const id = tableId(table)
        const rows = id === 'akku_bestellungen' ? state.bestellungen : []
        return {
          where: (clause: unknown) => {
            const params = extractParams(clause).filter((p) => typeof p === 'string')
            return {
              limit: (n?: number) =>
                Promise.resolve(rows.filter((r) => r['id'] === params[0]).slice(0, n ?? undefined)),
            }
          },
          orderBy: () => ({
            limit: (n?: number) =>
              Promise.resolve(
                [...rows]
                  .sort((a, b) =>
                    String(b['bestelltAm']).localeCompare(String(a['bestelltAm'])),
                  )
                  .slice(0, n ?? undefined),
              ),
          }),
        }
      },
    }),
    insert: (table: unknown) => ({
      values: (value: Record<string, unknown>) => {
        state.inserts.push({ ...value, __table: tableId(table) })
        return Promise.resolve()
      },
    }),
    update: (table: unknown) => ({
      set: (value: Record<string, unknown>) => ({
        where: (clause: unknown) => {
          state.updates.push({ ...value, __table: tableId(table) })
          void extractParams(clause)
          return Promise.resolve()
        },
      }),
    }),
    delete: () => ({ where: () => Promise.resolve() }),
  }
  return {
    transaction: (fn: (tx: typeof txMock) => Promise<void>) => fn(txMock),
  } as never
}

function leererState(): MockState {
  return { bestellungen: [], inserts: [], updates: [] }
}

function bestellung(id: string, quartal: number, jahr: number): Record<string, unknown> {
  return {
    id,
    jahr,
    quartal,
    bestelltAm: new Date('2026-10-15T10:00:00.000Z'),
    bestelltVon: 'Max Mustermann',
    bestelltVonKuerzel: 'MM',
    inventurDatum: '2026-10-01',
    inventurVonKuerzel: 'MM',
    standortId: 's-1',
    storno: false,
    stornoAm: null,
    stornoVon: null,
    stornoVonKuerzel: null,
    zeilen: [
      {
        typId: 't1',
        artikelId: 'a-1',
        kapazitaetAh: 12.5,
        von: 12,
        bis: 12.9,
        soll: 10,
        bestand: 3,
        reserve: 2,
        verfuegbar: 1,
        bedarf: 9,
      },
    ],
  }
}

describe('resolvePush — akku_bestellung', () => {
  it('archiviert die Bestellung mit Server-Zeitstempel', async () => {
    const state = leererState()
    const payload = bestellung('b-1', 1, 2026)
    const result = await resolvePush(
      makeMockDb(state),
      [{ op: 'create', entity: 'akku_bestellung', payload }],
      'u1',
      'admin',
    )
    expect(result.errors).toHaveLength(0)
    expect(result.accepted).toEqual(['b-1'])
    const ins = state.inserts.find((r) => r['__table'] === 'akku_bestellungen')
    expect(ins).toMatchObject({ id: 'b-1', jahr: 2026, quartal: 1, standortId: 's-1', storno: false })
    expect(ins?.['bestelltAm']).toBeInstanceOf(Date)
    // Die Zeilen (inkl. Artikel-ID fuer die Puffer-Ruecknahme) werden uebernommen.
    expect(ins?.['zeilen']).toEqual(payload['zeilen'])
  })

  it('legt dieselbe Bestellung nicht doppelt an (Idempotenz)', async () => {
    const state = leererState()
    state.bestellungen = [bestellung('b-1', 1, 2026)]
    const result = await resolvePush(
      makeMockDb(state),
      [{ op: 'create', entity: 'akku_bestellung', payload: bestellung('b-1', 1, 2026) }],
      'u1',
      'admin',
    )
    expect(result.errors).toHaveLength(0)
    expect(state.inserts.filter((r) => r['__table'] === 'akku_bestellungen')).toHaveLength(0)
  })

  it('nimmt die letzte Bestellung zurueck', async () => {
    const state = leererState()
    state.bestellungen = [bestellung('b-2', 2, 2026), bestellung('b-1', 1, 2026)]
    const payload = { ...bestellung('b-2', 2, 2026), storno: true, stornoVon: 'Max Mustermann' }
    const result = await resolvePush(
      makeMockDb(state),
      [{ op: 'update', entity: 'akku_bestellung', payload }],
      'u1',
      'admin',
    )
    expect(result.errors).toHaveLength(0)
    expect(result.accepted).toEqual(['b-2'])
    const upd = state.updates.find((r) => r['__table'] === 'akku_bestellungen')
    expect(upd).toMatchObject({ storno: true, stornoVon: 'Max Mustermann' })
    expect(upd?.['stornoAm']).toBeInstanceOf(Date)
  })

  it('lehnt das Ruecknehmen einer aelteren Bestellung ab', async () => {
    const state = leererState()
    state.bestellungen = [bestellung('b-2', 2, 2026), bestellung('b-1', 1, 2026)]
    const payload = { ...bestellung('b-1', 1, 2026), storno: true }
    const result = await resolvePush(
      makeMockDb(state),
      [{ op: 'update', entity: 'akku_bestellung', payload }],
      'u1',
      'admin',
    )
    expect(result.accepted).toHaveLength(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.code).toBe('NICHT_LETZTE_BESTELLUNG')
    expect(state.updates).toHaveLength(0)
  })

  it('schluckt ein zweites Ruecknehmen derselben Bestellung', async () => {
    const state = leererState()
    state.bestellungen = [{ ...bestellung('b-1', 1, 2026), storno: true }]
    const payload = { ...bestellung('b-1', 1, 2026), storno: true }
    const result = await resolvePush(
      makeMockDb(state),
      [{ op: 'update', entity: 'akku_bestellung', payload }],
      'u1',
      'admin',
    )
    expect(result.errors).toHaveLength(0)
    expect(state.updates).toHaveLength(0)
  })

  it('lehnt das Ruecknehmen einer unbekannten Bestellung ab', async () => {
    const state = leererState()
    const payload = { ...bestellung('b-x', 1, 2026), storno: true }
    const result = await resolvePush(
      makeMockDb(state),
      [{ op: 'update', entity: 'akku_bestellung', payload }],
      'u1',
      'admin',
    )
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.code).toBe('VALIDATION')
    expect(state.updates).toHaveLength(0)
  })

  it('lehnt Schreibzugriffe von Mitarbeitern ab', async () => {
    const state = leererState()
    const payload = { ...bestellung('b-1', 1, 2026), storno: true }
    const result = await resolvePush(
      makeMockDb(state),
      [{ op: 'update', entity: 'akku_bestellung', payload }],
      'u1',
      'user',
    )
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.code).toBe('VALIDATION')
    expect(state.updates).toHaveLength(0)
  })

  it('schreibt einen Audit-Log-Eintrag fuer das Ruecknehmen', async () => {
    const state = leererState()
    state.bestellungen = [bestellung('b-1', 1, 2026)]
    const payload = { ...bestellung('b-1', 1, 2026), storno: true }
    await resolvePush(
      makeMockDb(state),
      [{ op: 'update', entity: 'akku_bestellung', payload }],
      'u1',
      'admin',
    )
    const audit = state.inserts.find((r) => r['__table'] === 'audit_log')
    expect(audit?.['entitaet']).toBe('akku_bestellung')
    expect(audit?.['entitaetId']).toBe('b-1')
    expect(audit?.['aktion']).toBe('update')
  })
})
