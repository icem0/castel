// Service-Layer der Agenten-API v1.
//
// REST-Routen und MCP-Tools teilen sich diese Funktionen. Schreibpfade
// laufen bewusst ueber den bestehenden Sync-Resolver, damit Audit-Log,
// Mindestbestand-Ereignisse und Notification-Gateway identisch zur PWA
// funktionieren. Die Inventur ist der einzige Sonderfall: sie muss den
// Bestand INNERHALB derselben Transaktion lesen und schreiben.

import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm'
import { getDb } from '../../db/client.js'
import {
  artikel,
  artikelStandortMindestbestaende,
  auditLog,
  buchungen,
  mindestbestandEreignisse,
  projekte,
  standorte,
} from '../../db/schema.js'
import {
  resolveBuchungCreate,
  resolvePush,
  type BuchungPayload,
  type MindestbestandEreignisRow,
  type PushOp,
} from '../../sync/resolver.js'
import { berechneBestand, berechneBestaendeProArtikel } from '../../domain/bestand.js'
import type { NotificationGateway } from '../../services/notification-gateway.js'
import type { ApiAuthContext } from '../../auth/api-key-auth.js'
import type {
  BuchungCreateInput,
  artikelCreateSchema,
  artikelPatchSchema,
  standortCreateSchema,
  standortPatchSchema,
} from './schemas.js'
import type { z } from 'zod'
import { config } from '../../config/config.js'

export class ApiV1Error extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ApiV1Error'
  }
}

type ArtikelInput = z.infer<typeof artikelCreateSchema>
type ArtikelPatch = z.infer<typeof artikelPatchSchema>
type StandortInput = z.infer<typeof standortCreateSchema>
type StandortPatch = z.infer<typeof standortPatchSchema>

function isoOf(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string') {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? value : d.toISOString()
  }
  return String(value)
}

function isoRequired(value: unknown): string {
  const out = isoOf(value)
  if (out === null) throw new ApiV1Error(500, 'INTERNAL', 'Timestamp fehlt')
  return out
}

function alsOp(
  op: 'create' | 'update' | 'delete',
  entity: 'artikel' | 'standort' | 'kommission' | 'buchung' | 'artikel_standort_mindestbestand',
  payload: unknown,
): PushOp {
  return { op, entity, payload } as PushOp
}

/**
 * Der Werks-/Standardstandort ist in der App das "Hauptlager". Der
 * Mindestbestand der Agenten-API v1 (`artikel.mindestbestand`) wird aus
 * Kompatibilitaetsgruenden in dessen Konfiguration gespiegelt.
 */
async function standardStandortId(): Promise<string | null> {
  const rows = await getDb()
    .select({ id: standorte.id })
    .from(standorte)
    .where(and(eq(standorte.standard, true), eq(standorte.archiviert, false)))
    .limit(1)
  return rows[0]?.id ?? null
}

async function setzeStandardMindestbestand(
  artikelId: string,
  wert: number | null | undefined,
  auth: ApiAuthContext,
): Promise<void> {
  if (wert === undefined) return
  const standortId = await standardStandortId()
  if (standortId === null) return
  const now = new Date().toISOString()
  const payload = { artikelId, standortId, geaendertAm: now, erstelltAm: now }
  if (wert === null || wert <= 0) {
    // Sparse: kein Wert = keine Zeile. Delete ist idempotent.
    await fuehreOpsAus(
      [alsOp('delete', 'artikel_standort_mindestbestand', { ...payload, mindestbestand: 0 })],
      auth,
    )
    return
  }
  const op: PushOp = {
    op: 'create',
    entity: 'artikel_standort_mindestbestand',
    payload: { ...payload, mindestbestand: wert },
  }
  await fuehreOpsAus([op], auth)
}

function checkResolverResult(result: {
  errors: Array<{ code: string; message: string; currentBestand?: number }>
  conflicts: Array<{ reason: string }>
}): void {
  if (result.errors.length > 0) {
    const err = result.errors[0]!
    const status =
      err.code === 'NEGATIVE_BESTAND' || err.code === 'UNKNOWN_REFERENCE'
        ? 422
        : err.code === 'VALIDATION'
          ? 400
          : err.code === 'HAS_DEPENDENCIES' || err.code === 'PROTECTED_STANDORT'
            ? 409
            : 500
    throw new ApiV1Error(status, err.code, err.message, {
      currentBestand: err.currentBestand,
    })
  }
  if (result.conflicts.length > 0) {
    throw new ApiV1Error(409, 'CONFLICT', result.conflicts[0]!.reason)
  }
}

