// Sync-Resolver: verarbeitet eine Liste von Outbox-Items.
//
// Strategie:
//   * Buchungen sind append-only — keine Konflikte. Wir prüfen Negativ-Bestand
//     (für 'entnahme' UND 'umlagerung') und unbekannte Referenzen.
//     Storno ist idempotent: zweimal inserten derselben Storno-Buchung ist
//     No-Op; ein zweiter Storno aufs gleiche Original wird ebenfalls
//     geschluckt.
//   * Umlagerungen werden atomar gepusht: beide Hälften mit gleicher
//     paarId werden in EINER DB-Transaktion angelegt. Fehlt die Hälfte,
//     schlägt der Push fehl und der Client pusht beim nächsten Tick
//     erneut.
//   * Artikel/Standort/Projekte: Last-Writer-Wins auf `geaendertAm`.
//     Wenn die Server-Version neuer ist als die eingehende, wird die Server-
//     Version beibehalten (Conflict-Response).
//
// Alles in einer DB-Transaktion pro Push-Batch.

import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from '../db/schema.js'
import { artikel, buchungen, einstellungen, projekte, standorte, auditLog } from '../db/schema.js'
import { berechneBestand } from '../domain/bestand.js'
import {
  NegativerBestandError,
  UnbekannteReferenzError,
  ValidationError,
} from '../domain/errors.js'
import { applyLastWriterWinsMock } from './__test-helpers__.js'

// ---------- Push-Payload-Type (siehe validierung.ts) ----------

export type PushOp = z.infer<typeof pushSchema>

// Schema nur für den Resolver (leichtgewichtige Variante)
const pushSchema = z.discriminatedUnion('entity', [
  z.object({
    op: z.enum(['create', 'update', 'delete']),
    entity: z.literal('artikel'),
    payload: z.any(),
  }),
  z.object({
    op: z.enum(['create', 'update', 'delete']),
    entity: z.literal('standort'),
    payload: z.any(),
  }),
  z.object({
    op: z.enum(['create', 'update', 'delete']),
    entity: z.literal('projekt'),
    payload: z.any(),
  }),
  z.object({
    op: z.literal('create'),
    entity: z.literal('buchung'),
    payload: z.any(),
  }),
  z.object({
    op: z.literal('upsert'),
    entity: z.literal('einstellung'),
    payload: z.any(),
  }),
])

export interface ResolverResult {
  accepted: string[] // op-IDs (payload.id)
  conflicts: Array<{
    id: string
    reason: string
  }>
  errors: Array<{
    id: string
    code: string
    message: string
    currentBestand?: number
    /** Server-seitiger Stack, nur bei code === 'INTERNAL'. PWA zeigt ihn
     *  in der Diagnose an — ohne Stack sind solche Fehler nicht debuggbar. */
    stack?: string
    /** Das eingegangene Payload (saniert, ohne user-spezifische Secrets),
     *  nur bei code === 'INTERNAL'. Hilft zu sehen, WAS der Client geschickt
     *  hat, als der Server ausgestiegen ist. */
    payload?: unknown
  }>
}

