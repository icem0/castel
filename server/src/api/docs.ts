// OpenAPI-3.1-Dokument der Agenten-API.
//
// Die Request-Schemas kommen direkt aus den Zod-Vertraegen; damit koennen
// Doku und Validierung nicht auseinanderlaufen. Die Spec wird statisch
// gebaut und von @fastify/swagger-ui unter /api/docs ausgeliefert.

import { zodToJsonSchema } from 'zod-to-json-schema'
import {
  artikelCreateSchema,
  artikelPatchSchema,
  buchungCreateSchema,
  kommissionBodySchema,
  standortCreateSchema,
  standortPatchSchema,
  stornoBodySchema,
} from './v1/schemas.js'

function jsonSchema(schema: Parameters<typeof zodToJsonSchema>[0]): Record<string, unknown> {
  return zodToJsonSchema(schema, {
    target: 'openApi3',
    $refStrategy: 'none',
  }) as Record<string, unknown>
}

const errorResponse = {
  description: 'Fehler',
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/Error' },
    },
  },
}

const security = [{ bearerApiKey: [] }, { apiKeyHeader: [] }]

function paginationParams(): unknown[] {
  return [
    {
      name: 'limit',
      in: 'query',
      schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    },
    { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
  ]
}

export function buildOpenApiSpec(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'castel Agenten-API',
      version: '1.0.0',
      description:
        'Maschinenlesbare API fuer KI-Agenten. Bestand ist die Summe aller ' +
        'Buchungen mit storno=false; Mengen werden niemals ueberschrieben. ' +
        'Authentifizierung per API-Key mit den Scopes read, write und admin.',
    },
    servers: [{ url: '/' }],
    tags: [
      { name: 'meta', description: 'Discovery und Status' },
      { name: 'artikel', description: 'Artikel und Bestand' },
      { name: 'standorte', description: 'Lagerstandorte' },
      { name: 'buchungen', description: 'Append-only Buchungen' },
      { name: 'kommissionen', description: 'Kommissionen/Projekte' },
      { name: 'mindestbestand', description: 'Mindestbestand-Ereignisse' },
      { name: 'audit', description: 'Audit-Log (admin)' },
    ],
    components: {
      securitySchemes: {
        bearerApiKey: {
          type: 'http',
          scheme: 'bearer',
          description: 'Authorization: Bearer castel_...',
        },
        apiKeyHeader: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          description: 'Alternativ zum Bearer-Header.',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['code', 'message'],
          properties: {
            code: { type: 'string', example: 'VALIDATION' },
            message: { type: 'string' },
            details: {},
          },
        },
        Artikel: jsonSchema(artikelCreateSchema),
        ArtikelPatch: jsonSchema(artikelPatchSchema),
        Standort: jsonSchema(standortCreateSchema),
        StandortPatch: jsonSchema(standortPatchSchema),
        BuchungCreate: jsonSchema(buchungCreateSchema),
        StornoBody: jsonSchema(stornoBodySchema),
        KommissionBody: jsonSchema(kommissionBodySchema),
        Buchung: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            artikelId: { type: 'string' },
            standortId: { type: 'string' },
            standortZielId: { type: 'string', nullable: true },
            typ: {
              type: 'string',
              enum: ['einlagerung', 'entnahme', 'umlagerung', 'inventur', 'kommission', 'storno'],
            },
            menge: { type: 'integer', description: 'Signed amount as stored on the server' },
            paarId: { type: 'string', nullable: true },
            projekt: { type: 'string', nullable: true },
            erstelltAm: { type: 'string', format: 'date-time' },
            clientEingabeAm: { type: 'string', format: 'date-time', nullable: true },
            erstelltVon: { type: 'string' },
            kommentar: { type: 'string', nullable: true },
            mitteilungAn: { type: 'string', nullable: true },
            stornoVon: { type: 'string', nullable: true },
            storno: { type: 'boolean' },
            storniertDurch: { type: 'string', nullable: true },
          },
        },
        Paginated: {
          type: 'object',
          properties: {
            items: { type: 'array', items: {} },
            total: { type: 'integer' },
            limit: { type: 'integer' },
            offset: { type: 'integer' },
          },
        },
      },
    },
    paths: {
      '/api/v1/meta': {
        get: {
          tags: ['meta'],
          summary: 'API-Metadaten (public)',
          description:
            'Liefert Version, Docs-URL, MCP-Endpunkt, Einheiten, Limits und Fehlercodes. Kein API-Key noetig.',
          responses: { '200': { description: 'Metadaten' } },
        },
      },
      '/api/v1/status': {
        get: {
          tags: ['meta'],
          summary: 'Zeilen-Zaehler und Serverzeit',
          security,
          responses: { '200': { description: 'Status' }, '401': errorResponse },
        },
      },
      '/api/v1/artikel': {
        get: {
          tags: ['artikel'],
          summary: 'Artikel suchen',
          security,
          parameters: [
            { name: 'q', in: 'query', schema: { type: 'string' } },
            { name: 'typ', in: 'query', schema: { type: 'string' } },
            {
              name: 'status',
              in: 'query',
              schema: {
                type: 'string',
                enum: ['verfuegbar', 'reserviert', 'gesperrt', 'ausgesondert', 'archiviert'],
              },
            },
            { name: 'barcode', in: 'query', schema: { type: 'string' } },
            ...paginationParams(),
          ],
          responses: { '200': { description: 'Liste' }, '401': errorResponse },
        },
        post: {
          tags: ['artikel'],
          summary: 'Artikel anlegen',
          security,
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Artikel' } } },
          },
          responses: {
            '201': { description: 'Angelegt' },
            '400': errorResponse,
            '401': errorResponse,
            '403': errorResponse,
          },
        },
      },
      '/api/v1/artikel/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        get: {
          tags: ['artikel'],
          summary: 'Artikel mit Bestand je Standort',
          security,
          responses: {
            '200': { description: 'Artikel + bestand[] + bestandGesamt' },
            '404': errorResponse,
          },
        },
        patch: {
          tags: ['artikel'],
          summary: 'Artikel aktualisieren',
          security,
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ArtikelPatch' } },
            },
          },
          responses: { '200': { description: 'Aktualisiert' }, '400': errorResponse },
        },
        delete: {
          tags: ['artikel'],
          summary: 'Artikel loeschen (admin)',
          description:
            'Hartes Loeschen. Schlaegt mit HAS_DEPENDENCIES fehl, wenn noch Buchungen existieren. Fuer den Normalfall stattdessen status=archiviert setzen.',
          security,
          responses: {
            '204': { description: 'Geloescht' },
            '409': errorResponse,
            '403': errorResponse,
          },
        },
      },
      '/api/v1/standorte': {
        get: {
          tags: ['standorte'],
          summary: 'Standorte auflisten',
          security,
          parameters: [
            { name: 'alle', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } },
          ],
          responses: { '200': { description: 'Liste' } },
        },
        post: {
          tags: ['standorte'],
          summary: 'Standort anlegen',
          security,
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Standort' } },
            },
          },
          responses: { '201': { description: 'Angelegt' }, '400': errorResponse },
        },
      },
      '/api/v1/standorte/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        patch: {
          tags: ['standorte'],
          summary: 'Standort aktualisieren',
          security,
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/StandortPatch' } },
            },
          },
          responses: { '200': { description: 'Aktualisiert' }, '400': errorResponse },
        },
      },
      '/api/v1/bestand': {
        get: {
          tags: ['artikel'],
          summary: 'Bestand eines Artikels',
          security,
          parameters: [
            {
              name: 'artikelId',
              in: 'query',
              required: true,
              schema: { type: 'string' },
            },
            { name: 'standortId', in: 'query', schema: { type: 'string' } },
          ],
          responses: { '200': { description: 'Bestand' }, '404': errorResponse },
        },
      },
      '/api/v1/buchungen': {
        get: {
          tags: ['buchungen'],
          summary: 'Buchungen auflisten',
          security,
          parameters: [
            { name: 'artikelId', in: 'query', schema: { type: 'string' } },
            { name: 'standortId', in: 'query', schema: { type: 'string' } },
            {
              name: 'typ',
              in: 'query',
              schema: {
                type: 'string',
                enum: [
                  'einlagerung',
                  'entnahme',
                  'umlagerung',
                  'inventur',
                  'kommission',
                  'storno',
                ],
              },
            },
            { name: 'von', in: 'query', schema: { type: 'string', format: 'date-time' } },
            { name: 'bis', in: 'query', schema: { type: 'string', format: 'date-time' } },
            { name: 'nurAktive', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } },
            ...paginationParams(),
          ],
          responses: { '200': { description: 'Liste' } },
        },
        post: {
          tags: ['buchungen'],
          summary: 'Buchung anlegen',
          description:
            'Erzeugt eine append-only Buchung. Entnahme/Einlagerung mit positiver menge; ' +
            'Umlagerung mit vonStandortId/nachStandortId; Inventur mit sollMenge.',
          security,
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/BuchungCreate' } },
            },
          },
          responses: {
            '201': { description: 'Buchung(en) angelegt' },
            '409': errorResponse,
            '422': errorResponse,
          },
        },
      },
      '/api/v1/buchungen/{id}/storno': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        post: {
          tags: ['buchungen'],
          summary: 'Buchung stornieren',
          security,
          requestBody: {
            required: false,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/StornoBody' } },
            },
          },
          responses: { '200': { description: 'Storno-Ergebnis' }, '404': errorResponse },
        },
      },
      '/api/v1/buchungen/{id}/kommission': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        post: {
          tags: ['buchungen'],
          summary: 'Buchung einer anderen Kommission zuordnen',
          security,
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/KommissionBody' } },
            },
          },
          responses: { '201': { description: 'Storno + Neubuchung' }, '409': errorResponse },
        },
      },
      '/api/v1/kommissionen': {
        get: {
          tags: ['kommissionen'],
          summary: 'Kommissionen auflisten',
          security,
          responses: { '200': { description: 'Liste' } },
        },
      },
      '/api/v1/mindestbestand': {
        get: {
          tags: ['mindestbestand'],
          summary: 'Mindestbestand-Ereignisse',
          security,
          parameters: [
            { name: 'artikelId', in: 'query', schema: { type: 'string' } },
            { name: 'standortId', in: 'query', schema: { type: 'string' } },
            { name: 'seit', in: 'query', schema: { type: 'string', format: 'date-time' } },
            ...paginationParams(),
          ],
          responses: { '200': { description: 'Liste' } },
        },
      },
      '/api/v1/audit': {
        get: {
          tags: ['audit'],
          summary: 'Audit-Log lesen (admin)',
          security,
          parameters: [
            { name: 'entitaet', in: 'query', schema: { type: 'string' } },
            { name: 'entitaetId', in: 'query', schema: { type: 'string' } },
            { name: 'von', in: 'query', schema: { type: 'string', format: 'date-time' } },
            { name: 'bis', in: 'query', schema: { type: 'string', format: 'date-time' } },
            ...paginationParams(),
          ],
          responses: { '200': { description: 'Liste' }, '403': errorResponse },
        },
      },
    },
  }
}