async function fuehreOpsAus(
  ops: PushOp[],
  auth: ApiAuthContext,
  gateway?: NotificationGateway,
): Promise<void> {
  const result = await resolvePush(getDb(), ops, auth.userId, auth.rolle, gateway)
  checkResolverResult(result)
}

// ---------- Artikel ----------

export interface ArtikelDto {
  id: string
  sharePointId: number | null
  titel: string
  status: string
  typ: string
  lieferant: string | null
  verpackungseinheit: number
  mindestbestand: number | null
  nachbestellHinweis: string | null
  bestellnummer: string | null
  barcode: string | null
  etikettenNeu: boolean
  listenpreis: number | null
  herstellerId: string | null
  bestellstatus: string
  bestelltAm: string | null
  bestelltVon: string | null
  geaendertAm: string
  erstelltAm: string
}

function artikelDto(row: typeof artikel.$inferSelect): ArtikelDto {
  return {
    id: row.id,
    sharePointId: row.sharePointId,
    titel: row.titel,
    status: row.status,
    typ: row.typ,
    lieferant: row.lieferant,
    verpackungseinheit: row.verpackungseinheit,
    mindestbestand: row.mindestbestand,
    nachbestellHinweis: row.nachbestellHinweis,
    bestellnummer: row.bestellnummer,
    barcode: row.barcode,
    etikettenNeu: row.etikettenNeu,
    listenpreis: row.listenpreis,
    herstellerId: row.herstellerId,
    bestellstatus: row.bestellstatus,
    bestelltAm: row.bestelltAm === null ? null : isoRequired(row.bestelltAm),
    bestelltVon: row.bestelltVon,
    geaendertAm: isoRequired(row.geaendertAm),
    erstelltAm: isoRequired(row.erstelltAm),
  }
}

function artikelPayload(row: typeof artikel.$inferSelect): Record<string, unknown> {
  return {
    id: row.id,
    sharePointId: row.sharePointId,
    titel: row.titel,
    status: row.status,
    typ: row.typ,
    lieferant: row.lieferant,
    verpackungseinheit: row.verpackungseinheit,
    mindestbestand: row.mindestbestand,
    nachbestellHinweis: row.nachbestellHinweis,
    bestellnummer: row.bestellnummer,
    barcode: row.barcode,
    etikettenNeu: row.etikettenNeu,
    listenpreis: row.listenpreis,
    herstellerId: row.herstellerId,
    bestellstatus: row.bestellstatus,
    bestelltAm: row.bestelltAm === null ? null : isoRequired(row.bestelltAm),
    bestelltVon: row.bestelltVon,
    geaendertAm: isoRequired(row.geaendertAm),
    erstelltAm: isoRequired(row.erstelltAm),
  }
}

export interface ArtikelListeParams {
  q?: string
  typ?: string
  status?: string
  barcode?: string
  limit: number
  offset: number
}

export async function listeArtikel(params: ArtikelListeParams): Promise<{
  items: ArtikelDto[]
  total: number
  limit: number
  offset: number
}> {
  const db = getDb()
  const conditions: SQL[] = []
  if (params.q) {
    const like = `%${params.q}%`
    conditions.push(
      or(
        ilike(artikel.titel, like),
        ilike(artikel.barcode, like),
        ilike(artikel.bestellnummer, like),
        ilike(artikel.typ, like),
        ilike(artikel.lieferant, like),
      )!,
    )
  }
  if (params.typ) conditions.push(eq(artikel.typ, params.typ))
  if (params.status) conditions.push(eq(artikel.status, params.status as never))
  if (params.barcode) conditions.push(eq(artikel.barcode, params.barcode))
  const where = conditions.length > 0 ? and(...conditions) : undefined

  const [rows, countRows] = await Promise.all([
    db
      .select()
      .from(artikel)
      .where(where)
      .orderBy(asc(artikel.titel))
      .limit(params.limit)
      .offset(params.offset),
    db.select({ c: sql<number>`count(*)::int` }).from(artikel).where(where),
  ])
  return {
    items: rows.map(artikelDto),
    total: countRows[0]?.c ?? 0,
    limit: params.limit,
    offset: params.offset,
  }
}

