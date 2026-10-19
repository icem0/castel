// Property-basierte Tests für die Bestandsformel.
//
// Die Kernregel: Σ buchungen.menge where storno=false == bestand.
//
// Wir generieren Sequenzen aus Einlagerungen, Entnahmen, Umlagerungen,
// Inventuren und Stornos und verifizieren:
//
//   * nach jeder Operation gilt: Σ(storno=false) == bestand
//   * nach jedem Storno-Paar ist der Bestand unverändert
//   * Umlagerungen verschieben den Bestand zwischen Quell- und Zielstandort
//   * Inventur-Buchungen korrigieren den Bestand exakt auf den Soll-Wert
//   * die Summen-Identity gilt auch bei random erzeugten Multi-Artikel-Sets
//   * Bestand ist unabhängig von der Buchungsreihenfolge (Kommutativität)
//
// Wir verwenden einen einfachen Seeded-PRNG, damit die Tests deterministisch
// laufen. Property-Tests in voller Schönheit (testcheck-js / fast-check)
// sind eine Option, aber die Inline-Schleife reicht für 10+ Cases aus und
// vermeidet eine neue Dependency.

import { beforeEach, describe, expect, it } from 'vitest'
import { CastelDb, setDb } from '../../db/database'
import type { Artikel, Buchung, Standort } from '../../db/types'
import {
  createEinlagerung,
  createEntnahme,
  createInventur,
  createUmlagerung,
  stornieren,
} from '../buchungen'
import { berechneBestand, berechneBestandProStandort, summeAktiveBuchungen } from '../bestand'

let testDb: CastelDb
const A = (n: number) => `art-${n}`
const S = (n: number) => `std-${n}`

async function seedArtikel(
  id: string,
  name: string,
  mindestbestand: number | null = null,
): Promise<void> {
  const artikel: Artikel = {
    id,
    sharePointId: null,
    titel: name,
    status: 'verfuegbar',
    typ: 'Test',
    lieferant: null,
    verpackungseinheit: 1,
    mindestbestand,
    nachbestellHinweis: null,
    bestellnummer: null,
    barcode: null,
    listenpreis: null,
    geaendertAm: null,
    erstelltAm: '2025-01-01T00:00:00.000Z',
  }
  await testDb.artikel.add(artikel)
}

async function seedStandort(id: string, name: string, standard = false): Promise<void> {
  const standort: Standort = {
    id,
    name,
    typ: 'lager',
    projekt: null,
    kennzeichen: null,
    standard,
    archiviert: false,
    geaendertAm: '2025-01-01T00:00:00.000Z',
    erstelltAm: '2025-01-01T00:00:00.000Z',
  }
  await testDb.standorte.add(standort)
}

beforeEach(async () => {
  testDb = new CastelDb(`castel-prop-${Math.random().toString(36).slice(2)}`)
  setDb(testDb)
  await testDb.delete()
  await testDb.open()
  await seedStandort(S(1), 'Hauptlager', true)
  await seedStandort(S(2), 'Auto-1')
  await seedStandort(S(3), 'Baustelle')
  await seedArtikel(A(1), 'MS 400')
  await seedArtikel(A(2), 'BX-SOL-CT-W')
  await seedArtikel(A(3), 'MS 300', 5) // mit Mindestbestand
})

// Seeded PRNG (Mulberry32) — deterministisch, reicht für 200+ Iterationen.
function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)] as T
}

/**
 * Universelles Property: für eine beliebige Buchungs-Liste gilt
 *   berechneBestand(buchungen, s)
 *     == summeAktiveBuchungen(buchungen).where(standortId === s)
 */
function invariantSummenform(buchungen: Buchung[], s: string): number {
  return buchungen
    .filter((b) => !b.storno)
    .filter((b) => b.standortId === s)
    .reduce((acc, b) => acc + b.menge, 0)
}