export async function resolvePush(
  db: PostgresJsDatabase<typeof schema>,
  ops: ReadonlyArray<PushOp>,
  benutzerId: string,
  benutzerRolle: 'admin' | 'user' = 'user',
): Promise<ResolverResult> {
  const result: ResolverResult = { accepted: [], conflicts: [], errors: [] }

  // Phase 1: Umlagerungs-Paare (gleiche paarId) atomar in EINER Transaktion.
  // Einzelne Hälften werden als Conflict markiert (Retry beim nächsten
  // Sync, wenn die andere Hälfte angekommen ist).
  const paarBuckets = new Map<string, Array<Extract<PushOp, { entity: 'buchung' }>>>()
  const seenIndices = new Set<number>()
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]
    if (
      op &&
      op.entity === 'buchung' &&
      (op.payload as { typ?: unknown }).typ === 'umlagerung' &&
      typeof (op.payload as { paarId?: unknown }).paarId === 'string'
    ) {
      const b = op as Extract<PushOp, { entity: 'buchung' }>
      const list = paarBuckets.get(b.payload.paarId as string) ?? []
      list.push(b)
      paarBuckets.set(b.payload.paarId as string, list)
      seenIndices.add(i)
    }
  }
  for (const [paarId, list] of paarBuckets) {
    if (list.length === 1) {
      list[0]?.payload.id !== undefined &&
        result.conflicts.push({
          id: list[0].payload.id,
          reason: `Umlagerungspartner mit paarId ${paarId} fehlt — erneuter Sync erforderlich`,
        })
    } else {
      try {
        await resolveUmlagerungPaar(db, list)
        for (const op of list) result.accepted.push(op.payload.id)
      } catch (err) {
        for (const op of list) pushBuchungsError(result, op.payload.id, err, op)
      }
    }
  }

  // Phase 2: Restliche ops sequenziell.
  for (let i = 0; i < ops.length; i++) {
    if (seenIndices.has(i)) continue
    const op = ops[i]!
    try {
      await db.transaction(async (tx) => {
        switch (op.entity) {
          case 'artikel':
            await resolveArtikel(tx, op)
            break
          case 'standort':
            await resolveStandort(tx, op)
            break
          case 'projekt':
            await resolveProjekt(tx, op)
            break
          case 'buchung':
            await resolveBuchung(tx, op, db)
            break
          case 'einstellung':
            await resolveEinstellung(tx, op, benutzerId, benutzerRolle)
            break
        }

        const entitaetId = entitaetIdFor(op)
        await tx.insert(auditLog).values({
          id: crypto.randomUUID(),
          aktion: op.op,
          entitaet: op.entity,
          entitaetId,
          benutzerId,
          daten: { op: op.op, entity: op.entity },
          zeit: new Date(),
        })

        result.accepted.push(entitaetId)
      })
    } catch (err) {
      // Fehler-ID muss mit dem IDENTIFIERS übereinstimmen, den der Client
      // zum Matchen benutzt (Stammdaten: `payload.id`, Einstellungen:
      // `key#userId`). Vorher war das hart `op.payload.id`, was bei
      // Einstellungen `undefined` ergab — der Client hätte den Fehler
      // dann nicht dem Outbox-Item zuordnen können und es endlos neu
      // gepusht bis zur Quarantäne.
      pushBuchungsError(result, entitaetIdFor(op), err, op)
    }
  }

  return result
}

/**
 * Liefert die ID, unter der der Client dieses Op in `result.accepted` /
 * `result.errors` / `result.conflicts` wiederfindet. Spiegel der
 * `payloadIdFor`-Logik im Worker.
 */
function entitaetIdFor(op: PushOp): string {
  if (op.entity === 'einstellung') {
    const p = op.payload as { key?: unknown; userId?: unknown }
    const userPart = p.userId === null || p.userId === undefined ? 'global' : p.userId
    return `${String(p.key)}#${String(userPart)}`
  }
  return (op.payload as { id: string }).id
}

/**
 * Klassifiziert einen Resolver-Wurf und ordnet ihn der passenden
 * `ResolverResult`-Liste zu.
 */
/**
 * Klassifiziert einen Resolver-Wurf und ordnet ihn der passenden
 * `ResolverResult`-Liste zu. Bei unerwarteten Fehlern reichern wir die
 * Antwort um Stack + Payload an, damit die PWA-Diagnose den Bug
 * sichtbar macht (sonst steht dort nur eine kryptische `message`,
 * mit der niemand etwas anfangen kann).
 */
function pushBuchungsError(
  result: ResolverResult,
  id: string,
  err: unknown,
  op?: PushOp,
): void {
  if (err instanceof ConflictError) {
    result.conflicts.push({ id, reason: err.message })
  } else if (err instanceof NegativerBestandError) {
    result.errors.push({
      id,
      code: err.code,
      message: err.message,
      currentBestand: err.aktuellerBestand,
    })
  } else if (err instanceof UnbekannteReferenzError || err instanceof ValidationError) {
    result.errors.push({
      id,
      code: err.code,
      message: err.message,
    })
  } else {
    // Unerwarteter Fehler: voll diagnostizieren. Wir loggen den Fehler
    // außerdem serverseitig mit Stack — falls die PWA-Diagnose leer ist,
    // weil z. B. der Fehler beim JSON-Serialisieren passiert, hilft das
    // Container-Log beim Eingrenzen.
    const message = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? err.stack : undefined
    // eslint-disable-next-line no-console
    console.error('[sync/push] INTERNAL', {
      id,
      entity: op?.entity,
      op: op?.op,
      message,
      stack,
    })
    result.errors.push({
      id,
      code: 'INTERNAL',
      message,
      stack,
      payload: op?.payload,
    })
  }
}

// ---------- Conflict ----------

export class ConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConflictError'
  }
}

// ---------- Stammdaten-Resolver ----------

type Tx = Parameters<Parameters<PostgresJsDatabase<typeof schema>['transaction']>[0]>[0]