export interface ArtikelDetail extends ArtikelDto {
  bestand: Array<{ standortId: string; standortName: string; menge: number }>
  bestandGesamt: number
  /** Mindestbestand je Lager. Nur konfigurierte Lager sind enthalten. */
  mindestbestandJeStandort: Array<{ standortId: string; mindestbestand: number }>
}

export async function getArtikel(id: string): Promise<ArtikelDetail> {
  const db = getDb()
  const rows = await db.select().from(artikel).where(eq(artikel.id, id)).limit(1)
  const row = rows[0]
  if (!row) throw new ApiV1Error(404, 'NOT_FOUND', `Artikel ${id} nicht gefunden`)
  const bestaende = await berechneBestaendeProArtikel(db, id)
  const [standortRows, mindestRows] = await Promise.all([
    db.select().from(standorte),
    db
      .select({
        standortId: artikelStandortMindestbestaende.standortId,
        mindestbestand: artikelStandortMindestbestaende.mindestbestand,
      })
      .from(artikelStandortMindestbestaende)
      .where(eq(artikelStandortMindestbestaende.artikelId, id)),
  ])
  const namen = new Map(standortRows.map((s) => [s.id, s.name]))
  return {
    ...artikelDto(row),
    bestand: bestaende.map((b) => ({
      standortId: b.standortId,
      standortName: namen.get(b.standortId) ?? b.standortId,
      menge: b.menge,
    })),
    bestandGesamt: bestaende.reduce((sum, b) => sum + b.menge, 0),
    mindestbestandJeStandort: mindestRows.map((r) => ({
      standortId: r.standortId,
      mindestbestand: r.mindestbestand,
    })),
  }
}

export async function createArtikel(
  input: ArtikelInput,
  auth: ApiAuthContext,
): Promise<ArtikelDetail> {
  const now = new Date().toISOString()
  const payload = {
    id: input.id ?? crypto.randomUUID(),
    sharePointId: null,
    titel: input.titel,
    status: input.status,
    typ: input.typ,
    lieferant: input.lieferant ?? null,
    verpackungseinheit: input.verpackungseinheit,
    mindestbestand: input.mindestbestand ?? null,
    nachbestellHinweis: input.nachbestellHinweis ?? null,
    bestellnummer: input.bestellnummer ?? null,
    barcode: input.barcode ?? null,
    etikettenNeu: input.etikettenNeu ?? true,
    listenpreis: input.listenpreis ?? null,
    herstellerId: input.herstellerId ?? null,
    bestellstatus: input.bestellstatus ?? 'offen',
    bestelltAm: input.bestelltAm ?? null,
    bestelltVon: input.bestelltVon ?? null,
    geaendertAm: now,
    erstelltAm: now,
  }
  await fuehreOpsAus([alsOp('create', 'artikel', payload)], auth)
  await setzeStandardMindestbestand(payload.id, input.mindestbestand, auth)
  return getArtikel(payload.id)
}

export async function updateArtikel(
  id: string,
  patch: ArtikelPatch,
  auth: ApiAuthContext,
): Promise<ArtikelDetail> {
  const db = getDb()
  const rows = await db.select().from(artikel).where(eq(artikel.id, id)).limit(1)
  const row = rows[0]
  if (!row) throw new ApiV1Error(404, 'NOT_FOUND', `Artikel ${id} nicht gefunden`)
  const payload = {
    ...artikelPayload(row),
    ...patch,
    geaendertAm: new Date().toISOString(),
  }
  await fuehreOpsAus([alsOp('update', 'artikel', payload)], auth)
  await setzeStandardMindestbestand(id, patch.mindestbestand, auth)
  return getArtikel(id)
}

export async function deleteArtikel(id: string, auth: ApiAuthContext): Promise<void> {
  const db = getDb()
  const rows = await db.select({ id: artikel.id }).from(artikel).where(eq(artikel.id, id)).limit(1)
  if (rows.length === 0) throw new ApiV1Error(404, 'NOT_FOUND', `Artikel ${id} nicht gefunden`)
  await fuehreOpsAus([alsOp('delete', 'artikel', { id })], auth)
}

// ---------- Standorte ----------

export interface StandortDto {
  id: string
  name: string
  typ: string
  projekt: string | null
  kennzeichen: string | null
  standard: boolean
  archiviert: boolean
  geaendertAm: string
  erstelltAm: string
}

