// Zod-Vertraege der Agenten-API v1.
//
// Diese Schemas sind die maschinenlesbare Wahrheit fuer OpenAPI und werden
// sowohl von den REST-Routen als auch (indirekt) von den MCP-Tools genutzt.
// Semantik bewusst agentenfreundlich: positive Mengen bei Entnahme,
// `sollMenge` bei Inventur, ISO-8601-Zeitstempel.

import { z } from 'zod'

const iso = z.string().refine((s) => !Number.isNaN(Date.parse(s)), {
  message: 'muss ISO-8601-Datum sein',
})

const isoKeineZukunft = iso.refine((s) => Date.parse(s) - 60_000 <= Date.now(), {
  message: 'Datum liegt in der Zukunft',
})

const id = z.string().min(1)

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})

export const artikelQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(120).optional(),
  typ: z.string().trim().max(120).optional(),
  status: z
    .enum(['verfuegbar', 'reserviert', 'gesperrt', 'ausgesondert', 'archiviert'])
    .optional(),
  barcode: z.string().trim().max(120).optional(),
})

const artikelBasis = {
  titel: z.string().trim().min(1).max(300),
  status: z
    .enum(['verfuegbar', 'reserviert', 'gesperrt', 'ausgesondert', 'archiviert'])
    .default('verfuegbar'),
  typ: z.string().trim().max(120).default(''),
  lieferant: z.string().trim().max(200).nullable().optional(),
  verpackungseinheit: z.number().int().positive().default(1),
  mindestbestand: z.number().int().nullable().optional(),
  nachbestellHinweis: z.enum(['i.O', 'bald', 'dringend']).nullable().optional(),
  bestellnummer: z.string().trim().max(200).nullable().optional(),
  barcode: z.string().trim().max(200).nullable().optional(),
  etikettenNeu: z.boolean().optional(),
  listenpreis: z.number().int().nullable().optional(),
  herstellerId: z.string().nullable().optional(),
  bestellstatus: z.enum(['offen', 'bestellt']).optional(),
  bestelltAm: z.string().nullable().optional(),
  bestelltVon: z.string().nullable().optional(),
}

export const artikelCreateSchema = z.object({
  id: id.optional(),
  ...artikelBasis,
})

export const artikelPatchSchema = z
  .object({
    titel: z.string().trim().min(1).max(300).optional(),
    status: z
      .enum(['verfuegbar', 'reserviert', 'gesperrt', 'ausgesondert', 'archiviert'])
      .optional(),
    typ: z.string().trim().max(120).optional(),
    lieferant: z.string().trim().max(200).nullable().optional(),
    verpackungseinheit: z.number().int().positive().optional(),
    mindestbestand: z.number().int().nullable().optional(),
    nachbestellHinweis: z.enum(['i.O', 'bald', 'dringend']).nullable().optional(),
    bestellnummer: z.string().trim().max(200).nullable().optional(),
    barcode: z.string().trim().max(200).nullable().optional(),
    etikettenNeu: z.boolean().optional(),
    listenpreis: z.number().int().nullable().optional(),
    herstellerId: z.string().nullable().optional(),
    bestellstatus: z.enum(['offen', 'bestellt']).optional(),
    bestelltAm: z.string().nullable().optional(),
    bestelltVon: z.string().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'keine Änderungen angegeben' })

export const standortCreateSchema = z.object({
  id: id.optional(),
  name: z.string().trim().min(1).max(200),
  typ: z.enum(['lager', 'auto', 'baustelle', 'extern']),
  projekt: z.string().trim().max(200).nullable().optional(),
  kennzeichen: z.string().trim().max(120).nullable().optional(),
  standard: z.boolean().default(false),
  archiviert: z.boolean().default(false),
})

export const standortPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    typ: z.enum(['lager', 'auto', 'baustelle', 'extern']).optional(),
    projekt: z.string().trim().max(200).nullable().optional(),
    kennzeichen: z.string().trim().max(120).nullable().optional(),
    standard: z.boolean().optional(),
    archiviert: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'keine Änderungen angegeben' })

const buchungBasis = {
  id: id.optional(),
  artikelId: id,
  projekt: z.string().trim().max(200).nullable().optional(),
  kommentar: z.string().trim().max(2000).nullable().optional(),
  mitteilungAn: z.string().trim().max(500).nullable().optional(),
  erstelltAm: isoKeineZukunft.optional(),
  clientEingabeAm: iso.optional(),
}

export const buchungCreateSchema = z.discriminatedUnion('typ', [
  z.object({
    ...buchungBasis,
    typ: z.literal('einlagerung'),
    standortId: id,
    menge: z.number().int().positive(),
  }),
  z.object({
    ...buchungBasis,
    typ: z.literal('entnahme'),
    standortId: id,
    menge: z.number().int().positive(),
  }),
  z.object({
    ...buchungBasis,
    typ: z.literal('umlagerung'),
    vonStandortId: id,
    nachStandortId: id,
    menge: z.number().int().positive(),
  }),
  z.object({
    ...buchungBasis,
    typ: z.literal('inventur'),
    standortId: id,
    sollMenge: z.number().int().min(0),
  }),
])

export type BuchungCreateInput = z.infer<typeof buchungCreateSchema>

export const stornoBodySchema = z.object({
  grund: z.string().trim().min(1).max(2000).default('Storno via Agenten-API'),
})

export const kommissionBodySchema = z.object({
  projekt: z.string().trim().min(1).max(200),
  kommentar: z.string().trim().max(2000).nullable().optional(),
})

export const buchungQuerySchema = paginationSchema.extend({
  artikelId: id.optional(),
  standortId: id.optional(),
  typ: z
    .enum(['einlagerung', 'entnahme', 'umlagerung', 'inventur', 'kommission', 'storno'])
    .optional(),
  von: iso.optional(),
  bis: iso.optional(),
  nurAktive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
})

export const bestandQuerySchema = z.object({
  artikelId: id,
  standortId: id.optional(),
})

export const mindestbestandQuerySchema = paginationSchema.extend({
  artikelId: id.optional(),
  standortId: id.optional(),
  seit: iso.optional(),
})

export const auditQuerySchema = paginationSchema.extend({
  entitaet: z
    .enum([
      'artikel',
      'standort',
      'buchung',
      'kommission',
      'foto',
      'user',
      'einstellung',
      'lieferant',
      'hersteller_artikel',
      'datanorm_import',
    ])
    .optional(),
  entitaetId: id.optional(),
  von: iso.optional(),
  bis: iso.optional(),
})

export const idParamsSchema = z.object({ id })