describe('Bestandsformel — Property-Tests', () => {
  it('Property 1: leere Buchungsliste ergibt Bestand 0', async () => {
    const buchungen = await testDb.buchungen.toArray()
    expect(berechneBestand(buchungen, S(1))).toBe(0)
    expect(berechneBestand(buchungen, S(2))).toBe(0)
  })

  it('Property 2: nur Einlagerungen — Σ(menge) == bestand', async () => {
    for (const m of [1, 7, 13, 42]) {
      await createEinlagerung({ artikelId: A(1), standortId: S(1), menge: m, erstelltVon: 't' })
    }
    const buchungen = await testDb.buchungen.toArray()
    expect(berechneBestand(buchungen, S(1))).toBe(63)
    expect(invariantSummenform(buchungen, S(1))).toBe(63)
  })

  it('Property 3: gemischte Ein/Entnahme — Σ(storno=false) == bestand', async () => {
    for (let i = 0; i < 10; i++) {
      await createEinlagerung({
        artikelId: A(1),
        standortId: S(1),
        menge: 5 + i,
        erstelltVon: 't',
      })
    }
    for (let i = 0; i < 5; i++) {
      await createEntnahme({
        artikelId: A(1),
        standortId: S(1),
        menge: 2 + i,
        erstelltVon: 't',
      })
    }
    const buchungen = await testDb.buchungen.toArray()
    // Σ ein (5..14) = 95, Σ ent (2..6) = 20 → 75
    expect(berechneBestand(buchungen, S(1))).toBe(75)
    expect(invariantSummenform(buchungen, S(1))).toBe(75)
  })

  it('Property 4: Umlagerung verschiebt Bestand zwischen Standorten (Σ bleibt gleich)', async () => {
    await createEinlagerung({ artikelId: A(1), standortId: S(1), menge: 100, erstelltVon: 't' })
    await createUmlagerung({
      artikelId: A(1),
      vonId: S(1),
      nachId: S(2),
      menge: 30,
      erstelltVon: 't',
    })
    await createUmlagerung({
      artikelId: A(1),
      vonId: S(2),
      nachId: S(3),
      menge: 10,
      erstelltVon: 't',
    })
    const buchungen = await testDb.buchungen.toArray()
    expect(berechneBestand(buchungen, S(1))).toBe(70)
    expect(berechneBestand(buchungen, S(2))).toBe(20)
    expect(berechneBestand(buchungen, S(3))).toBe(10)
    // Gesamt-Summe = 100 (unverändert)
    expect(
      berechneBestand(buchungen, S(1)) +
        berechneBestand(buchungen, S(2)) +
        berechneBestand(buchungen, S(3)),
    ).toBe(100)
    expect(summeAktiveBuchungen(buchungen)).toBe(100)
  })

  it('Property 5: Storno macht Buchung wirkungslos — Σ(storno=false) bleibt', async () => {
    const ops: Buchung[] = []
    for (let i = 0; i < 5; i++) {
      const b = await createEinlagerung({
        artikelId: A(1),
        standortId: S(1),
        menge: 10,
        erstelltVon: 't',
      })
      ops.push(b)
    }
    const vorher = berechneBestand(await testDb.buchungen.toArray(), S(1))
    expect(vorher).toBe(50)

    // Storniere jede zweite Buchung (Indizes 0, 2, 4) → 3 Stornos
    for (let i = 0; i < ops.length; i += 2) {
      await stornieren({ buchungId: ops[i]!.id, grund: 'x', erstelltVon: 't' })
    }
    const nachher = berechneBestand(await testDb.buchungen.toArray(), S(1))
    // 5 - 3 = 2 aktive Einlagerungen à 10 = 20
    expect(nachher).toBe(20)
  })

  it('Property 6: Inventur setzt Bestand exakt auf sollMenge', async () => {
    await createEinlagerung({ artikelId: A(1), standortId: S(1), menge: 17, erstelltVon: 't' })
    await createEntnahme({ artikelId: A(1), standortId: S(1), menge: 4, erstelltVon: 't' })
    // bestand = 13
    const r = await createInventur({
      artikelId: A(1),
      standortId: S(1),
      sollMenge: 20,
      erstelltVon: 't',
    })
    expect(r.vorher).toBe(13)
    expect(r.differenz).toBe(7) // 20 - 13
    expect(berechneBestand(await testDb.buchungen.toArray(), S(1))).toBe(20)
  })

  it('Property 7: Inventur darf storniert werden, Korrektur wird rückgängig', async () => {
    // Brief: "Inventur: signed Differenz (soll − ist), keine Storno-Kette"
    // → eine Inventur darf storniert werden; das Storno entfernt die
    //   Korrektur aus dem Bestand. Es entsteht KEINE Kette (kein
    //   weiteres Storno auf das Storno).
    await createEinlagerung({ artikelId: A(1), standortId: S(1), menge: 50, erstelltVon: 't' })
    const inv = await createInventur({
      artikelId: A(1),
      standortId: S(1),
      sollMenge: 0,
      erstelltVon: 't',
    })
    // Inventur korrigiert von 50 auf 0
    expect(berechneBestand(await testDb.buchungen.toArray(), S(1))).toBe(0)

    // Storno der Inventur: die -50-Korrektur verschwindet aus dem
    // Bestand, also steht wieder 50 da.
    const r = await stornieren({ buchungId: inv.buchung.id, grund: 'x', erstelltVon: 't' })
    expect(r.storno.menge).toBe(50) // invertiert zu inventur.menge = -50
    expect(r.storno.storno).toBe(true)
    const nach = berechneBestand(await testDb.buchungen.toArray(), S(1))
    expect(nach).toBe(50)

    // KEINE Storno-Kette: das Storno selbst kann nicht storniert werden
    await expect(
      stornieren({ buchungId: r.storno.id, grund: 'y', erstelltVon: 't' }),
    ).rejects.toThrow()
  })

  it('Property 8: berechneBestandProStandort == Σ pro Standort', async () => {
    await createEinlagerung({ artikelId: A(1), standortId: S(1), menge: 10, erstelltVon: 't' })
    await createEinlagerung({ artikelId: A(2), standortId: S(2), menge: 20, erstelltVon: 't' })
    await createEinlagerung({ artikelId: A(3), standortId: S(1), menge: 30, erstelltVon: 't' })
    await createUmlagerung({
      artikelId: A(1),
      vonId: S(1),
      nachId: S(3),
      menge: 4,
      erstelltVon: 't',
    })
    const buchungen = await testDb.buchungen.toArray()
    const map = berechneBestandProStandort(buchungen)
    expect(map.get(S(1))).toBe(berechneBestand(buchungen, S(1)))
    expect(map.get(S(2))).toBe(berechneBestand(buchungen, S(2)))
    expect(map.get(S(3))).toBe(berechneBestand(buchungen, S(3)))
    expect(map.get(S(1))).toBe(36) // 10 + 30 - 4
    expect(map.get(S(2))).toBe(20)
    expect(map.get(S(3))).toBe(4)
  })

  it('Property 9: randomisierte Sequenz — Σ(storno=false) == bestand (200 Iterationen)', async () => {
    const rng = makeRng(42)
    const artikelIds = [A(1), A(2), A(3)]
    const standortIds = [S(1), S(2), S(3)]

    for (let i = 0; i < 200; i++) {
      const artikel = pick(rng, artikelIds)
      const standort = pick(rng, standortIds)
      const menge = 1 + Math.floor(rng() * 20)
      const op = rng()
      try {
        if (op < 0.45) {
          await createEinlagerung({
            artikelId: artikel,
            standortId: standort,
            menge,
            erstelltVon: 't',
          })
        } else if (op < 0.85) {
          // Entnahme nur wenn bestand >= menge (sonst Warnung, aber OK)
          await createEntnahme({
            artikelId: artikel,
            standortId: standort,
            menge,
            erstelltVon: 't',
          })
        } else {
          // Umlagerung: zufälliges anderes Ziel
          const ziel = pick(
            rng,
            standortIds.filter((s) => s !== standort),
          )
          await createUmlagerung({
            artikelId: artikel,
            vonId: standort,
            nachId: ziel,
            menge,
            erstelltVon: 't',
          })
        }
      } catch {
        // Validierungsfehler (z. B. GleicherStandortError) sind ok für die Invariante
      }
    }

    const buchungen = await testDb.buchungen.toArray()
    for (const s of standortIds) {
      const berechnet = berechneBestand(buchungen, s)
      const referenz = invariantSummenform(buchungen, s)
      expect(berechnet).toBe(referenz)
    }
  })

  it('Property 10: randomisierte Sequenz + Storno — Σ(storno=false) == bestand', async () => {
    const rng = makeRng(1337)
    const ops: Buchung[] = []
    const artikelIds = [A(1), A(2), A(3)]
    const standortIds = [S(1), S(2), S(3)]

    for (let i = 0; i < 100; i++) {
      const artikel = pick(rng, artikelIds)
      const standort = pick(rng, standortIds)
      const menge = 1 + Math.floor(rng() * 10)
      const b = await createEinlagerung({
        artikelId: artikel,
        standortId: standort,
        menge,
        erstelltVon: 't',
      })
      ops.push(b)
    }
    // Storniere zufällig die Hälfte
    for (let i = 0; i < ops.length; i++) {
      if (rng() < 0.5) {
        try {
          await stornieren({ buchungId: ops[i]!.id, grund: 'r', erstelltVon: 't' })
        } catch {
          // BereitsStorniertError durch Doppel-Storno im selben Loop ist ok
        }
      }
    }
    const buchungen = await testDb.buchungen.toArray()
    for (const s of standortIds) {
      expect(berechneBestand(buchungen, s)).toBe(invariantSummenform(buchungen, s))
    }
  })

  it('Property 11: randomisierte Multi-Artikel + Inventur-Korrektur', async () => {
    const rng = makeRng(7)
    const artikelIds = [A(1), A(2), A(3)]
    const standortIds = [S(1), S(2)]

    for (let i = 0; i < 80; i++) {
      const artikel = pick(rng, artikelIds)
      const standort = pick(rng, standortIds)
      const menge = 1 + Math.floor(rng() * 15)
      if (rng() < 0.6) {
        await createEinlagerung({
          artikelId: artikel,
          standortId: standort,
          menge,
          erstelltVon: 't',
        })
      } else {
        await createEntnahme({ artikelId: artikel, standortId: standort, menge, erstelltVon: 't' })
      }
    }

    // Setze Inventur auf "10" für alle Kombinationen und prüfe Σ == 10 danach
    for (const artikel of artikelIds) {
      for (const standort of standortIds) {
        const r = await createInventur({
          artikelId: artikel,
          standortId: standort,
          sollMenge: 10,
          erstelltVon: 't',
        })
        expect(r.differenz).toBe(10 - r.vorher)
        const buchungen = await testDb.buchungen.toArray()
        const filtered = buchungen.filter((b) => b.artikelId === artikel)
        expect(berechneBestand(filtered, standort)).toBe(10)
      }
    }
  })

  it('Property 12: berechneBestand ist kommutativ (Reihenfolge der Buchungen irrelevant)', async () => {
    // Sequenz A: Ein, Ein, Ent, Ent, Ein
    await createEinlagerung({ artikelId: A(1), standortId: S(1), menge: 10, erstelltVon: 't' })
    await createEinlagerung({ artikelId: A(1), standortId: S(1), menge: 20, erstelltVon: 't' })
    await createEntnahme({ artikelId: A(1), standortId: S(1), menge: 5, erstelltVon: 't' })
    await createEntnahme({ artikelId: A(1), standortId: S(1), menge: 3, erstelltVon: 't' })
    await createEinlagerung({ artikelId: A(1), standortId: S(1), menge: 7, erstelltVon: 't' })
    const seqA = await testDb.buchungen.toArray()
    const bestandA = berechneBestand(seqA, S(1)) // 10+20-5-3+7 = 29

    // Reset
    testDb = new CastelDb(`castel-komm-${Math.random().toString(36).slice(2)}`)
    setDb(testDb)
    await testDb.delete()
    await testDb.open()
    await seedStandort(S(1), 'Hauptlager', true)
    await seedArtikel(A(1), 'MS 400')

    // Sequenz B: gleiche Buchungen, andere Reihenfolge
    await createEntnahme({ artikelId: A(1), standortId: S(1), menge: 5, erstelltVon: 't' })
    await createEinlagerung({ artikelId: A(1), standortId: S(1), menge: 7, erstelltVon: 't' })
    await createEntnahme({ artikelId: A(1), standortId: S(1), menge: 3, erstelltVon: 't' })
    await createEinlagerung({ artikelId: A(1), standortId: S(1), menge: 20, erstelltVon: 't' })
    await createEinlagerung({ artikelId: A(1), standortId: S(1), menge: 10, erstelltVon: 't' })
    const seqB = await testDb.buchungen.toArray()
    const bestandB = berechneBestand(seqB, S(1))

    expect(bestandA).toBe(bestandB)
  })
})