function standortDto(row: typeof standorte.$inferSelect): StandortDto {
  return {
    id: row.id,
    name: row.name,
    typ: row.typ,
    projekt: row.projekt,
    kennzeichen: row.kennzeichen,
    standard: row.standard,
    archiviert: row.archiviert,
    geaendertAm: isoRequired(row.geaendertAm),
    erstelltAm: isoRequired(row.erstelltAm),
  }
}

function standortPayload(row: typeof standorte.$inferSelect): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    typ: row.typ,
    projekt: row.projekt,
    kennzeichen: row.kennzeichen,
    standard: row.standard,
    archiviert: row.archiviert,
    geaendertAm: isoRequired(row.geaendertAm),
    erstelltAm: isoRequired(row.erstelltAm),
  }
}

export async function listeStandorte(includeArchived = false): Promise<StandortDto[]> {
  const db = getDb()
  const rows = await db
    .select()
    .from(standorte)
    .where(includeArchived ? undefined : eq(standorte.archiviert, false))
    .orderBy(asc(standorte.name))
  return rows.map(standortDto)
}

export async function createStandort(
  input: StandortInput,
  auth: ApiAuthContext,
): Promise<StandortDto> {
  const now = new Date().toISOString()
  const payload = {
    id: input.id ?? crypto.randomUUID(),
    name: input.name,
    typ: input.typ,
    projekt: input.projekt ?? null,
    kennzeichen: input.kennzeichen ?? null,
    standard: input.standard,
    archiviert: input.archiviert,
    geaendertAm: now,
    erstelltAm: now,
  }
  await fuehreOpsAus([alsOp('create', 'standort', payload)], auth)
  const rows = await getDb()
    .select()
    .from(standorte)
    .where(eq(standorte.id, payload.id))
    .limit(1)
  return standortDto(rows[0]!)
}

export async function updateStandort(
  id: string,
  patch: StandortPatch,
  auth: ApiAuthContext,
): Promise<StandortDto> {
  const db = getDb()
  const rows = await db.select().from(standorte).where(eq(standorte.id, id)).limit(1)
  const row = rows[0]
  if (!row) throw new ApiV1Error(404, 'NOT_FOUND', `Standort ${id} nicht gefunden`)
  const payload = {
    ...standortPayload(row),
    ...patch,
    geaendertAm: new Date().toISOString(),
  }
  await fuehreOpsAus([alsOp('update', 'standort', payload)], auth)
  const next = await db.select().from(standorte).where(eq(standorte.id, id)).limit(1)
  return standortDto(next[0]!)
}

// ---------- Bestand ----------

export async function getBestand(
  artikelId: string,
  standortId?: string,
): Promise<{
  artikelId: string
  standortId: string | null
  menge: number
  proStandort: Array<{ standortId: string; standortName: string; menge: number }>
}> {
  const db = getDb()
  const artikelRows = await db
    .select({ id: artikel.id, titel: artikel.titel })
    .from(artikel)
    .where(eq(artikel.id, artikelId))
    .limit(1)
  if (artikelRows.length === 0) {
    throw new ApiV1Error(404, 'NOT_FOUND', `Artikel ${artikelId} nicht gefunden`)
  }
  if (standortId) {
    const menge = await berechneBestand(db, artikelId, standortId)
    return { artikelId, standortId, menge, proStandort: [] }
  }
  const bestaende = await berechneBestaendeProArtikel(db, artikelId)
  const standortRows = await db.select().from(standorte)
  const namen = new Map(standortRows.map((s) => [s.id, s.name]))
  const proStandort = bestaende.map((b) => ({
    standortId: b.standortId,
    standortName: namen.get(b.standortId) ?? b.standortId,
    menge: b.menge,
  }))
  return {
    artikelId,
    standortId: null,
    menge: proStandort.reduce((sum, b) => sum + b.menge, 0),
    proStandort,
  }
}

// ---------- Buchungen ----------

export interface BuchungDto {
  id: string
  artikelId: string
  standortId: string
  standortZielId: string | null
  typ: string
  menge: number
  paarId: string | null
  projekt: string | null
  erstelltAm: string
  clientEingabeAm: string | null
  erstelltVon: string
  kommentar: string | null
  mitteilungAn: string | null
  stornoVon: string | null
  storno: boolean
  storniertDurch: string | null
}

