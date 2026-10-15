// Tests für zod-Schemas (Frontend-Datenformate).

import { describe, it, expect } from 'vitest'
import {
  artikelSchema,
  buchungSchema,
  loginSchema,
  pushPayloadSchema,
  snapshotQuerySchema,
} from '../domain/validierung.js'

describe('validierung.schemas', () => {
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