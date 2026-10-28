// Integration test for the daily backup-cron slot claim.
//
// The claim (`beansprucheTagesSlot`, marker `backup.lastSlot`) is the only
// guard that survives API restarts. The in-memory cron marker alone lost
// its protection on every boot — a crash-looping API (e.g. pg_dump OOM)
// re-fired the backup on every start: backups every few minutes. This test
// proves the DB claim is exactly-once per slot, even across repeated and
// parallel calls.
//
// Requires DATABASE_URL pointing at a migrated test database.

import { afterAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '../../db/client.js'
import { einstellungen } from '../../db/schema.js'
import { beansprucheTagesSlot } from '../backup.js'

const HAT_DB = process.env['CASTEL_TEST_DB'] === '1' && Boolean(process.env['DATABASE_URL'])

const SLOT_KEY = 'backup.lastSlot'

async function zuruecksetzen(): Promise<void> {
  await getDb().delete(einstellungen).where(eq(einstellungen.key, SLOT_KEY))
}

describe.skipIf(!HAT_DB)('Backup-Tages-Slot-Claim (Integration, echte Postgres)', () => {
  afterAll(zuruecksetzen)

  it('erster Claim eines Slots gewinnt, jeder zweite verliert', async () => {
    await zuruecksetzen()
    expect(await beansprucheTagesSlot('2026-10-19')).toBe(true)
    expect(await beansprucheTagesSlot('2026-10-19')).toBe(false)
    expect(await beansprucheTagesSlot('2026-10-19')).toBe(false)
    // Neuer Tag -> neuer Slot -> Claim gewinnt erneut.
    expect(await beansprucheTagesSlot('2026-10-20')).toBe(true)
    await zuruecksetzen()
  })

  it('parallele Claims desselben Slots gewinnen genau einmal', async () => {
    await zuruecksetzen()
    const results = await Promise.all(
      Array.from({ length: 5 }, () => beansprucheTagesSlot('2026-10-21')),
    )
    expect(results.filter((r) => r).length).toBe(1)
    await zuruecksetzen()
  })
})