function buchungDto(row: typeof buchungen.$inferSelect): BuchungDto {
  return {
    id: row.id,
    artikelId: row.artikelId,
    standortId: row.standortId,
    standortZielId: row.standortZielId,
    typ: row.typ,
    menge: row.menge,
    paarId: row.paarId,
    projekt: row.projekt,
    erstelltAm: isoRequired(row.erstelltAm),
    clientEingabeAm: isoOf(row.clientEingabeAm),
    erstelltVon: row.erstelltVon,
    kommentar: row.kommentar,
    mitteilungAn: row.mitteilungAn,
    stornoVon: row.stornoVon,
    storno: row.storno,
    storniertDurch: row.storniertDurch,
  }
}

export interface BuchungListeParams {
  artikelId?: string
  standortId?: string
  typ?: string
  von?: string
  bis?: string
  nurAktive?: boolean
  limit: number
  offset: number
}

export async function listeBuchungen(params: BuchungListeParams): Promise<{
  items: BuchungDto[]
  total: number
  limit: number
  offset: number
}> {
  const db = getDb()
  const conditions: SQL[] = []
  if (params.artikelId) conditions.push(eq(buchungen.artikelId, params.artikelId))
  if (params.standortId) conditions.push(eq(buchungen.standortId, params.standortId))
  if (params.typ) conditions.push(eq(buchungen.typ, params.typ as never))
  if (params.von) conditions.push(gte(buchungen.erstelltAm, new Date(params.von)))
  if (params.bis) conditions.push(lte(buchungen.erstelltAm, new Date(params.bis)))
  if (params.nurAktive === true) conditions.push(eq(buchungen.storno, false))
  const where = conditions.length > 0 ? and(...conditions) : undefined

  const [rows, countRows] = await Promise.all([
    db
      .select()
      .from(buchungen)
      .where(where)
      .orderBy(desc(buchungen.erstelltAm))
      .limit(params.limit)
      .offset(params.offset),
    db.select({ c: sql<number>`count(*)::int` }).from(buchungen).where(where),
  ])
  return {
    items: rows.map(buchungDto),
    total: countRows[0]?.c ?? 0,
    limit: params.limit,
    offset: params.offset,
  }
}

function buchungBasis(
  input: BuchungCreateInput,
  auth: ApiAuthContext,
  now: string,
): Omit<BuchungPayload, 'typ' | 'menge' | 'standortId'> {
  return {
    id: input.id ?? crypto.randomUUID(),
    artikelId: input.artikelId,
    erstelltAm: input.erstelltAm ?? now,
    clientEingabeAm: input.clientEingabeAm ?? now,
    erstelltVon: auth.userId,
    kommentar: input.kommentar ?? null,
    mitteilungAn: input.mitteilungAn ?? null,
    projekt: input.projekt ?? null,
    storno: false,
    stornoVon: null,
    storniertDurch: null,
  }
}

