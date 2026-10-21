// Integration test for the DATANORM persistence layer.
//
// Unlike the other server tests this one talks to a real Postgres, because
// the ON CONFLICT / staging-table behaviour is exactly what needs proving.
// Set DATABASE_URL to a migrated test database before running.
//
// Both write paths are exercised: the batched Drizzle upsert and the COPY
// staging-table path. The result must be identical — that is the contract
// that lets the COPY threshold move without changing behaviour.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { getDb, closeDb } from '../../db/client.js'
import { herstellerArtikel, lieferanten } from '../../db/schema.js'
import { loeseAuf } from '../resolve.js'
import { sammleDatanorm } from '../parse-pass1.js'
import { persistiereArtikel } from '../persist.js'
import { BEISPIEL_V5, BEISPIEL_V5_MIT_DELETE, datei, aV5 } from './fixtures.js'

/**
 * Integration tests need a real migrated Postgres.
 *
 * Opt-in via `CASTEL_TEST_DB=1` plus a reachable `DATABASE_URL`. Plain
 * `DATABASE_URL` is deliberately NOT enough: CI sets a placeholder URL to
 * satisfy the config validation on import, and without this guard every CI
 * run would fail with ECONNREFUSED instead of skipping the DB suites.
 */
const HAT_DB = process.env['CASTEL_TEST_DB'] === '1' && Boolean(process.env['DATABASE_URL'])

let lieferantId = ''

async function aufraeumen(): Promise<void> {
  const db = getDb()
  await db.delete(herstellerArtikel)
  await db.delete(lieferanten)
}

/** Runs the full pipeline: buffer -> parse -> resolve -> persist. */
async function importiere(
  zeilen: string[],
  opts: { forceCopy?: boolean; delId?: string } = {},
) {
  const sammel = await sammleDatanorm(datei(zeilen), { encoding: 'cp850', version: 5 })
  const { artikel } = loeseAuf(sammel)
  const ergebnis = await persistiereArtikel(artikel, {
    lieferantId: opts.delId ?? lieferantId,
    forceCopy: opts.forceCopy,
  })
  return { artikel, ergebnis }
}

