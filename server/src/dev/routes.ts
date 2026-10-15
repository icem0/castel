// Dev-Mode Endpoint.
//
// Meldet /api/dev/status mit dem aus ENV DEV_MODE abgeleiteten Wert.
// Wird von der PWA benutzt, um das "DEV MODE"-Badge im Login-Screen
// und im Header anzuzeigen. Der Endpoint ist oeffentlich (kein Auth)
// und enthaelt keine sensitiven Daten — nur den Modus-Flag.
//
// Konfiguration: ENV DEV_MODE (true | false | 1 | 0). Default false.
// Im Live-Betrieb DEV_MODE=false setzen oder weglassen.

import type { FastifyInstance } from 'fastify'
import { config } from '../config/config.js'

export async function devRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/dev/status', async () => ({
    devMode: config.DEV_MODE,
    // Hinweis-Text, der in der PWA als Tooltip am Badge erscheint.
    // Statisch, weil die PWA sonst raten muss.
    tooltip:
      'DEV_MODE=true: Die API löscht beim Start alle Daten-Tabellen ' +
      '(users, artikel, buchungen, …). Es bleibt nur das Schema, der erste ' +
      'Admin muss neu angelegt werden. ' +
      'Steuerung über DEV_MODE in der .env (docker-compose.yml). ' +
      'Im Live-Betrieb DEV_MODE=false setzen.',
  }))
}