export async function erstelleBuchung(
  input: BuchungCreateInput,
  auth: ApiAuthContext,
  gateway?: NotificationGateway,
): Promise<{ buchungen: BuchungDto[]; differenz?: number; bestandVorher?: number }> {
  const db = getDb()
  const now = new Date().toISOString()

  if (input.typ === 'inventur') {
    // Bestand und Differenz muessen in derselben Transaktion gelesen und
    // geschrieben werden. Deshalb nutzen wir hier den exportierten
    // Resolver-Baustein statt des generischen Push-Pfads.
    let event: MindestbestandEreignisRow | null = null
    let differenz = 0
    let bestandVorher = 0
    let payloadId = input.id ?? ''
    await db.transaction(async (tx) => {
      bestandVorher = await berechneBestand(tx, input.artikelId, input.standortId)
      differenz = input.sollMenge - bestandVorher
      const payload: BuchungPayload = {
        ...buchungBasis(input, auth, now),
        standortId: input.standortId,
        standortZielId: null,
        typ: 'inventur',
        menge: differenz,
        paarId: null,
      }
      payloadId = payload.id
      event = await resolveBuchungCreate(tx, payload, tx)
      await tx.insert(auditLog).values({
        id: crypto.randomUUID(),
        aktion: 'create',
        entitaet: 'buchung',
        entitaetId: payload.id,
        benutzerId: auth.userId,
        daten: { op: 'create', entity: 'buchung', via: 'api', apiKeyId: auth.apiKeyId },
        zeit: new Date(),
      })
    })
    if (gateway && event !== null) {
      void gateway.dispatchMindestbestandEvent(event)
    }
    const rows = await db.select().from(buchungen).where(eq(buchungen.id, payloadId)).limit(1)
    return {
      buchungen: rows.map(buchungDto),
      differenz,
      bestandVorher,
    }
  }

  if (input.typ === 'umlagerung') {
    if (input.vonStandortId === input.nachStandortId) {
      throw new ApiV1Error(400, 'GLEICHER_STANDORT', 'Quell- und Zielstandort sind identisch')
    }
    const paarId = crypto.randomUUID()
    const quellId = input.id ?? crypto.randomUUID()
    const zielId = crypto.randomUUID()
    const basis = buchungBasis(input, auth, now)
    const quell: BuchungPayload = {
      ...basis,
      id: quellId,
      standortId: input.vonStandortId,
      standortZielId: input.nachStandortId,
      typ: 'umlagerung',
      menge: -input.menge,
      paarId,
    }
    const ziel: BuchungPayload = {
      ...quell,
      id: zielId,
      standortId: input.nachStandortId,
      menge: input.menge,
    }
    await fuehreOpsAus(
      [alsOp('create', 'buchung', quell), alsOp('create', 'buchung', ziel)],
      auth,
      gateway,
    )
    const rows = await db
      .select()
      .from(buchungen)
      .where(sql`${buchungen.paarId} = ${paarId}`)
      .orderBy(asc(buchungen.erstelltAm))
    return { buchungen: rows.map(buchungDto) }
  }

  const basis = buchungBasis(input, auth, now)
  const sign = input.typ === 'entnahme' ? -1 : 1
  const payload: BuchungPayload = {
    ...basis,
    standortId: input.standortId,
    standortZielId: null,
    typ: input.typ,
    menge: sign * input.menge,
    paarId: null,
  }
  await fuehreOpsAus([alsOp('create', 'buchung', payload)], auth, gateway)
  const rows = await db.select().from(buchungen).where(eq(buchungen.id, payload.id)).limit(1)
  return { buchungen: rows.map(buchungDto) }
}

export async function storniereBuchung(
  id: string,
  grund: string,
  auth: ApiAuthContext,
  gateway?: NotificationGateway,
): Promise<{ storno: BuchungDto | null; original: BuchungDto; bereitsStorniert: boolean }> {
  const db = getDb()
  const rows = await db.select().from(buchungen).where(eq(buchungen.id, id)).limit(1)
  const original = rows[0]
  if (!original) throw new ApiV1Error(404, 'NOT_FOUND', `Buchung ${id} nicht gefunden`)
  if (original.storno) {
    return { storno: null, original: buchungDto(original), bereitsStorniert: true }
  }
  const now = new Date().toISOString()
  const stornoPayload: BuchungPayload = {
    id: crypto.randomUUID(),
    artikelId: original.artikelId,
    standortId: original.standortId,
    standortZielId: original.standortZielId,
    typ: 'storno',
    menge: -original.menge,
    paarId: null,
    projekt: null,
    erstelltAm: now,
    clientEingabeAm: now,
    erstelltVon: auth.userId,
    kommentar: grund,
    mitteilungAn: null,
    stornoVon: original.id,
    storno: true,
    storniertDurch: null,
  }
  await fuehreOpsAus([alsOp('create', 'buchung', stornoPayload)], auth, gateway)
  const fresh = await db
    .select()
    .from(buchungen)
    .where(eq(buchungen.id, original.id))
    .limit(1)
  const stornoRows = await db
    .select()
    .from(buchungen)
    .where(eq(buchungen.id, stornoPayload.id))
    .limit(1)
  return {
    storno: stornoRows[0] ? buchungDto(stornoRows[0]) : null,
    original: buchungDto(fresh[0] ?? original),
    bereitsStorniert: false,
  }
}

