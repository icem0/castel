// Rollen-Verwaltung: GET/POST/PATCH/DELETE /api/rollen + Berechtigungen-PATCH.
//
// Der Server ist die einzige Quelle der Wahrheit fuer Rollen und
// Berechtigungen (see `domain/rollen.ts` und Migration 0030).
//
// Zugriff: nur Benutzer mit `benutzer.verwalten` (admin).
// Die Rolle `admin` ist geschuetzt: nicht loeschbar, nicht umbenennbar,
// hat immer alle Berechtigungen.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getDb } from '../db/client.js'
import { rollen, rollenBerechtigungen } from '../db/schema.js'
import { eq } from 'drizzle-orm'
import {
  ladeRollenMatrix,
  type BerechtigungInfo,
  type RolleMitBerechtigungen,
} from '../domain/rollen.js'
import { BERECHTIGUNG_INFO, KNOWN_PERMISSIONS } from '../domain/rollen.js'

const createRolleSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/, 'Nur Kleinbuchstaben, Ziffern, Bindestrich und Unterstrich'),
  name: z.string().min(1).max(100),
  beschreibung: z.string().max(500).optional(),
  berechtigungen: z.array(z.string()).optional(),
})

const patchRolleSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  beschreibung: z.string().max(500).optional(),
  aktiv: z.boolean().optional(),
})

const patchBerechtigungenSchema = z.object({
  berechtigungen: z.array(z.string()),
})

export async function rollenRoutes(app: FastifyInstance): Promise<void> {
  // ---------- GET /api/rollen ----------
  app.get('/api/rollen', { preHandler: app.requireAuth }, async (_req, reply) => {
    const db = getDb()
    const matrix = await ladeRollenMatrix(db)

    const rollenListe = Object.values(matrix).map((r: RolleMitBerechtigungen) => ({
      id: r.id,
      titel: r.name,
      beschreibung: r.beschreibung,
      rechte: r.berechtigungen,
      berechtigungen: r.berechtigungen,
      aktiv: r.aktiv,
    }))

    const berechtigungenListe = Object.entries(BERECHTIGUNG_INFO).map(
      ([id, info]: [string, BerechtigungInfo]) => ({
        id,
        titel: info.titel,
        beschreibung: info.beschreibung,
      }),
    )

    return reply.send({
      version: 1,
      rollen: rollenListe,
      berechtigungen: berechtigungenListe,
    })
  })

  // ---------- POST /api/rollen ----------
  app.post(
    '/api/rollen',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      const parsed = createRolleSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.code(400).send({ code: 'VALIDATION', issues: parsed.error.issues })
      }
      const { id, name, beschreibung, berechtigungen } = parsed.data
      const db = getDb()

      // ID darf nicht existieren
      const existing = await db.select({ id: rollen.id }).from(rollen).where(eq(rollen.id, id)).limit(1)
      if (existing.length > 0) {
        return reply.code(409).send({ code: 'ROLLE_EXISTIERT', message: 'Rolle existiert bereits' })
      }

      const berecht = berechtigungen ?? []
      // Alle uebergebenen Berechtigungen muessen bekannt sein
      for (const b of berecht) {
        if (!KNOWN_PERMISSIONS.includes(b as any)) {
          return reply.code(400).send({ code: 'VALIDATION', message: `Unbekannte Berechtigung: ${b}` })
        }
      }

      await db.insert(rollen).values({
        id,
        name,
        beschreibung: beschreibung ?? '',
        aktiv: true,
        erstelltAm: new Date(),
      })

      if (berecht.length > 0) {
        await db.insert(rollenBerechtigungen).values(
          berecht.map((b) => ({ rolleId: id, berechtigung: b }))
        )
      }

      return reply.code(201).send({ id, name, beschreibung: beschreibung ?? '', berechtigungen: berecht })
    },
  )

  // ---------- PATCH /api/rollen/:id ----------
  app.patch<{ Params: { id: string } }>(
    '/api/rollen/:id',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      const parsed = patchRolleSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.code(400).send({ code: 'VALIDATION', issues: parsed.error.issues })
      }
      const { id } = req.params
      const { name, beschreibung, aktiv } = parsed.data
      const db = getDb()

      // admin-rolle ist nicht umbenennbar/deaktivierbar
      if (id === 'admin') {
        if (name !== undefined || aktiv === false) {
          return reply.code(403).send({
            code: 'ROLLE_GESCHUETZT',
            message: 'Die Admin-Rolle kann nicht umbenannt oder deaktiviert werden',
          })
        }
      }

      const rolle = await db.select().from(rollen).where(eq(rollen.id, id)).limit(1)
      if (rolle.length === 0) {
        return reply.code(404).send({ code: 'ROLLE_NICHT_GEFUNDEN', message: 'Rolle nicht gefunden' })
      }

      const update: Record<string, unknown> = {}
      if (name !== undefined) update.name = name
      if (beschreibung !== undefined) update.beschreibung = beschreibung
      if (aktiv !== undefined) update.aktiv = aktiv

      if (Object.keys(update).length > 0) {
        await db.update(rollen).set(update).where(eq(rollen.id, id))
      }

      return reply.code(204).send()
    },
  )

  // ---------- DELETE /api/rollen/:id ----------
  app.delete<{ Params: { id: string } }>(
    '/api/rollen/:id',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      const { id } = req.params
      const db = getDb()

      // admin-rolle ist nicht loeschbar
      if (id === 'admin') {
        return reply.code(403).send({
          code: 'ROLLE_GESCHUETZT',
          message: 'Die Admin-Rolle kann nicht geloescht werden',
        })
      }

      // Pruefen ob noch Benutzer diese Rolle bekleiden
      // TODO: eigentliche Pruefung gegen users-Tabelle (rollen Spalte)
      // Fuer jetzt: Rolle kann geloescht werden, wenn sie nicht 'admin' ist

      await db.delete(rollen).where(eq(rollen.id, id))
      return reply.code(204).send()
    },
  )

  // ---------- PATCH /api/rollen/:id/berechtigungen ----------
  app.patch<{ Params: { id: string } }>(
    '/api/rollen/:id/berechtigungen',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      const parsed = patchBerechtigungenSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.code(400).send({ code: 'VALIDATION', issues: parsed.error.issues })
      }
      const { id } = req.params
      const { berechtigungen } = parsed.data
      const db = getDb()

      // admin-rolle behaelt immer alle Berechtigungen
      if (id === 'admin') {
        return reply.code(403).send({
          code: 'ROLLE_GESCHUETZT',
          message: 'Die Admin-Rolle hat immer alle Berechtigungen',
        })
      }

      const rolle = await db.select().from(rollen).where(eq(rollen.id, id)).limit(1)
      if (rolle.length === 0) {
        return reply.code(404).send({ code: 'ROLLE_NICHT_GEFUNDEN', message: 'Rolle nicht gefunden' })
      }

      // Alle uebergebenen Berechtigungen muessen bekannt sein
      for (const b of berechtigungen) {
        if (!KNOWN_PERMISSIONS.includes(b as any)) {
          return reply.code(400).send({ code: 'VALIDATION', message: `Unbekannte Berechtigung: ${b}` })
        }
      }

      // Bestehende loeschen, neue einsetzen
      await db.delete(rollenBerechtigungen).where(eq(rollenBerechtigungen.rolleId, id))

      if (berechtigungen.length > 0) {
        await db.insert(rollenBerechtigungen).values(
          berechtigungen.map((b) => ({ rolleId: id, berechtigung: b }))
        )
      }

      return reply.code(204).send()
    },
  )
}