async function resolveArtikel(
  tx: Tx,
  op: Extract<PushOp, { entity: 'artikel' }>,
): Promise<void> {
  if (op.op === 'create') {
    const existing = await tx.select().from(artikel).where(eq(artikel.id, op.payload.id)).limit(1)
    if (existing.length > 0) {
      // Idempotent: bereits vorhanden, einfach akzeptieren (Update-Fall)
      await applyLastWriterWins(tx, artikel, op.payload)
    } else {
      await tx.insert(artikel).values(normalizeStammdatenTimestamps(op.payload) as never)
    }
  } else if (op.op === 'update' || op.op === 'delete') {
    await applyLastWriterWins(tx, artikel, op.payload)
  }
}

async function resolveStandort(
  tx: Tx,
  op: Extract<PushOp, { entity: 'standort' }>,
): Promise<void> {
  if (op.op === 'create') {
    const existing = await tx.select().from(standorte).where(eq(standorte.id, op.payload.id)).limit(1)
    if (existing.length > 0) {
      await applyLastWriterWins(tx, standorte, op.payload)
    } else {
      await tx.insert(standorte).values(normalizeStammdatenTimestamps(op.payload) as never)
    }
  } else {
    await applyLastWriterWins(tx, standorte, op.payload)
  }
}

async function resolveProjekt(
  tx: Tx,
  op: Extract<PushOp, { entity: 'projekt' }>,
): Promise<void> {
  if (op.op === 'create') {
    const existing = await tx.select().from(projekte).where(eq(projekte.id, op.payload.id)).limit(1)
    if (existing.length > 0) {
      await applyLastWriterWins(tx, projekte, op.payload)
    } else {
      await tx.insert(projekte).values(normalizeStammdatenTimestamps(op.payload) as never)
    }
  } else {
    await applyLastWriterWins(tx, projekte, op.payload)
  }
}

// ---------- Last-Writer-Wins ----------

async function applyLastWriterWins(
  tx: Tx,
  table: typeof artikel | typeof standorte | typeof projekte,
  payload: Record<string, unknown>,
): Promise<void> {
  const id = payload['id'] as string
  const incomingGeaendertAm = toDateOrThrow(payload['geaendertAm'])

  const existing = await tx.select().from(table).where(eq(table.id, id)).limit(1)
  const current = existing[0]
  if (!current) {
    // Server hat es nicht (kann bei create passieren, wenn race-condition) — insert
    await tx.insert(table).values(normalizeStammdatenTimestamps(payload) as never)
    return
  }
  // Drizzle's postgres-js-Driver liefert `timestamp with timezone` als ISO-String,
  // nicht als Date. Wir normalisieren auf Date, weil der Test-Helper (und jede
  // andere Logik) `.toISOString()` darauf aufruft.
  const serverGeaendertAm = toDateOrThrow(current.geaendertAm)
  // Reine Logik in Test-Helper extrahiert
  applyLastWriterWinsMock({
    serverGeaendertAm,
    incomingGeaendertAm,
    id,
  })
  await tx.update(table).set(normalizeStammdatenTimestamps(payload) as never).where(eq(table.id, id))
}

/**
 * Konvertiert Timestamp-Felder im Push-Payload von ISO-Strings auf
 * `Date`-Instanzen. Drizzle's `PgTimestamp.mapToDriverValue` ruft
 * naemlich `value.toISOString()` auf den Wert, der an `insert()`/
 * `update()` uebergeben wird — Strings haben diese Methode nicht und
 * der Push bricht mit `value.toISOString is not a function` ab. Die PWA
 * schickt timestamps als ISO-Strings (per zod-Schema validiert, nicht
 * transformiert), also muessen wir die Konvertierung hier serverseitig
 * machen. Werte, die bereits `Date` sind, bleiben unveraendert.
 *
 * `keys` ist die Liste der Timestamp-Felder, die konvertiert werden
 * sollen. Unterschiedliche Entitaeten haben unterschiedliche Felder:
 * - Stammdaten (artikel/standort/projekt): `geaendertAm`, `erstelltAm`
 * - Buchungen: `erstelltAm`, `clientEingabeAm`
 */
function normalizeTimestampFields(
  payload: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...payload }
  for (const key of keys) {
    const v = out[key]
    if (typeof v === 'string') {
      out[key] = toDateOrThrow(v)
    }
  }
  return out
}