export async function kommissioniereBuchung(
  id: string,
  neuesProjekt: string,
  kommentar: string | null,
  auth: ApiAuthContext,
  gateway?: NotificationGateway,
): Promise<{ storno: BuchungDto; neubuchung: BuchungDto }> {
  const db = getDb()
  const rows = await db.select().from(buchungen).where(eq(buchungen.id, id)).limit(1)
  const original = rows[0]
  if (!original) throw new ApiV1Error(404, 'NOT_FOUND', `Buchung ${id} nicht gefunden`)
  if (original.storno) {
    throw new ApiV1Error(409, 'BEREITS_STORNIED', `Buchung ${id} ist bereits storniert`)
  }
  if (original.typ === 'storno' || original.typ === 'kommission') {
    throw new ApiV1Error(400, 'VALIDATION', 'Buchung ist kein umbuchbares Original')
  }
  const now = new Date().toISOString()
  const storno: BuchungPayload = {
    id: crypto.randomUUID(),
    artikelId: original.artikelId,
    standortId: original.standortId,
    standortZielId: original.standortZielId,
    typ: 'storno',
    menge: -original.menge,
    paarId: null,
    projekt: null,
    erstelltAm: now,
    clientEingabeAm: now,
    erstelltVon: auth.userId,
    kommentar: kommentar ?? 'Kommission via Agenten-API',
    mitteilungAn: null,
    stornoVon: original.id,
    storno: true,
    storniertDurch: null,
  }
  const neubuchung: BuchungPayload = {
    ...storno,
    id: crypto.randomUUID(),
    typ: 'kommission',
    menge: original.menge,
    projekt: neuesProjekt,
    stornoVon: null,
    storno: false,
  }
  await fuehreOpsAus(
    [alsOp('create', 'buchung', storno), alsOp('create', 'buchung', neubuchung)],
    auth,
    gateway,
  )
  const fresh = await db
    .select()
    .from(buchungen)
    .where(inArray(buchungen.id, [storno.id, neubuchung.id]))
  const byId = new Map(fresh.map((r) => [r.id, r]))
  return {
    storno: buchungDto(byId.get(storno.id)!),
    neubuchung: buchungDto(byId.get(neubuchung.id)!),
  }
}

// ---------- Kommissionen ----------

export interface KommissionDto {
  id: string
  nummer: string
  name: string | null
  archiviert: boolean
  geaendertAm: string
  erstelltAm: string
}

export async function listeKommissionen(): Promise<KommissionDto[]> {
  const db = getDb()
  const rows = await db.select().from(projekte).orderBy(asc(projekte.nummer))
  return rows.map((row) => ({
    id: row.id,
    nummer: row.nummer,
    name: row.name,
    archiviert: row.archiviert,
    geaendertAm: isoRequired(row.geaendertAm),
    erstelltAm: isoRequired(row.erstelltAm),
  }))
}

// ---------- Mindestbestand ----------

export interface MindestbestandDto {
  id: string
  artikelId: string
  artikelTitel: string
  standortId: string
  standortName: string
  ausloeserBuchungId: string
  bestandDanach: number
  mindestbestand: number
  defizit: number
  erstelltAm: string
}

export interface MindestbestandParams {
  artikelId?: string
  standortId?: string
  seit?: string
  limit: number
  offset: number
}

