// MCP-Server fuer castel.
//
// Die Tools sind bewusst duenne Wrapper um den REST-Service-Layer
// (src/api/v1/service.ts). Dadurch gelten fuer REST und MCP exakt dieselben
// Validierungen, Scopes, Audit-Eintraege und Mindestbestand-Events.
//
// Transport: Streamable HTTP, stateless. Jeder Request bringt seinen
// API-Key mit; der McpServer wird pro Request mit dem aufgeloesten
// Auth-Kontext neu erzeugt.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { ApiAuthContext } from '../auth/api-key-auth.js'
import { scopeErlaubt, type ApiKeyScope } from '../auth/api-keys.js'
import { ApiV1Error } from '../api/v1/service.js'
import {
  artikelCreateSchema,
  buchungCreateSchema,
  artikelPatchSchema,
} from '../api/v1/schemas.js'
import {
  createArtikel,
  erstelleBuchung,
  getApiMeta,
  getArtikel,
  getBestand,
  getStatus,
  kommissioniereBuchung,
  listeArtikel,
  listeBuchungen,
  listeKommissionen,
  listeMindestbestand,
  listeStandorte,
  storniereBuchung,
  updateArtikel,
} from '../api/v1/service.js'
import type { NotificationGateway } from '../services/notification-gateway.js'

const INSTRUCTIONS = `castel ist eine append-only Lagerverwaltung.
Der Bestand ist immer die Summe aller Buchungen mit storno=false; Mengen
werden niemals ueberschrieben. Korrekturen erfolgen per Storno.

Wichtige Regeln:
- Alle IDs sind UUIDs, Preise in Cent, Mengen als Ganzzahlen in Stueck,
  Zeitstempel ISO-8601 UTC.
- Vor einer Entnahme den Bestand pruefen (castel_get_bestand).
- Entnahme/Einlagerung erwarten eine POSITIVE menge. Umlagerung erzeugt
  zwei Buchungen. Inventur erwartet sollMenge (nicht die Differenz).
- Schreibende Tools brauchen einen API-Key mit Scope "write".
- Fehler kommen als Text mit CODE: message zurueck.`

function text(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: (data !== null && typeof data === 'object'
      ? data
      : { value: data }) as Record<string, unknown>,
  }
}

function toolError(err: unknown) {
  if (err instanceof ApiV1Error) {
    return {
      content: [{ type: 'text' as const, text: `${err.code}: ${err.message}` }],
      isError: true,
    }
  }
  const message = err instanceof Error ? err.message : String(err)
  return {
    content: [{ type: 'text' as const, text: `INTERNAL: ${message}` }],
    isError: true,
  }
}

function assertScope(auth: ApiAuthContext, scope: ApiKeyScope): void {
  if (!scopeErlaubt(auth.scopes, scope)) {
    throw new ApiV1Error(403, 'FORBIDDEN', `API-Key hat den Scope "${scope}" nicht`)
  }
  if (scope === 'admin' && auth.rolle !== 'admin') {
    throw new ApiV1Error(403, 'FORBIDDEN', 'Admin-Scope erfordert einen Admin-User')
  }
}