/**
 * Stammdaten-spezifischer Wrapper. Nur hier, damit der Aufruf-Code
 * sprechend benannt ist (Stammdaten vs. Buchungen) — Logik liegt in
 * `normalizeTimestampFields`.
 */
function normalizeStammdatenTimestamps(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return normalizeTimestampFields(payload, ['geaendertAm', 'erstelltAm'])
}

/**
 * Buchungs-spezifischer Wrapper. Buchungen haben `erstelltAm` (Server-
 * Spaltenname) und `clientEingabeAm` (optional, UI-Erfassungszeit).
 * Beide muessen als `Date` an Drizzle uebergeben werden, sonst knallt
 * `mapToDriverValue` mit `value.toISOString is not a function`. Vorher
 * wurde das Feld nicht normalisiert — Bug, der jetzt symmetrisch zu
 * Stammdaten behoben ist.
 */
function normalizeBuchungTimestamps(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return normalizeTimestampFields(payload, ['erstelltAm', 'clientEingabeAm'])
}

/**
 * Normalisiert einen Drizzle-Timestamp-Wert auf `Date`. Akzeptiert Date,
 * ISO-String oder numerische Epochen-Millisekunden. Wirft, wenn keines davon
 * vorliegt, weil ein nicht-erkannter Timestamp ein Bug wäre, den wir nicht
 * stillschweigend uebergehen wollen.
 */
function toDateOrThrow(v: unknown): Date {
  if (v instanceof Date) return v
  if (typeof v === 'string') {
    const d = new Date(v)
    if (!Number.isNaN(d.getTime())) return d
  }
  if (typeof v === 'number') {
    const d = new Date(v)
    if (!Number.isNaN(d.getTime())) return d
  }
  throw new TypeError(
    `toDateOrThrow: nicht-erkannter Timestamp-Wert (${typeof v}): ${String(v)}`,
  )
}

// ---------- Buchungs-Resolver ----------

interface BuchungPayload {
  id: string
  artikelId: string
  standortId: string
  standortZielId?: string | null
  typ: 'einlagerung' | 'entnahme' | 'umlagerung' | 'inventur' | 'kommission' | 'storno'
  menge: number
  paarId?: string | null
  projekt?: string | null
  erstelltAm: string
  clientEingabeAm?: string | null
  erstelltVon: string
  kommentar?: string | null
  mitteilungAn?: string | null
  stornoVon?: string | null
  storno: boolean
  storniertDurch?: string | null
}

/**
 * Validiert und insertet eine einzelne Buchung in der laufenden
 * Transaktion. Wird sowohl von `resolveBuchung` (Einzelpush) als auch
 * von `resolveUmlagerungPaar` (atomic Paar-Push) aufgerufen — daher
 * die Trennung von Audit-Log.
 */
async function resolveBuchungCreate(
  tx: Tx,
  b: BuchungPayload,
  db: PostgresJsDatabase<typeof schema>,
): Promise<void> {
  // 1) Idempotenz: gleiche ID → 200 duplicate
  const existing = await tx.select().from(buchungen).where(eq(buchungen.id, b.id)).limit(1)
  if (existing.length > 0) return

  // 2) Storno-Idempotenz: zweimal dieselbe Buchung stornieren führt zu
  //    zwei verschiedenen Storno-IDs (verschiedene Outbox-Pushes). Wir
  //    lehnen den zweiten Storno ab, wenn das Original bereits
  //    `storno=true` ist — verhindert Doppel-Storno über parallele
  //    Clients. Wenn das Original noch nicht angekommen ist (race), wird
  //    der Storno vorgemerkt und landet beim Eintreffen des Originals.
  if (b.typ === 'storno' && b.stornoVon) {
    const origRows = await tx
      .select({ id: buchungen.id, storno: buchungen.storno })
      .from(buchungen)
      .where(eq(buchungen.id, b.stornoVon))
      .limit(1)
    if (origRows[0]?.storno === true) {
      return // doppelter Storno: idempotent no-op
    }
  }

  // 3) Referenz-Check
  const a = await tx.select({ id: artikel.id }).from(artikel).where(eq(artikel.id, b.artikelId)).limit(1)
  if (a.length === 0) throw new UnbekannteReferenzError('artikel', b.artikelId)
  const s = await tx
    .select({ id: standorte.id })
    .from(standorte)
    .where(eq(standorte.id, b.standortId))
    .limit(1)
  if (s.length === 0) throw new UnbekannteReferenzError('standort', b.standortId)
  if (b.standortZielId) {
    const s2 = await tx
      .select({ id: standorte.id })
      .from(standorte)
      .where(eq(standorte.id, b.standortZielId))
      .limit(1)
    if (s2.length === 0) throw new UnbekannteReferenzError('standort', b.standortZielId)
  }

  // 4) Negativ-Bestand-Check.
  //    Entnahme: klar.
  //    Umlagerung: trägt negative Menge am Quellstandort — wenn der
  //    Bestand dort negativ würde, ist die Umlagerung ungültig.
  if ((b.typ === 'entnahme' || b.typ === 'umlagerung') && !b.storno) {
    const aktuell = await berechneBestand(db, b.artikelId, b.standortId)
    const neuerBestand = aktuell - Math.abs(b.menge)
    if (neuerBestand < 0) {
      throw new NegativerBestandError(b.artikelId, b.standortId, aktuell, Math.abs(b.menge))
    }
  }

  // 5) Insert. Timestamp-Felder muessen als Date an Drizzle gehen (siehe
  //    normalizeBuchungTimestamps-Kommentar).
  await tx.insert(buchungen).values(normalizeBuchungTimestamps(b as unknown as Record<string, unknown>) as never)
}

