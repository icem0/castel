// Tests für zod-Schemas (Frontend-Datenformate).

import { describe, it, expect } from 'vitest'
import {
  artikelSchema,
  akkuNetzteilSchema,
  buchungSchema,
  loginSchema,
  pushPayloadSchema,
  snapshotQuerySchema,
} from '../domain/validierung.js'

function netzteil(overrides: Record<string, unknown> = {}) {
  return {
    id: 'n1',
    anlage: '10020_02',
    objekt: 'Klinik',
    name: 'Zentrale',
    einbaudatum: '2021-01-01',
    intervallJahre: 4,
    kapazitaetAh: 2.5,
    anzahl: 2,
    gruppe: null,
    plz: null,
    vdsAnerkennung: null,
    bemerkung: null,
    geloescht: false,
    geaendertAm: '2024-01-01T00:00:00.000Z',
    erstelltAm: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('validierung.schemas', () => {
  describe('akkuNetzteilSchema', () => {
    it('akzeptiert ein vollständiges Netzteil', () => {
      expect(akkuNetzteilSchema.safeParse(netzteil()).success).toBe(true)
    })

    it('akzeptiert fehlende Akku-Daten (Migration 0023)', () => {
      const r = akkuNetzteilSchema.safeParse(
        netzteil({ einbaudatum: null, intervallJahre: null, kapazitaetAh: null, anzahl: null }),
      )
      expect(r.success).toBe(true)
    })

    it('lehnt fehlende Identität ab', () => {
      expect(akkuNetzteilSchema.safeParse(netzteil({ name: '' })).success).toBe(false)
    })

    it('lehnt ungültige Werte ab', () => {
      expect(akkuNetzteilSchema.safeParse(netzteil({ kapazitaetAh: 0 })).success).toBe(false)
      expect(akkuNetzteilSchema.safeParse(netzteil({ intervallJahre: 0 })).success).toBe(false)
      expect(akkuNetzteilSchema.safeParse(netzteil({ einbaudatum: '01/2021' })).success).toBe(
        false,
      )
    })
  })

  describe('loginSchema', () => {
    it('akzeptiert gültige Eingaben', () => {
      const r = loginSchema.safeParse({ email: 'a@b.de', password: 'x' })
      expect(r.success).toBe(true)
    })
    it('lehnt fehlende Felder ab', () => {
      const r = loginSchema.safeParse({ email: 'a@b.de' })
      expect(r.success).toBe(false)
    })
    it('lehnt ungültige E-Mail ab', () => {
      const r = loginSchema.safeParse({ email: 'kein-email', password: 'x' })
      expect(r.success).toBe(false)
    })
  })

  describe('artikelSchema', () => {
    it('akzeptiert vollständigen Artikel', () => {
      const r = artikelSchema.safeParse({
        id: 'a1',
        titel: 'Test',
        status: 'verfuegbar',
        typ: 'Alarmierung',
        verpackungseinheit: 1,
        geaendertAm: '2025-04-14T11:00:00.000Z',
        erstelltAm: '2025-04-14T11:00:00.000Z',
      })
      expect(r.success).toBe(true)
    })
    it('akzeptiert Artikel mit barcode', () => {
      const r = artikelSchema.safeParse({
        id: 'a1',
        titel: 'Test',
        status: 'verfuegbar',
        typ: 'Alarmierung',
        verpackungseinheit: 1,
        barcode: '4006381333931',
        geaendertAm: '2025-04-14T11:00:00.000Z',
        erstelltAm: '2025-04-14T11:00:00.000Z',
      })
      expect(r.success).toBe(true)
    })
    it('akzeptiert Artikel mit barcode=null', () => {
      const r = artikelSchema.safeParse({
        id: 'a1',
        titel: 'Test',
        status: 'verfuegbar',
        typ: 'Alarmierung',
        verpackungseinheit: 1,
        barcode: null,
        geaendertAm: '2025-04-14T11:00:00.000Z',
        erstelltAm: '2025-04-14T11:00:00.000Z',
      })
      expect(r.success).toBe(true)
    })
    it('akzeptiert Artikel mit etikettenNeu-Flag', () => {
      const r = artikelSchema.safeParse({
        id: 'a1',
        titel: 'Test',
        status: 'verfuegbar',
        typ: 'Alarmierung',
        verpackungseinheit: 1,
        etikettenNeu: false,
        geaendertAm: '2025-04-14T11:00:00.000Z',
        erstelltAm: '2025-04-14T11:00:00.000Z',
      })
      expect(r.success).toBe(true)
      expect(r.success && r.data.etikettenNeu).toBe(false)
    })
    it('behaelt das etikettenNeu-Flag im geparsten Payload (kein Stripping)', () => {
      const r = artikelSchema.safeParse({
        id: 'a1',
        titel: 'Test',
        status: 'verfuegbar',
        typ: 'Alarmierung',
        verpackungseinheit: 1,
        etikettenNeu: true,
        geaendertAm: '2025-04-14T11:00:00.000Z',
        erstelltAm: '2025-04-14T11:00:00.000Z',
      })
      expect(r.success).toBe(true)
      if (!r.success) return
      expect('etikettenNeu' in r.data).toBe(true)
      expect(r.data.etikettenNeu).toBe(true)
    })
    it('lehnt etikettenNeu mit falschem Typ ab', () => {
      const r = artikelSchema.safeParse({
        id: 'a1',
        titel: 'Test',
        status: 'verfuegbar',
        typ: 'Alarmierung',
        verpackungseinheit: 1,
        etikettenNeu: 'ja',
        geaendertAm: '2025-04-14T11:00:00.000Z',
        erstelltAm: '2025-04-14T11:00:00.000Z',
      })
      expect(r.success).toBe(false)
    })
    it('lehnt unbekannten Status ab', () => {
      const r = artikelSchema.safeParse({
        id: 'a1',
        titel: 'Test',
        status: 'falsch',
        typ: 'Alarmierung',
        verpackungseinheit: 1,
        geaendertAm: '2025-04-14T11:00:00.000Z',
        erstelltAm: '2025-04-14T11:00:00.000Z',
      })
      expect(r.success).toBe(false)
    })
  })

  describe('buchungSchema', () => {
    it('akzeptiert Entnahme', () => {
      const r = buchungSchema.safeParse({
        id: 'b1',
        artikelId: 'a1',
        standortId: 's1',
        typ: 'entnahme',
        menge: 5,
        erstelltAm: '2025-04-14T11:00:00.000Z',
        erstelltVon: 'u1',
        storno: false,
      })
      expect(r.success).toBe(true)
    })
  })

  describe('pushPayloadSchema', () => {
    it('akzeptiert leere Ops-Liste', () => {
      const r = pushPayloadSchema.safeParse({ ops: [] })
      expect(r.success).toBe(true)
    })
    it('lehnt mehr als 500 ops ab', () => {
      const ops = Array.from({ length: 501 }, (_, i) => ({
        op: 'create' as const,
        entity: 'artikel' as const,
        payload: {
          id: `a${i}`,
          titel: 'T',
          status: 'verfuegbar' as const,
          typ: 'x',
          verpackungseinheit: 1,
          geaendertAm: '2025-04-14T11:00:00.000Z',
          erstelltAm: '2025-04-14T11:00:00.000Z',
        },
      }))
      const r = pushPayloadSchema.safeParse({ ops })
      expect(r.success).toBe(false)
    })
  })

  describe('snapshotQuerySchema', () => {
    it('akzeptiert fehlendes since', () => {
      const r = snapshotQuerySchema.safeParse({})
      expect(r.success).toBe(true)
    })
    it('akzeptiert ISO-Datum', () => {
      const r = snapshotQuerySchema.safeParse({ since: '2025-04-14T11:00:00.000Z' })
      expect(r.success).toBe(true)
    })
    it('lehnt Müll ab', () => {
      const r = snapshotQuerySchema.safeParse({ since: 'kein-datum' })
      expect(r.success).toBe(false)
    })
  })
})