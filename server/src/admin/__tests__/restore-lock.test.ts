// Tests fuer den Restore-Wartungsmodus.
//
// Der Wartungsmodus blockiert die Sync-Endpunkte (/api/sync/push und
// /api/sync/snapshot), waehrend die Datenbank ersetzt wird. Ohne die
// Sperre wuerde ein gleichzeitiger Push den Vor-Restore-Stand in die
// frisch restaurierten Tabellen zurueckschreiben.

import { describe, expect, it } from 'vitest'
import {
  mitRestoreSperre,
  restoreGesperrt,
  restoreSperreAufheben,
  restoreSperreInfo,
  restoreSperreSetzen,
} from '../restore-lock.js'

describe('restore-lock', () => {
  it('ist am Anfang frei', () => {
    restoreSperreAufheben()
    expect(restoreGesperrt()).toBe(false)
    expect(restoreSperreInfo()).toBeNull()
  })

  it('blockiert waehrend der Sperre und gibt den Grund an', () => {
    restoreSperreSetzen('backup-restore')
    expect(restoreGesperrt()).toBe(true)
    expect(restoreSperreInfo()?.grund).toBe('backup-restore')
    restoreSperreAufheben()
    expect(restoreGesperrt()).toBe(false)
  })

  it('gibt die Sperre auch bei einem Fehler wieder frei', async () => {
    await expect(
      mitRestoreSperre('backup-restore', async () => {
        expect(restoreGesperrt()).toBe(true)
        throw new Error('pg_restore fehlgeschlagen')
      }),
    ).rejects.toThrow(/pg_restore fehlgeschlagen/)
    // Ohne das finally wuerde der Sync nach einem fehlgeschlagenen
    // Restore bis zum naechsten API-Neustart blockiert bleiben.
    expect(restoreGesperrt()).toBe(false)
  })

  it('liefert das Ergebnis des Callback zurueck', async () => {
    const wert = await mitRestoreSperre('backup-restore', async () => 'ok')
    expect(wert).toBe('ok')
    expect(restoreGesperrt()).toBe(false)
  })
})
