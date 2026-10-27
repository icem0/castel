// Tests for the in-memory progress registry.
//
// Regression: the registry entry was only created when a browser
// subscribed to the SSE endpoint. Since the import runs inline in the
// upload request, the browser always subscribed TOO LATE — the progress
// ticks were dropped and the 'fertig' flag was lost. The SSE stream then
// never closed and the upload button stayed disabled forever.

import { describe, expect, it, beforeEach } from 'vitest'
import {
  istFertig,
  kanalFuer,
  letzterFortschritt,
  meldeFertig,
  meldeFortschritt,
  resetProgressRegistry,
} from '../progress.js'

describe('DATANORM Fortschritts-Registry', () => {
  beforeEach(() => {
    resetProgressRegistry()
  })

  it('haelt den letzten Tick fest, auch ohne Abonnenten', () => {
    kanalFuer('imp-1')
    meldeFortschritt({
      importId: 'imp-1',
      phase: 'parse',
      verarbeitet: 5,
      gesamt: 10,
      fehler: 0,
    })
    expect(letzterFortschritt('imp-1')).toMatchObject({ phase: 'parse', verarbeitet: 5 })
  })

  it('merkt sich "fertig" auch ohne vorherigen Abonnenten', () => {
    meldeFertig('imp-2')
    expect(istFertig('imp-2')).toBe(true)
  })

  it('meldet einen spaeten Abonnenten sofort als fertig', () => {
    meldeFertig('imp-3')
    // Der SSE-Endpoint fragt zuerst istFertig() und schliesst dann.
    expect(istFertig('imp-3')).toBe(true)
    expect(letzterFortschritt('imp-3')).toBeNull()
  })

  it('loest das Abschluss-Event aus, auch ohne Abonnenten', () => {
    const ereignisse: unknown[] = []
    const kanal = kanalFuer('imp-4')
    kanal.on('abschluss', (d) => ereignisse.push(d))
    meldeFertig('imp-4', 'Kaputt')
    expect(ereignisse).toEqual([{ fehler: 'Kaputt' }])
  })
})