export async function listeMindestbestand(params: MindestbestandParams): Promise<{
  items: MindestbestandDto[]
  total: number
  limit: number
  offset: number
}> {
  const db = getDb()
  const conditions: SQL[] = []
  if (params.artikelId) {
    conditions.push(eq(mindestbestandEreignisse.artikelId, params.artikelId))
  }
  if (params.standortId) {
    conditions.push(eq(mindestbestandEreignisse.standortId, params.standortId))
  }
  if (params.seit) {
    conditions.push(gte(mindestbestandEreignisse.erstelltAm, new Date(params.seit)))
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined

  const [rows, countRows] = await Promise.all([
    db
      .select({
        event: mindestbestandEreignisse,
        artikelTitel: artikel.titel,
        standortName: standorte.name,
      })
      .from(mindestbestandEreignisse)
      .innerJoin(artikel, eq(artikel.id, mindestbestandEreignisse.artikelId))
      .innerJoin(standorte, eq(standorte.id, mindestbestandEreignisse.standortId))
      .where(where)
      .orderBy(desc(mindestbestandEreignisse.erstelltAm))
      .limit(params.limit)
      .offset(params.offset),
    db
      .select({ c: sql<number>`count(*)::int` })
      .from(mindestbestandEreignisse)
      .where(where),
  ])

  return {
    items: rows.map(({ event, artikelTitel, standortName }) => ({
      id: event.id,
      artikelId: event.artikelId,
      artikelTitel,
      standortId: event.standortId,
      standortName,
      ausloeserBuchungId: event.ausloeserBuchungId,
      bestandDanach: event.bestandDanach,
      mindestbestand: event.mindestbestand,
      defizit: event.defizit,
      erstelltAm: isoRequired(event.erstelltAm),
    })),
    total: countRows[0]?.c ?? 0,
    limit: params.limit,
    offset: params.offset,
  }
}

// ---------- Audit ----------

export interface AuditParams {
  entitaet?: string
  entitaetId?: string
  von?: string
  bis?: string
  limit: number
  offset: number
}

export async function listeAudit(params: AuditParams): Promise<{
  items: Array<{
    id: string
    aktion: string
    entitaet: string
    entitaetId: string
    benutzerId: string | null
    daten: unknown
    zeit: string
  }>
  total: number
  limit: number
  offset: number
}> {
  const db = getDb()
  const conditions: SQL[] = []
  if (params.entitaet) conditions.push(eq(auditLog.entitaet, params.entitaet as never))
  if (params.entitaetId) conditions.push(eq(auditLog.entitaetId, params.entitaetId))
  if (params.von) conditions.push(gte(auditLog.zeit, new Date(params.von)))
  if (params.bis) conditions.push(lte(auditLog.zeit, new Date(params.bis)))
  const where = conditions.length > 0 ? and(...conditions) : undefined

  const [rows, countRows] = await Promise.all([
    db
      .select()
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.zeit))
      .limit(params.limit)
      .offset(params.offset),
    db.select({ c: sql<number>`count(*)::int` }).from(auditLog).where(where),
  ])
  return {
    items: rows.map((row) => ({
      id: row.id,
      aktion: row.aktion,
      entitaet: row.entitaet,
      entitaetId: row.entitaetId,
      benutzerId: row.benutzerId,
      daten: row.daten,
      zeit: isoRequired(row.zeit),
    })),
    total: countRows[0]?.c ?? 0,
    limit: params.limit,
    offset: params.offset,
  }
}

// ---------- Meta / Status ----------

export async function getApiMeta(): Promise<Record<string, unknown>> {
  return {
    apiVersion: 'v1',
    serverTime: new Date().toISOString(),
    docsUrl: '/api/docs',
    openapiUrl: '/api/docs/json',
    mcp: {
      enabled: config.MCP_ENABLED,
      path: config.MCP_PATH,
      transport: 'streamable-http',
    },
    auth: {
      type: 'api-key',
      headers: ['Authorization: Bearer <key>', 'X-API-Key: <key>'],
      scopes: ['read', 'write', 'admin'],
    },
    units: {
      menge: 'Ganzzahl in Stück',
      listenpreis: 'Ganzzahl in Cent',
      zeit: 'ISO-8601 UTC',
      ids: 'UUID',
    },
    limits: {
      maxPageSize: 200,
      rateLimitPerMinute: config.RATE_LIMIT_API_MAX,
    },
    errorCodes: [
      'VALIDATION',
      'UNAUTHORIZED',
      'FORBIDDEN',
      'NOT_FOUND',
      'CONFLICT',
      'NEGATIVE_BESTAND',
      'UNKNOWN_REFERENCE',
      'HAS_DEPENDENCIES',
      'RATE_LIMITED',
      'INTERNAL',
    ],
  }
}

export async function getStatus(): Promise<{
  serverTime: string
  counts: Record<string, number>
}> {
  const db = getDb()
  const [a, s, p, b, m, mw] = await Promise.all([
    db.select({ c: sql<number>`count(*)::int` }).from(artikel),
    db.select({ c: sql<number>`count(*)::int` }).from(standorte),
    db.select({ c: sql<number>`count(*)::int` }).from(projekte),
    db.select({ c: sql<number>`count(*)::int` }).from(buchungen),
    db.select({ c: sql<number>`count(*)::int` }).from(mindestbestandEreignisse),
    db.select({ c: sql<number>`count(*)::int` }).from(artikelStandortMindestbestaende),
  ])
  return {
    serverTime: new Date().toISOString(),
    counts: {
      artikel: a[0]?.c ?? 0,
      standorte: s[0]?.c ?? 0,
      commission: p[0]?.c ?? 0,
      buchungen: b[0]?.c ?? 0,
      mindestbestandEreignisse: m[0]?.c ?? 0,
      artikelStandortMindestbestand: mw[0]?.c ?? 0,
    },
  }
}