export function createMcpServer(
  auth: ApiAuthContext,
  gateway?: NotificationGateway,
): McpServer {
  const server = new McpServer(
    { name: 'castel', version: '1.0.0' },
    {
      instructions: INSTRUCTIONS,
      capabilities: { logging: {} },
    },
  )

  server.registerTool(
    'castel_get_meta',
    {
      title: 'castel API metadata',
      description:
        'Returns API version, authentication info, units, limits and the MCP endpoint. Read-only.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        assertScope(auth, 'read')
        return text(await getApiMeta())
      } catch (err) {
        return toolError(err)
      }
    },
  )

  server.registerTool(
    'castel_get_status',
    {
      title: 'castel row counts',
      description: 'Returns server time and row counts for articles, locations, bookings and events.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        assertScope(auth, 'read')
        return text(await getStatus())
      } catch (err) {
        return toolError(err)
      }
    },
  )

  server.registerTool(
    'castel_search_artikel',
    {
      title: 'Search articles',
      description:
        'Search and filter articles by free text, type, status or barcode. Returns paginated results.',
      inputSchema: {
        q: z.string().max(120).optional().describe('Free text across title, barcode, order number, type and supplier'),
        typ: z.string().max(120).optional().describe('Exact article type'),
        status: z
          .enum(['verfuegbar', 'reserviert', 'gesperrt', 'ausgesondert', 'archiviert'])
          .optional(),
        barcode: z.string().max(120).optional().describe('Exact barcode'),
        limit: z.number().int().min(1).max(200).optional().describe('Default 50, max 200'),
        offset: z.number().int().min(0).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        assertScope(auth, 'read')
        return text(
          await listeArtikel({
            q: args.q,
            typ: args.typ,
            status: args.status,
            barcode: args.barcode,
            limit: args.limit ?? 50,
            offset: args.offset ?? 0,
          }),
        )
      } catch (err) {
        return toolError(err)
      }
    },
  )

  server.registerTool(
    'castel_get_artikel',
    {
      title: 'Get article with stock',
      description:
        'Returns a single article including its stock per location. Use this before removing stock.',
      inputSchema: { id: z.string().min(1).describe('Article UUID') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      try {
        assertScope(auth, 'read')
        return text(await getArtikel(id))
      } catch (err) {
        return toolError(err)
      }
    },
  )

  server.registerTool(
    'castel_list_standorte',
    {
      title: 'List locations',
      description: 'Lists storage locations. Archived locations are hidden by default.',
      inputSchema: {
        includeArchived: z.boolean().optional().describe('Include archived locations'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ includeArchived }) => {
      try {
        assertScope(auth, 'read')
        return text({ items: await listeStandorte(includeArchived === true) })
      } catch (err) {
        return toolError(err)
      }
    },
  )

  server.registerTool(
    'castel_get_bestand',
    {
      title: 'Get stock',
      description:
        'Returns stock for one article. Without standortId it returns the stock per location and the total.',
      inputSchema: {
        artikelId: z.string().min(1),
        standortId: z.string().min(1).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ artikelId, standortId }) => {
      try {
        assertScope(auth, 'read')
        return text(await getBestand(artikelId, standortId))
      } catch (err) {
        return toolError(err)
      }
    },
  )

  server.registerTool(
    'castel_list_buchungen',
    {
      title: 'List bookings',
      description:
        'Lists bookings (append-only history), newest first. Amounts are signed as stored on the server.',
      inputSchema: {
        artikelId: z.string().min(1).optional(),
        standortId: z.string().min(1).optional(),
        typ: z
          .enum(['einlagerung', 'entnahme', 'umlagerung', 'inventur', 'kommission', 'storno'])
          .optional(),
        von: z.string().optional().describe('ISO-8601 lower bound'),
        bis: z.string().optional().describe('ISO-8601 upper bound'),
        nurAktive: z.boolean().optional().describe('Exclude cancelled bookings'),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        assertScope(auth, 'read')
        return text(
          await listeBuchungen({
            artikelId: args.artikelId,
            standortId: args.standortId,
            typ: args.typ,
            von: args.von,
            bis: args.bis,
            nurAktive: args.nurAktive,
            limit: args.limit ?? 50,
            offset: args.offset ?? 0,
          }),
        )
      } catch (err) {
        return toolError(err)
      }
    },
  )

  server.registerTool(
    'castel_create_buchung',
    {
      title: 'Create booking',
      description:
        'Creates an append-only booking. Types: einlagerung (+), entnahme (-), umlagerung (requires vonStandortId/nachStandortId) and inventur (requires sollMenge). Amounts are positive; the server stores the correct sign.',
      inputSchema: {
        typ: z.enum(['einlagerung', 'entnahme', 'umlagerung', 'inventur']),
        artikelId: z.string().min(1),
        standortId: z.string().min(1).optional().describe('Required except for umlagerung'),
        vonStandortId: z.string().min(1).optional().describe('Required for umlagerung'),
        nachStandortId: z.string().min(1).optional().describe('Required for umlagerung'),
        menge: z.number().int().positive().optional().describe('Required except for inventur'),
        sollMenge: z.number().int().min(0).optional().describe('Required for inventur'),
        projekt: z.string().max(200).optional(),
        kommentar: z.string().max(2000).optional(),
        mitteilungAn: z.string().max(500).optional(),
        erstelltAm: z.string().optional(),
        id: z.string().min(1).optional().describe('Optional client UUID for idempotent retries'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      try {
        assertScope(auth, 'write')
        const parsed = buchungCreateSchema.safeParse(args)
        if (!parsed.success) {
          throw new ApiV1Error(400, 'VALIDATION', 'Ungültige Buchungsdaten', parsed.error.issues)
        }
        return text(await erstelleBuchung(parsed.data, auth, gateway))
      } catch (err) {
        return toolError(err)
      }
    },
  )

  server.registerTool(
    'castel_storno_buchung',
    {
      title: 'Cancel booking (Storno)',
      description:
        'Creates a storno booking and marks the original as cancelled. Idempotent if the booking is already cancelled.',
      inputSchema: {
        id: z.string().min(1).describe('Original booking UUID'),
        grund: z.string().max(2000).optional().describe('Reason for the cancellation'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ id, grund }) => {
      try {
        assertScope(auth, 'write')
        return text(
          await storniereBuchung(
            id,
            grund ?? 'Storno via MCP',
            auth,
            gateway,
          ),
        )
      } catch (err) {
        return toolError(err)
      }
    },
  )

  server.registerTool(
    'castel_kommissioniere_buchung',
    {
      title: 'Reassign booking to a commission',
      description:
        'Cancels the original booking and creates a replacement with the same amount at the same location but a new project/commission.',
      inputSchema: {
        id: z.string().min(1).describe('Original booking UUID'),
        projekt: z.string().min(1).max(200).describe('New project/commission name'),
        kommentar: z.string().max(2000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ id, projekt, kommentar }) => {
      try {
        assertScope(auth, 'write')
        return text(
          await kommissioniereBuchung(id, projekt, kommentar ?? null, auth, gateway),
        )
      } catch (err) {
        return toolError(err)
      }
    },
  )

  server.registerTool(
    'castel_create_artikel',
    {
      title: 'Create article',
      description:
        'Creates a new article. Prices are in cents. Optional id allows idempotent retries.',
      inputSchema: {
        id: z.string().min(1).optional(),
        titel: z.string().min(1).max(300),
        typ: z.string().max(120).optional(),
        status: z
          .enum(['verfuegbar', 'reserviert', 'gesperrt', 'ausgesondert', 'archiviert'])
          .optional(),
        lieferant: z.string().max(200).optional(),
        verpackungseinheit: z.number().int().positive().optional(),
        mindestbestand: z.number().int().optional(),
        nachbestellHinweis: z.enum(['i.O', 'bald', 'dringend']).optional(),
        bestellnummer: z.string().max(200).optional(),
        barcode: z.string().max(200).optional(),
        listenpreis: z.number().int().optional().describe('Price in cents'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      try {
        assertScope(auth, 'write')
        const parsed = artikelCreateSchema.safeParse(args)
        if (!parsed.success) {
          throw new ApiV1Error(400, 'VALIDATION', 'Ungültige Artikeldaten', parsed.error.issues)
        }
        return text(await createArtikel(parsed.data, auth))
      } catch (err) {
        return toolError(err)
      }
    },
  )

  server.registerTool(
    'castel_update_artikel',
    {
      title: 'Update article',
      description: 'Updates fields of an existing article. Only provided fields change.',
      inputSchema: {
        id: z.string().min(1),
        titel: z.string().min(1).max(300).optional(),
        typ: z.string().max(120).optional(),
        status: z
          .enum(['verfuegbar', 'reserviert', 'gesperrt', 'ausgesondert', 'archiviert'])
          .optional(),
        lieferant: z.string().max(200).optional(),
        verpackungseinheit: z.number().int().positive().optional(),
        mindestbestand: z.number().int().optional(),
        nachbestellHinweis: z.enum(['i.O', 'bald', 'dringend']).optional(),
        bestellnummer: z.string().max(200).optional(),
        barcode: z.string().max(200).optional(),
        listenpreis: z.number().int().optional().describe('Price in cents'),
        etikettenNeu: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) => {
      try {
        assertScope(auth, 'write')
        const { id, ...patch } = args
        const parsed = artikelPatchSchema.safeParse(patch)
        if (!parsed.success) {
          throw new ApiV1Error(400, 'VALIDATION', 'Ungültige Artikeldaten', parsed.error.issues)
        }
        return text(await updateArtikel(id, parsed.data, auth))
      } catch (err) {
        return toolError(err)
      }
    },
  )

  server.registerTool(
    'castel_list_mindestbestand',
    {
      title: 'List minimum-stock events',
      description:
        'Lists events where stock fell below the article minimum, newest first.',
      inputSchema: {
        artikelId: z.string().min(1).optional(),
        standortId: z.string().min(1).optional(),
        seit: z.string().optional().describe('ISO-8601 lower bound'),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        assertScope(auth, 'read')
        return text(
          await listeMindestbestand({
            artikelId: args.artikelId,
            standortId: args.standortId,
            seit: args.seit,
            limit: args.limit ?? 50,
            offset: args.offset ?? 0,
          }),
        )
      } catch (err) {
        return toolError(err)
      }
    },
  )

  server.registerTool(
    'castel_list_kommissionen',
    {
      title: 'List commissions',
      description: 'Lists commissions/projects used for booking classification.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        assertScope(auth, 'read')
        return text({ items: await listeKommissionen() })
      } catch (err) {
        return toolError(err)
      }
    },
  )

  return server
}