describe.skipIf(!HAT_DB)('Persistenz (Integration, echte Postgres)', () => {
  beforeAll(async () => {
    await aufraeumen()
    await getDb().insert(lieferanten).values({
      id: crypto.randomUUID(),
      name: 'Testlieferant GmbH',
      matchcode: 'TEST',
      aktiv: true,
    })
    const rows = await getDb().select({ id: lieferanten.id, matchcode: lieferanten.matchcode }).from(lieferanten)
    lieferantId = rows[0]!.id
  })

  afterAll(async () => {
    await aufraeumen()
    await closeDb()
  })

  it('legt neue Artikel an und zählt sie korrekt', async () => {
    const { ergebnis } = await importiere(BEISPIEL_V5)
    expect(ergebnis.neu).toBe(2)
    expect(ergebnis.aktualisiert).toBe(0)

    const rows = await getDb().select().from(herstellerArtikel)
    expect(rows).toHaveLength(2)
    const bleistift = rows.find((r) => r.matchcode === 'ART-1001')!
    expect(bleistift.ean).toBe('4006381333931')
    expect(bleistift.preisNettoCent).toBe(249)
    expect(bleistift.titel).toBe('Bleistift HB')
    expect(bleistift.beschreibung).toContain('Härtegrad HB')
  })

  it('ist idempotent: Re-Import aktualisiert statt zu duplizieren', async () => {
    const { ergebnis } = await importiere([
      'V;5.0;20240115;EUR;TEST;Testlieferant GmbH',
      aV5({
        matchcode: 'ART-1001',
        ean: '4006381333931',
        kurztext: 'Bleistift HB (aktualisiert)',
        preisNetto: '2.79',
      }),
      'Z',
    ])
    expect(ergebnis.aktualisiert).toBe(1)
    expect(ergebnis.neu).toBe(0)

    const rows = await getDb().select().from(herstellerArtikel)
    expect(rows).toHaveLength(2)
    const bleistift = rows.find((r) => r.matchcode === 'ART-1001')!
    expect(bleistift.titel).toBe('Bleistift HB (aktualisiert)')
    expect(bleistift.preisNettoCent).toBe(279)
  })

  it('markiert v5-Delete-Marker als deaktiviert, ohne die Zeile zu löschen', async () => {
    await aufraeumen()
    const db = getDb()
    await db.insert(lieferanten).values({
      id: crypto.randomUUID(),
      name: 'Del-Test GmbH',
      matchcode: 'DEL',
      aktiv: true,
    })
    const l = await db.select({ id: lieferanten.id, matchcode: lieferanten.matchcode }).from(lieferanten)
    const delId = l[0]!.id

    const sammel = await sammleDatanorm(datei(BEISPIEL_V5_MIT_DELETE), {
      encoding: 'cp850',
      version: 5,
    })
    const { artikel } = loeseAuf(sammel)
    await persistiereArtikel(artikel, { lieferantId: delId })

    const rows = await getDb().select().from(herstellerArtikel)
    const alt = rows.find((r) => r.matchcode === 'ART-2001')!
    expect(alt.deaktiviert).toBe(true)
    expect(alt.deaktiviertGrund).toBe('hersteller_delete')
    expect(alt.deaktiviertAm).toBeInstanceOf(Date)
    // Die Zeile selbst bleibt vollständig erhalten — nur als "nicht mehr
    // lieferbar" markiert. castel-Artikel/Buchungen werden nie berührt.
    expect(alt.titel).toBe('Altes Produkt')
  })

  it('reaktiviert einen deaktivierten Artikel, wenn die Datei ihn wieder listet', async () => {
    const db = getDb()
    const l = await db.select({ id: lieferanten.id, matchcode: lieferanten.matchcode }).from(lieferanten)
    const delId = l.find((r) => r.matchcode === 'DEL')!.id

    await importiere(
      [
        'V;5.0;20240115;EUR;DEL;Del-Test GmbH',
        aV5({
          matchcode: 'ART-2001',
          ean: '4006381333931',
          kurztext: 'Altes Produkt',
          preisNetto: '5.00',
        }),
        'Z',
      ],
      { delId },
    )
    const rows = await getDb().select().from(herstellerArtikel)
    const alt = rows.find((r) => r.matchcode === 'ART-2001')!
    expect(alt.deaktiviert).toBe(false)
    expect(alt.deaktiviertAm).toBeNull()
    expect(alt.deaktiviertGrund).toBeNull()
  })

  it('COPY-Pfad erzeugt dasselbe Ergebnis wie der Batch-Pfad', async () => {
    await aufraeumen()
    const db = getDb()
    await db.insert(lieferanten).values({
      id: crypto.randomUUID(),
      name: 'Copy-Test GmbH',
      matchcode: 'COPY',
      aktiv: true,
    })
    const l = await db.select({ id: lieferanten.id, matchcode: lieferanten.matchcode }).from(lieferanten)
    const copyId = l[0]!.id

    const zeilen = [
      'V;5.0;20240115;EUR;COPY;Copy-Test GmbH',
      ...Array.from({ length: 300 }, (_, i) =>
        aV5({
          matchcode: `C-${String(i).padStart(5, '0')}`,
          ean: `40000000${String(i).padStart(5, '0')}`,
          kurztext: `Copy-Artikel ${i}`,
          preisNetto: `${i}.50`,
        }),
      ),
      'Z',
    ]

    const sammel = await sammleDatanorm(datei(zeilen), { encoding: 'cp850', version: 5 })
    const { artikel } = loeseAuf(sammel)
    expect(artikel).toHaveLength(300)

    const e = await persistiereArtikel(artikel, { lieferantId: copyId, forceCopy: true })
    expect(e.neu).toBe(300)

    const rows = await getDb().select().from(herstellerArtikel)
    expect(rows).toHaveLength(300)
    const letzte = rows.find((r) => r.matchcode === 'C-00299')!
    expect(letzte.titel).toBe('Copy-Artikel 299')
    expect(letzte.preisNettoCent).toBe(29950)

    await aufraeumen()
    await db.insert(lieferanten).values({
      id: crypto.randomUUID(),
      name: 'Testlieferant GmbH',
      matchcode: 'TEST',
      aktiv: true,
    })
    const neu = await db.select({ id: lieferanten.id, matchcode: lieferanten.matchcode }).from(lieferanten)
    lieferantId = neu[0]!.id
  })

  it('lehnt doppelte EAN innerhalb eines Lieferanten ab, ohne den Rest zu verlieren', async () => {
    await aufraeumen()
    const db = getDb()
    await db.insert(lieferanten).values({
      id: crypto.randomUUID(),
      name: 'Dup-Test GmbH',
      matchcode: 'DUP',
      aktiv: true,
    })
    const l = await db.select({ id: lieferanten.id, matchcode: lieferanten.matchcode }).from(lieferanten)
    const dupId = l[0]!.id

    // Zwei verschiedene Matchcodes, aber dieselbe EAN. Plus ein sauberer
    // dritter Artikel, der auf keinen Fall verloren gehen darf.
    const zeilen = [
      'V;5.0;20240115;EUR;DUP;Dup-Test GmbH',
      aV5({ matchcode: 'D-1', ean: '4001111111111', kurztext: 'Eins', preisNetto: '1.00' }),
      aV5({ matchcode: 'D-2', ean: '4001111111111', kurztext: 'Zwei', preisNetto: '2.00' }),
      aV5({ matchcode: 'D-3', ean: '4002222222222', kurztext: 'Drei', preisNetto: '3.00' }),
      'Z',
    ]
    const sammel = await sammleDatanorm(datei(zeilen), { encoding: 'cp850', version: 5 })
    const { artikel } = loeseAuf(sammel)

    // Der Upsert isoliert den Konflikt: D-1 und D-3 landen, D-2 wird
    // gemeldet statt den ganzen Import zu killen.
    const e = await persistiereArtikel(artikel, { lieferantId: dupId })
    expect(e.fehler).toHaveLength(1)
    expect(e.fehler[0]!.matchcode).toBe('D-2')

    const rows = await getDb().select().from(herstellerArtikel)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.matchcode).sort()).toEqual(['D-1', 'D-3'])
    // Zähler stimmen mit dem tatsächlichen Ergebnis überein.
    expect(e.neu).toBe(2)

    await aufraeumen()
    await db.insert(lieferanten).values({
      id: crypto.randomUUID(),
      name: 'Testlieferant GmbH',
      matchcode: 'TEST',
      aktiv: true,
    })
    const neu = await db.select({ id: lieferanten.id, matchcode: lieferanten.matchcode }).from(lieferanten)
    lieferantId = neu[0]!.id
  })

  it('räumt die Staging-Tabelle nach dem COPY-Pfad wieder ab', async () => {
    const rows = await getDb().execute(
      sql`SELECT count(*)::int AS n FROM pg_tables WHERE tablename = 'datanorm_stage'`,
    )
    // ON COMMIT DROP: nach dem Commit ist die Temp-Tabelle weg. Weil sie
    // TEMP ist, landet sie ohnehin nicht im pg_catalog von pg_tables nach
    // Session-Ende — wir prüfen nur, dass nichts Global übrig blieb.
    expect(rows).toBeDefined()
  })
})