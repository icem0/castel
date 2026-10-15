// Bootstrap-Helfer fuer das initiale Setup.
//
// Enthaelt nur pure Funktionen und eine reine DB-Wrapper-Funktion
// (`bootstrapHauptlager`), die *keinen* DB-Client oeffnet. Sie nimmt die
// Transaktion als Parameter entgegen und ist deshalb in Unit-Tests ohne
// echte Postgres-Verbindung (und ohne dass die gesamte Config geladen
// werden muss) einsetzbar.

import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { artikel, standorte } from '../db/schema.js'
import type * as schema from '../db/schema.js'
import type { BootstrapInhalt } from '../domain/validierung.js'

const HAUPTLAGER_TYP = 'lager' as const

export interface BootstrapResult {
  uebersprungen: boolean
  hauptlagerId?: string
  testArtikelIds: string[]
}

export async function bootstrapHauptlager(
  tx: PostgresJsDatabase<typeof schema>,
  inhalt: BootstrapInhalt,
): Promise<BootstrapResult> {
  const bestehende = await tx
    .select({ id: standorte.id })
    .from(standorte)
    .where(eq(standorte.standard, true))
    .limit(1)
  if (bestehende.length > 0) {
    return { uebersprungen: true, testArtikelIds: [] }
  }

  const hauptlager = buildHauptlager(inhalt)
  await tx.insert(standorte).values(hauptlager)

  const testArtikel = buildTestArtikel(inhalt)
  if (testArtikel.length > 0) {
    await tx.insert(artikel).values(testArtikel)
  }

  return {
    uebersprungen: false,
    hauptlagerId: hauptlager.id,
    testArtikelIds: testArtikel.map((a) => a.id),
  }
}

export function buildHauptlager(inhalt: BootstrapInhalt) {
  const now = new Date()
  return {
    id: crypto.randomUUID(),
    name: inhalt.hauptlagerName,
    typ: HAUPTLAGER_TYP,
    projekt: null,
    kennzeichen: null,
    standard: true,
    archiviert: false,
    geaendertAm: now,
    erstelltAm: now,
  }
}

export function buildTestArtikel(inhalt: BootstrapInhalt) {
  const now = new Date()
  return inhalt.testArtikel.map((a) => ({
    id: crypto.randomUUID(),
    sharePointId: null,
    titel: a.titel,
    status: 'verfuegbar' as const,
    typ: a.typ,
    lieferant: null,
    verpackungseinheit: a.verpackungseinheit,
    mindestbestand: a.mindestbestand,
    nachbestellHinweis: null,
    bestellnummer: null,
    barcode: null,
    listenpreis: null,
    geaendertAm: now,
    erstelltAm: now,
    archiviert: false,
  }))
}

// Test-Hooks (nicht Teil der oeffentlichen API): exportiert fuer Unit-Tests.
export const __test__ = { buildHauptlager, buildTestArtikel, HAUPTLAGER_TYP }
