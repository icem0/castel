// Tests fuer den Backup-Cron-Slot-Check.
//
// `tagesSlotFuer(now, schedule)` ist die pure Logik, die entscheidet, ob
// der Cron-Tick ueberhaupt faellig ist und welchen Tages-Slot (Claim-Key
// `backup.lastSlot`) er dabei verwendet. Wir testen sie ausfuehrlich, weil
// ein falscher Tick (z. B. 24x pro Tag oder ein Slot-String, der über
// Mitternacht wandert) Backups zerschiesst.

import { describe, expect, it } from 'vitest'
import { tagesSlotFuer } from '../backup-cron-slot.js'

describe('tagesSlotFuer', () => {
  it('liefert null fuer leeres Schedule (Cron aus)', () => {
    expect(tagesSlotFuer(new Date(2026, 9, 19, 2, 0, 0), '')).toBeNull()
  })

  it('liefert null fuer ungueltiges Format', () => {
    expect(tagesSlotFuer(new Date(2026, 9, 19, 2, 0, 0), '25:99')).toBeNull()
    expect(tagesSlotFuer(new Date(2026, 9, 19, 2, 0, 0), 'mal')).toBeNull()
    expect(tagesSlotFuer(new Date(2026, 9, 19, 2, 0, 0), '2:00')).toBeNull()
  })

  it('liefert null, bevor der Slot heute erreicht ist', () => {
    expect(tagesSlotFuer(new Date(2026, 9, 19, 1, 59, 59, 999), '02:00')).toBeNull()
  })

  it('liefert das Datum genau am Slot', () => {
    expect(tagesSlotFuer(new Date(2026, 9, 19, 2, 0, 0, 0), '02:00')).toBe('2026-10-19')
  })

  it('liefert dasselbe Datum spaeter am Slot-Tag (Catch-up nach Neustart)', () => {
    expect(tagesSlotFuer(new Date(2026, 9, 19, 15, 23, 11), '02:00')).toBe('2026-10-19')
  })

  it('Slot direkt nach Mitternacht: Datum ist der neue Tag', () => {
    expect(tagesSlotFuer(new Date(2026, 9, 20, 0, 0, 1), '00:00')).toBe('2026-10-20')
  })

  it('am Tag nach einem Lauf ist der Slot-ID eine neue (Claim moeglich)', () => {
    const vorgestern = tagesSlotFuer(new Date(2026, 9, 19, 2, 0, 30), '02:00')
    const gestern = tagesSlotFuer(new Date(2026, 9, 20, 2, 0, 30), '02:00')
    expect(vorgestern).toBe('2026-10-19')
    expect(gestern).toBe('2026-10-20')
    expect(gestern).not.toBe(vorgestern)
  })

  it('vor dem Slot am Folgetag: null, obwohl gestern gefeuert wurde', () => {
    // Neustart um 01:00, Schedule 02:00 — kein Backup, bis der Slot da ist.
    expect(tagesSlotFuer(new Date(2026, 9, 20, 1, 0, 0), '02:00')).toBeNull()
  })
})