async function resolveBuchung(
  tx: Tx,
  op: Extract<PushOp, { entity: 'buchung' }>,
  db: PostgresJsDatabase<typeof schema>,
): Promise<void> {
  if (op.op !== 'create') {
    throw new ValidationError('buchung.op', 'nur "create" erlaubt (append-only)')
  }
  await resolveBuchungCreate(tx, op.payload as BuchungPayload, db)
}

/**
 * Pusht ein Umlagerungs-Paar atomar in EINER DB-Transaktion. Beide
 * Hälften werden gemeinsam validiert und eingefügt — entweder beide
 * oder keine.
 */
async function resolveUmlagerungPaar(
  db: PostgresJsDatabase<typeof schema>,
  ops: ReadonlyArray<Extract<PushOp, { entity: 'buchung' }>>,
): Promise<void> {
  await db.transaction(async (tx) => {
    for (const op of ops) {
      await resolveBuchungCreate(tx, op.payload as BuchungPayload, tx as unknown as PostgresJsDatabase<typeof schema>)
    }
  })
}

// ---------- Einstellungs-Resolver ----------
// Whitelist der erlaubten Keys. artikelTypen ist global und nur von
// Admins pflegbar. sprache und standardStandortId sind pro User.
const ADMIN_ONLY_KEYS = new Set<string>(['artikelTypen'])

async function resolveEinstellung(
  tx: Tx,
  op: Extract<PushOp, { entity: 'einstellung' }>,
  benutzerId: string,
  benutzerRolle: 'admin' | 'user',
): Promise<void> {
  const p = op.payload as {
    key: string
    userId: string | null
    value: string
    geaendertAm: string
  }

  // 1) Rollen-Check: artikelTypen (global) nur durch Admins
  if (p.userId === null && ADMIN_ONLY_KEYS.has(p.key) && benutzerRolle !== 'admin') {
    throw new ValidationError(
      'einstellung.userId',
      `Key "${p.key}" ist global und darf nur von Admins geschrieben werden`,
    )
  }

  // 2) Wenn userId gesetzt: muss dem JWT-Sub entsprechen
  if (p.userId !== null && p.userId !== benutzerId) {
    throw new ValidationError(
      'einstellung.userId',
      'Eine fremde User-ID ist nicht erlaubt',
    )
  }

  // 3) LWW-Upsert auf (key, userId)
  const incomingGeaendertAm = new Date(p.geaendertAm)
  const where = and(
    eq(einstellungen.key, p.key),
    p.userId === null
      ? isNull(einstellungen.userId)
      : eq(einstellungen.userId, p.userId),
  )
  const existing = await tx.select().from(einstellungen).where(where).limit(1)
  if (existing.length === 0) {
    await tx.insert(einstellungen).values({
      key: p.key,
      userId: p.userId,
      value: p.value,
      geaendertAm: incomingGeaendertAm,
    })
    return
  }
  // Nur überschreiben, wenn die eingehende Version neuer ist.
  // Auch hier: Drizzle-string-vs-Date normalisieren.
  const existingRow = existing[0]
  if (!existingRow) return
  const existingGeaendertAm = toDateOrThrow(existingRow.geaendertAm)
  if (incomingGeaendertAm.getTime() <= existingGeaendertAm.getTime()) {
    return
  }
  await tx
    .update(einstellungen)
    .set({ value: p.value, geaendertAm: incomingGeaendertAm })
    .where(where)
}