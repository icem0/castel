// Tests fuer den Backup-Cron-Slot-Check.
//
// `sollteJetztFeuern(now, schedule, lastRun)` ist die pure Logik, die
// entscheidet, ob der Cron-Tick heute schon gefeuert hat. Wir testen
// sie ausfuehrlich, weil ein falscher Tick (z. B. 24x pro Tag) Backups
// zerschiesst.

import { describe, expect, it } from 'vitest'
import { sollteJetztFeuern } from '../backup-cron-slot.js'

describe('sollteJetztFeuern', () => {
  it('lehnt leeres Schedule ab (Cron aus)', () => {
    expect(sollteJetztFeuern(new Date('2026-10-19T02:00:00'), '', null)).toBe(false)
  })

  it('lehnt ungueltiges Format ab', () => {
    expect(sollteJetztFeuern(new Date('2026-10-19T02:00:00'), '25:99', null)).toBe(false)
    expect(sollteJetztFeuern(new Date('2026-10-19T02:00:00'), 'mal', null)).toBe(false)
  })

  it('feuert nicht vor dem Slot heute', () => {
    const now = new Date('2026-10-19T01:59:00')
    expect(sollteJetztFeuern(now, '02:00', null)).toBe(false)
  })

  it('feuert genau am Slot heute', () => {
    const now = new Date('2026-10-19T02:00:00')
    expect(sollteJetztFeuern(now, '02:00', null)).toBe(true)
  })

  it('feuert spaeter am Slot-Tag', () => {
    const now = new Date('2026-10-19T15:23:11')
    expect(sollteJetztFeuern(now, '02:00', null)).toBe(true)
  })

  it('feuert NICHT, wenn heute schon gefeuert wurde', () => {
    const now = new Date('2026-10-19T15:23:11')
    const lastRun = new Date('2026-10-19T02:00:30')
    expect(sollteJetztFeuern(now, '02:00', lastRun)).toBe(false)
  })

  it('feuert am Folgetag, auch wenn lastRun vom Vortag ist', () => {
    const now = new Date('2026-10-20T02:00:30')
    const lastRun = new Date('2026-10-19T02:00:30')
    expect(sollteJetztFeuern(now, '02:00', lastRun)).toBe(true)
  })

  it('feuert NICHT, wenn lastRun genau heute 02:00:00 ist', () => {
    const now = new Date('2026-10-19T02:00:00')
    const lastRun = new Date('2026-10-19T02:00:00')
    expect(sollteJetztFeuern(now, '02:00', lastRun)).toBe(false)
  })

  it('feuert genau 1ms nach dem letzten Run VOR dem Slot', () => {
    const now = new Date(2026, 9, 19, 2, 0, 0, 1)
    const lastRun = new Date(2026, 9, 19, 1, 59, 59, 999)
    expect(sollteJetztFeuern(now, '02:00', lastRun)).toBe(true)
  })
})
