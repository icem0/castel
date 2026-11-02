// GET /api/rollen — die Rollen-Matrix inklusive Beschreibungen.
//
// Der Server ist die einzige Quelle der Wahrheit fuer Rollen und
// Berechtigungen (siehe `domain/rollen.ts`). Die PWA laedt die Matrix,
// um die Rollen-Legende unter /einstellungen/user anzuzeigen und um die
// Rollen-Auswahl zu beschriften.
//
// Die effektiven Rechte des eingeloggten Users kommen NICHT von hier, sondern
// aus dem Login/`/api/auth/me` (dort stehen die konkreten Berechtigungen) —
// so braucht die PWA die Matrix nur fuer die Anzeige.

import type { FastifyInstance } from 'fastify'
import {
  BERECHTIGUNG_INFO,
  PERMISSIONS,
  ROLLEN,
  ROLLEN_BEREECHTIGUNGEN,
  ROLLEN_INFO,
} from '../domain/rollen.js'

export async function rollenRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/rollen', { preHandler: app.requireAuth }, async (_req, reply) => {
    return reply.send({
      version: 1,
      rollen: ROLLEN.map((id) => ({
        id,
        titel: ROLLEN_INFO[id].titel,
        beschreibung: ROLLEN_INFO[id].beschreibung,
        rechte: ROLLEN_INFO[id].rechte,
        berechtigungen: ROLLEN_BEREECHTIGUNGEN[id],
      })),
      berechtigungen: PERMISSIONS.map((id) => ({
        id,
        titel: BERECHTIGUNG_INFO[id].titel,
        beschreibung: BERECHTIGUNG_INFO[id].beschreibung,
      })),
    })
  })
}
