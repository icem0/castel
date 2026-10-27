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

import { and, count, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from '../db/schema.js'
import {
  artikel,
  artikelStandortMindestbestaende,
  buchungen,
  einstellungen,
  hersteller,
  mindestbestandEreignisse,
  projekte,
  standorte,
  auditLog,
} from '../db/schema.js'
import { berechneBestand, type BestandQuerier } from '../domain/bestand.js'
import {
  HatAbhaengigkeitenError,
  NegativerBestandError,
  ProtectedStandortError,
  UnbekannteReferenzError,
  ValidationError,
} from '../domain/errors.js'
import {
  berechneDefizit,
  sollteWarnungAusloesen,
} from '../domain/mindestbestand.js'
import { applyLastWriterWinsMock } from './__test-helpers__.js'
import type { NotificationGateway } from '../services/notification-gateway.js'

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
    entity: z.literal('hersteller'),
    payload: z.any(),
  }),
  z.object({
    op: z.enum(['create', 'update', 'delete']),
    entity: z.literal('standort'),
    payload: z.any(),
  }),
  z.object({
    op: z.enum(['create', 'update', 'delete']),
    entity: z.literal('artikel_standort_mindestbestand'),
    payload: z.any(),
  }),
  z.object({
    op: z.enum(['create', 'update', 'delete']),
    entity: z.literal('kommission'),
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
  /** Ops that were valid but intentionally changed nothing (idempotent no-op). */
  skipped: Array<{
    id: string
    reason: string
  }>
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
  /**
   * Optionaler Notification-Gateway. Wird am Ende des Resolver-Laufs
   * mit allen ausgelösten Mindestbestand-Ereignissen gefüttert.
   * `undefined` ist erlaubt (Default in den meisten Tests): dann wird
   * nur die DB-Zeile geschrieben, der Gateway wird nicht aufgerufen.
   */
  gateway?: NotificationGateway,
): Promise<ResolverResult> {
  const result: ResolverResult = { accepted: [], skipped: [], conflicts: [], errors: [] }
  /** Sammelt alle in diesem Resolver-Lauf erzeugten Mindestbestand-
   *  Events. Wird am Ende an `gateway.dispatchMindestbestandEvent`
   *  durchgereicht (fire-and-forget, damit die Antwort-Latenz nicht
   *  von externem Versand abhängt). */
  const events: MindestbestandEreignisRow[] = []

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
        const paar = await resolveUmlagerungPaar(db, list)
        result.skipped.push(...paar.skipped)
        const skippedIds = new Set(paar.skipped.map((s) => s.id))
        for (const op of list) {
          if (!skippedIds.has(op.payload.id)) result.accepted.push(op.payload.id)
        }
        events.push(...paar.events)
      } catch (err) {
        for (const op of list) pushBuchungsError(result, op.payload.id, err, op)
      }
    }
  }

  // Phase 2: Restliche ops sequenziell. Hersteller zuerst, damit Artikel,
  // die im selben Batch auf einen neuen Hersteller verweisen, den
  // Fremdschluessel erfuellen koennen (der 500er-Batch kann die beiden
  // Ops sonst trennen). Innerhalb der Gruppen bleibt die Reihenfolge stabil.
  const restIndices: number[] = []
  for (let i = 0; i < ops.length; i++) {
    if (!seenIndices.has(i)) restIndices.push(i)
  }
  restIndices.sort((a, b) => {
    const pa = ops[a]!.entity === 'hersteller' ? 0 : 1
    const pb = ops[b]!.entity === 'hersteller' ? 0 : 1
    return pa - pb || a - b
  })
  for (const i of restIndices) {
    const op = ops[i]!
    try {
      let buchungsEvent: MindestbestandEreignisRow | null = null
      let skipReason: string | null = null
      await db.transaction(async (tx) => {
        switch (op.entity) {
          case 'artikel':
            await resolveArtikel(tx, op, benutzerRolle === 'admin')
            break
          case 'hersteller':
            await resolveHersteller(tx, op)
            break
          case 'standort':
            await resolveStandort(tx, op)
            break
          case 'artikel_standort_mindestbestand':
            await resolveArtikelStandortMindestbestand(tx, op)
            break
          case 'kommission':
            await resolveProjekt(tx, op)
            break
          case 'buchung':
            // IMPORTANT: the bestand read inside must run on `tx`, not on the
            // pool (`db`). The booking was just inserted in this transaction
            // and is invisible to any other pooled connection — reading via
            // `db` stored stale values (e.g. 0) in
            // `mindestbestand_ereignisse.bestand_danach`.
            buchungsEvent = await resolveBuchung(tx, op, tx, (reason) => {
              skipReason = reason
            })
            break
          case 'einstellung': {
            const applied = await resolveEinstellung(tx, op, benutzerId, benutzerRolle)
            if (!applied) skipReason = 'STALE_SETTING'
            break
          }
        }

        const entitaetId = entitaetIdFor(op)
        if (skipReason) {
          result.skipped.push({ id: entitaetId, reason: skipReason })
          return
        }
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
      if (buchungsEvent) events.push(buchungsEvent)
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

  // Notification-Gateway: am Ende alle gesammelten Events durchreichen.
  // Fire-and-forget — wenn der Gateway hängt oder fehlschlägt, darf der
  // Push-Response nicht blockiert werden. Fehler werden im Gateway selbst
  // geloggt (siehe `LogNotificationGateway`).
  if (gateway && events.length > 0) {
    void Promise.all(events.map((e) => gateway.dispatchMindestbestandEvent(e)))
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
  if (op.entity === 'artikel_standort_mindestbestand') {
    const p = op.payload as { artikelId?: unknown; standortId?: unknown }
    return `${String(p.artikelId)}#${String(p.standortId)}`
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
  } else if (
    err instanceof UnbekannteReferenzError ||
    err instanceof ValidationError ||
    err instanceof HatAbhaengigkeitenError ||
    err instanceof ProtectedStandortError
  ) {
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

/**
 * Pure-Funktion: prüft eine Liste von FK-Counts und wirft
 * `HatAbhaengigkeitenError`, wenn mindestens ein Eintrag > 0 ist.
 * Wird sowohl von `resolveArtikel` als auch `resolveStandort` benutzt,
 * um die Delete-Logik (vor und nach einem SELECT-Block) identisch zu
 * halten — und damit sie ohne DB in Unit-Tests prüfbar ist.
 */
export interface AbhaengigkeitCount {
  entity: string
  anzahl: number
}

export function assertKeineAbhaengigkeiten(
  resource: string,
  id: string,
  counts: ReadonlyArray<AbhaengigkeitCount>,
): void {
  const vorhandene = counts.filter((c) => c.anzahl > 0)
  if (vorhandene.length === 0) return
  throw new HatAbhaengigkeitenError(resource, id, vorhandene)
}

// ---------- Stammdaten-Resolver ----------

type Tx = Parameters<Parameters<PostgresJsDatabase<typeof schema>['transaction']>[0]>[0]

/**
 * Stellt sicher, dass die im Artikel referenzierte Hersteller-ID existiert.
 * Der Outbox-Batch kann Hersteller- und Artikel-Op trennen (500er-Grenze);
 * dann kaeme der Artikel zuerst an und der FK wuerde knallen. Der
 * Platzhalter traegt einen Epoch-Zeitstempel, damit der echte (neuere)
 * Hersteller-Push ihn per LWW spaeter ueberschreiben darf.
 */
async function stelleHerstellerReferenzSicher(
  tx: Tx,
  payload: Record<string, unknown>,
): Promise<void> {
  const herstellerId = payload['herstellerId']
  if (typeof herstellerId !== 'string' || herstellerId === '') return
  const existing = await tx
    .select({ id: hersteller.id })
    .from(hersteller)
    .where(eq(hersteller.id, herstellerId))
    .limit(1)
  if (existing.length > 0) return
  await tx.insert(hersteller).values({
    id: herstellerId,
    name: '',
    geaendertAm: new Date(0),
    erstelltAm: new Date(0),
  })
}

async function resolveArtikel(
  tx: Tx,
  op: Extract<PushOp, { entity: 'artikel' }>,
  istAdmin: boolean,
): Promise<void> {
  // Kopie, damit der urspruengliche Push-Payload fuer Diagnose/Tests
  // unangetastet bleibt. Nicht-Admins duerfen den vertraulichen
  // Einkaufspreis weder setzen noch ueberschreiben:
  //   * create: explizit null (neue Artikel starten ohne Preis)
  //   * update: Feld entfernen -> der bestehende Server-Wert bleibt stehen
  const payload: Record<string, unknown> = { ...op.payload }
  if (!istAdmin) {
    if (op.op === 'create') {
      payload['einkaufspreis'] = null
    } else {
      delete payload['einkaufspreis']
    }
  }
  const artikelId = payload['id'] as string
  if (op.op !== 'delete') {
    await stelleHerstellerReferenzSicher(tx, payload)
  }

  if (op.op === 'create') {
    const existing = await tx.select().from(artikel).where(eq(artikel.id, artikelId)).limit(1)
    if (existing.length > 0) {
      // Idempotent: bereits vorhanden, einfach akzeptieren (Update-Fall)
      await applyLastWriterWins(tx, artikel, payload)
    } else {
      await tx.insert(artikel).values(normalizeStammdatenTimestamps(payload) as never)
    }
  } else if (op.op === 'update') {
    await applyLastWriterWins(tx, artikel, payload)
  } else if (op.op === 'delete') {
    // Löschen ist nur erlaubt, solange keine referenzierenden Zeilen mehr
    // existieren. `buchungen.artikel_id` und `mindestbestand_ereignisse.
    // artikel_id` referenzieren `artikel.id` ohne ON DELETE CASCADE —
    // Postgres würde den DELETE sonst mit FK-Fehler abbrechen. Wir
    // prüfen vorab und werfen `HAS_DEPENDENCIES`, damit der Client
    // den Outbox-Eintrag quarantinieren und den User informieren kann.
    // Fotos hängen mit `ON DELETE CASCADE` an `artikel` und werden
    // automatisch mit aufgeräumt.
    const [bRes, eRes] = await Promise.all([
      tx
        .select({ c: count() })
        .from(buchungen)
        .where(eq(buchungen.artikelId, artikelId)),
      tx
        .select({ c: count() })
        .from(mindestbestandEreignisse)
        .where(eq(mindestbestandEreignisse.artikelId, artikelId)),
    ])
    assertKeineAbhaengigkeiten('artikel', artikelId, [
      { entity: 'buchungen', anzahl: Number(bRes[0]?.c ?? 0) },
      { entity: 'mindestbestand_ereignisse', anzahl: Number(eRes[0]?.c ?? 0) },
    ])
    await tx.delete(artikel).where(eq(artikel.id, artikelId))
  }
}

async function resolveHersteller(
  tx: Tx,
  op: Extract<PushOp, { entity: 'hersteller' }>,
): Promise<void> {
  const herstellerId = op.payload.id as string
  if (op.op === 'create') {
    const existing = await tx
      .select({ id: hersteller.id })
      .from(hersteller)
      .where(eq(hersteller.id, herstellerId))
      .limit(1)
    if (existing.length > 0) {
      await applyLastWriterWins(tx, hersteller, op.payload)
    } else {
      await tx.insert(hersteller).values(normalizeStammdatenTimestamps(op.payload) as never)
    }
  } else if (op.op === 'update') {
    await applyLastWriterWins(tx, hersteller, op.payload)
  } else if (op.op === 'delete') {
    // Hersteller duerfen nur geloescht werden, solange kein Artikel mehr
    // darauf verweist. Der FK ist ON DELETE SET NULL, aber ein stilles
    // Entkoppeln aller Artikel waere Datenverlust — deshalb explizit
    // HAS_DEPENDENCIES (Client deaktiviert den Button vorab).
    const [aRes] = await Promise.all([
      tx
        .select({ c: count() })
        .from(artikel)
        .where(eq(artikel.herstellerId, herstellerId)),
    ])
    assertKeineAbhaengigkeiten('hersteller', herstellerId, [
      { entity: 'artikel', anzahl: Number(aRes[0]?.c ?? 0) },
    ])
    await tx.delete(hersteller).where(eq(hersteller.id, herstellerId))
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
  } else if (op.op === 'update') {
    // Das Hauptlagers (Standard-Standort) darf nicht archiviert werden.
    // Sonst gaebe es keinen Standard mehr, obwohl die App fest davon
    // ausgeht ("es gibt immer ein Hauptlager").
    if (op.payload.archiviert === true) {
      const existing = await tx
        .select({ standard: standorte.standard })
        .from(standorte)
        .where(eq(standorte.id, op.payload.id))
        .limit(1)
      if (existing[0]?.standard === true) throw new ProtectedStandortError(op.payload.id)
    }
    await applyLastWriterWins(tx, standorte, op.payload)
  } else if (op.op === 'delete') {
    // Das Hauptlager ist unloeschbar. Der Standard-Flag wird aus der DB
    // gelesen (nicht aus dem Payload) — ein alter oder manipulierter
    // Client darf den Schutz nicht umgehen koennen.
    const current = await tx
      .select({ standard: standorte.standard })
      .from(standorte)
      .where(eq(standorte.id, op.payload.id))
      .limit(1)
    if (current[0]?.standard === true) throw new ProtectedStandortError(op.payload.id)
    // `buchungen.standort_id`, `buchungen.standort_ziel_id` und
    // `mindestbestand_ereignisse.standort_id` referenzieren `standorte.id`
    // ohne ON DELETE CASCADE — vorher prüfen. Die Mindestbestand-
    // Konfigurationen haengen dagegen mit CASCADE am Standort und werden
    // beim Loeschen mitentfernt (bewusst kein Blockieren).
    const [qRes, zRes, eRes] = await Promise.all([
      tx
        .select({ c: count() })
        .from(buchungen)
        .where(eq(buchungen.standortId, op.payload.id)),
      tx
        .select({ c: count() })
        .from(buchungen)
        .where(eq(buchungen.standortZielId, op.payload.id)),
      tx
        .select({ c: count() })
        .from(mindestbestandEreignisse)
        .where(eq(mindestbestandEreignisse.standortId, op.payload.id)),
    ])
    assertKeineAbhaengigkeiten('standort', op.payload.id, [
      { entity: 'buchungen', anzahl: Number(qRes[0]?.c ?? 0) + Number(zRes[0]?.c ?? 0) },
      { entity: 'mindestbestand_ereignisse', anzahl: Number(eRes[0]?.c ?? 0) },
    ])
    await tx.delete(standorte).where(eq(standorte.id, op.payload.id))
  }
}

/**
 * Mindestbestand je (Artikel, Standort). Last-Writer-Wins auf
 * `geaendertAm`, Identitaet ist das Paar (keine eigene UUID). Der
 * Resolver prueft die Referenzen vorab, damit ein fehlender Artikel oder
 * Standort als `UNKNOWN_REFERENCE` in der Quarantaene landet statt als
 * Postgres-FK-Fehler.
 */
async function resolveArtikelStandortMindestbestand(
  tx: Tx,
  op: Extract<PushOp, { entity: 'artikel_standort_mindestbestand' }>,
): Promise<void> {
  const payload = op.payload as {
    artikelId: string
    standortId: string
    mindestbestand: number
    geaendertAm: string
    erstelltAm: string
  }
  if (op.op === 'delete') {
    await tx
      .delete(artikelStandortMindestbestaende)
      .where(
        and(
          eq(artikelStandortMindestbestaende.artikelId, payload.artikelId),
          eq(artikelStandortMindestbestaende.standortId, payload.standortId),
        ),
      )
    return
  }

  const [aRes, sRes] = await Promise.all([
    tx.select({ id: artikel.id }).from(artikel).where(eq(artikel.id, payload.artikelId)).limit(1),
    tx
      .select({ id: standorte.id })
      .from(standorte)
      .where(eq(standorte.id, payload.standortId))
      .limit(1),
  ])
  if (aRes.length === 0) throw new UnbekannteReferenzError('artikel', payload.artikelId)
  if (sRes.length === 0) throw new UnbekannteReferenzError('standort', payload.standortId)

  const incomingGeaendertAm = toDateOrThrow(payload.geaendertAm)
  const existing = await tx
    .select()
    .from(artikelStandortMindestbestaende)
    .where(
      and(
        eq(artikelStandortMindestbestaende.artikelId, payload.artikelId),
        eq(artikelStandortMindestbestaende.standortId, payload.standortId),
      ),
    )
    .limit(1)
  const current = existing[0]
  if (!current) {
    await tx.insert(artikelStandortMindestbestaende).values({
      artikelId: payload.artikelId,
      standortId: payload.standortId,
      mindestbestand: payload.mindestbestand,
      geaendertAm: incomingGeaendertAm,
      erstelltAm: toDateOrThrow(payload.erstelltAm),
    })
    return
  }
  const serverGeaendertAm = toDateOrThrow(current.geaendertAm)
  applyLastWriterWinsMock({
    serverGeaendertAm,
    incomingGeaendertAm,
    id: `${payload.artikelId}#${payload.standortId}`,
  })
  await tx
    .update(artikelStandortMindestbestaende)
    .set({
      mindestbestand: payload.mindestbestand,
      geaendertAm: incomingGeaendertAm,
    })
    .where(
      and(
        eq(artikelStandortMindestbestaende.artikelId, payload.artikelId),
        eq(artikelStandortMindestbestaende.standortId, payload.standortId),
      ),
    )
}

async function resolveProjekt(
  tx: Tx,
  op: Extract<PushOp, { entity: 'kommission' }>,
): Promise<void> {
  if (op.op === 'create') {
    const existing = await tx.select().from(projekte).where(eq(projekte.id, op.payload.id)).limit(1)
    if (existing.length > 0) {
      await applyLastWriterWins(tx, projekte, op.payload)
    } else {
      await tx.insert(projekte).values(normalizeStammdatenTimestamps(op.payload) as never)
    }
  } else if (op.op === 'update') {
    await applyLastWriterWins(tx, projekte, op.payload)
  } else if (op.op === 'delete') {
    // Projekte sind reine Bezeichnung in Buchungen (TEXT-Spalte `projekt`),
    // keine FK. Löschen ist immer erlaubt, sobald der Datensatz existiert.
    await tx.delete(projekte).where(eq(projekte.id, op.payload.id))
  }
}

// ---------- Last-Writer-Wins ----------

async function applyLastWriterWins(
  tx: Tx,
  table: typeof artikel | typeof standorte | typeof projekte | typeof hersteller,
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

export interface BuchungPayload {
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
 *
 * Trigger für Mindestbestand-Ereignisse: nach erfolgreichem Insert wird
 * der neue Bestand gegen den Mindestbestand des Paares
 * (Artikel, Standort) geprüft (`artikel_standort_mindestbestaende`). Bei
 * Unterschreitung schreibt der Resolver eine Zeile in
 * `mindestbestand_ereignisse` — INNERHALB derselben Transaktion, damit
 * Konsistenz zwischen DB und Event-Zähler gewahrt bleibt. Der
 * frisch erzeugte Datensatz wird als `MindestbestandEreignisRow`
 * zurückgegeben, damit `resolvePush` den Notification-Gateway am Ende
 * füttern kann.
 *
 * `bestandQuerier` MUST be the same transaction handle as `tx` (never the
 * pool): the aggregate read has to see the booking inserted a few lines
 * above, which is only visible inside the open transaction.
 */
export async function resolveBuchungCreate(
  tx: Tx,
  b: BuchungPayload,
  bestandQuerier: BestandQuerier,
  onSkip?: (reason: string) => void,
): Promise<MindestbestandEreignisRow | null> {
  // 1) Idempotenz: gleiche ID → 200 duplicate. Buchungen sind append-only,
  //    ein späterer Push derselben ID ändert nichts. Die storno-Markierung
  //    wird NICHT aus dem Payload übernommen, sondern aus der Storno-Kette
  //    abgeleitet (siehe Schritt 2) — sonst könnte ein veralteter Client
  //    einen Storno zurücksetzen.
  const existing = await tx.select().from(buchungen).where(eq(buchungen.id, b.id)).limit(1)
  if (existing.length > 0) {
    onSkip?.('DUPLICATE_ID')
    return null
  }

  // 2) Storno-Kette. Eine eingehende Storno-Buchung verweist per `stornoVon`
  //    auf ihr Ziel:
  //      a) Ziel ist eine normale Buchung X → X wird storniert
  //         (X.storno=true, X.storniertDurch=<Storno-ID>). Ist X bereits
  //         storniert, wird der Storno geschluckt (Doppel-Storno über
  //         parallele Clients — idempotent no-op). Wenn das Original noch
  //         nicht angekommen ist (race), wird der Storno vorgemerkt und
  //         landet beim Eintreffen des Originals.
  //      b) Ziel ist selbst eine Storno-Buchung S (typ='storno') → S wurde
  //         aufgehoben: das Original von S (S.stornoVon) wird wieder aktiv
  //         (storno=false, storniertDurch=null).
  //
  //    Daraus leitet der Server seinen storno-Zustand ab (Schritt 6), statt
  //    den Flag aus dem Payload zu übernehmen.
  let aufhebungVon: string | null = null
  if (b.typ === 'storno' && b.stornoVon) {
    const zielRows = await tx
      .select({
        id: buchungen.id,
        typ: buchungen.typ,
        storno: buchungen.storno,
        stornoVon: buchungen.stornoVon,
      })
      .from(buchungen)
      .where(eq(buchungen.id, b.stornoVon))
      .limit(1)
    const ziel = zielRows[0]
    if (ziel?.typ === 'storno') {
      aufhebungVon = ziel.stornoVon ?? null
    } else if (ziel?.storno === true) {
      onSkip?.('DUPLICATE_STORNO')
      return null // doppelter Storno: idempotent no-op
    }
  }

  // 3) Referenz-Check + Mindestbestand laden
  const a = await tx
    .select({ id: artikel.id })
    .from(artikel)
    .where(eq(artikel.id, b.artikelId))
    .limit(1)
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
  // The threshold is per (Artikel, Standort). There is deliberately NO
  // fallback to the deprecated global `artikel.mindestbestand`: a missing
  // row means "no minimum at this location".
  const mindestbestandRow = await tx
    .select({ mindestbestand: artikelStandortMindestbestaende.mindestbestand })
    .from(artikelStandortMindestbestaende)
    .where(
      and(
        eq(artikelStandortMindestbestaende.artikelId, b.artikelId),
        eq(artikelStandortMindestbestaende.standortId, b.standortId),
      ),
    )
    .limit(1)
  const mindestbestand = mindestbestandRow[0]?.mindestbestand ?? null

  // 5) Insert. Timestamp-Felder muessen als Date an Drizzle gehen (siehe
  //    normalizeBuchungTimestamps-Kommentar).
  await tx
    .insert(buchungen)
    .values(normalizeBuchungTimestamps(b as unknown as Record<string, unknown>) as never)

  // 6) Storno-Kette anwenden (siehe Schritt 2). Der Ziel-Zustand wird
  //    serverseitig gesetzt — der Client muss die Flags nicht pushen.
  if (b.typ === 'storno' && b.stornoVon) {
    if (aufhebungVon) {
      await tx
        .update(buchungen)
        .set({ storno: false, storniertDurch: null })
        .where(eq(buchungen.id, aufhebungVon))
    } else {
      await tx
        .update(buchungen)
        .set({ storno: true, storniertDurch: b.id })
        .where(eq(buchungen.id, b.stornoVon))
    }
  }

  // 7) Mindestbestand-Trigger: nur für Buchungstypen, die den Bestand
  //    real verändern (also nicht storno, nicht kommission). Inventur
  //    zählt, weil sie als Differenz kodiert ist und der neue Bestand
  //    genau `soll` ist (= bestand_davor + differenz). Bei Umlagerung
  //    betrachten wir nur die Quell-Seite (standortId), nicht das Ziel —
  //    der Quellbestand sinkt, ein Mindestbestand-Unterschreiten am
  //    Quellstandort ist das relevante Signal.
  if (b.typ === 'storno' || b.typ === 'kommission' || b.storno) {
    return null
  }
  const neuerBestand = await berechneBestand(bestandQuerier, b.artikelId, b.standortId)
  if (!sollteWarnungAusloesen(mindestbestand, neuerBestand)) {
    return null
  }
  // `mindestbestand` ist hier garantiert eine number (sollteWarnungAusloesen
  // gibt nur dann true zurück, wenn der Wert !== null ist). Der Cast
  // beruhigt TypeScript.
  const mindest = mindestbestand as number
  const eventId = crypto.randomUUID()
  await tx.insert(mindestbestandEreignisse).values({
    id: eventId,
    artikelId: b.artikelId,
    standortId: b.standortId,
    ausloeserBuchungId: b.id,
    bestandDanach: neuerBestand,
    mindestbestand: mindest,
    defizit: berechneDefizit(mindest, neuerBestand),
    erstelltAm: new Date(),
    zustellungAdminIds: [],
    konsumiertVonMail: false,
  })
  return {
    id: eventId,
    artikelId: b.artikelId,
    standortId: b.standortId,
    ausloeserBuchungId: b.id,
    bestandDanach: neuerBestand,
    mindestbestand: mindest,
    defizit: berechneDefizit(mindest, neuerBestand),
    erstelltAm: new Date().toISOString(),
  }
}

/**
 * Internes Row-Format für den Notification-Gateway (siehe
 * `services/notification-gateway.ts`). Wird in `resolvePush` gesammelt
 * und am Ende an `gateway.dispatchMindestbestandEvent` weitergereicht.
 * Wird auch direkt vom Snapshot-Endpoint im Resolver-Pfad erzeugt
 * (siehe `sync/routes.ts`).
 */
export interface MindestbestandEreignisRow {
  id: string
  artikelId: string
  standortId: string
  ausloeserBuchungId: string
  bestandDanach: number
  mindestbestand: number
  defizit: number
  erstelltAm: string
}

async function resolveBuchung(
  tx: Tx,
  op: Extract<PushOp, { entity: 'buchung' }>,
  bestandQuerier: BestandQuerier,
  onSkip?: (reason: string) => void,
): Promise<MindestbestandEreignisRow | null> {
  if (op.op !== 'create') {
    throw new ValidationError('buchung.op', 'nur "create" erlaubt (append-only)')
  }
  return resolveBuchungCreate(tx, op.payload as BuchungPayload, bestandQuerier, onSkip)
}

/**
 * Pusht ein Umlagerungs-Paar atomar in EINER DB-Transaktion. Beide
 * Hälften werden gemeinsam validiert und eingefügt — entweder beide
 * oder keine. Gibt die ausgelösten Mindestbestand-Ereignisse und die
 * idempotent übersprungenen Hälften zurück.
 */
async function resolveUmlagerungPaar(
  db: PostgresJsDatabase<typeof schema>,
  ops: ReadonlyArray<Extract<PushOp, { entity: 'buchung' }>>,
): Promise<{
  events: MindestbestandEreignisRow[]
  skipped: Array<{ id: string; reason: string }>
}> {
  const events: MindestbestandEreignisRow[] = []
  const skipped: Array<{ id: string; reason: string }> = []
  await db.transaction(async (tx) => {
    for (const op of ops) {
      const ev = await resolveBuchungCreate(tx, op.payload as BuchungPayload, tx, (reason) => {
        skipped.push({ id: op.payload.id, reason })
      })
      if (ev) events.push(ev)
    }
  })
  return { events, skipped }
}

// ---------- Einstellungs-Resolver ----------
// Whitelist der erlaubten Keys. artikelTypen ist global und nur von
// Admins pflegbar. sprache und standardStandortId sind pro User.
const ADMIN_ONLY_KEYS = new Set<string>(['artikelTypen', 'kommissionen', 'companyName', 'barcodeTyp'])

async function resolveEinstellung(
  tx: Tx,
  op: Extract<PushOp, { entity: 'einstellung' }>,
  benutzerId: string,
  benutzerRolle: 'admin' | 'user',
): Promise<boolean> {
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
    return true
  }
  // Nur überschreiben, wenn die eingehende Version neuer ist.
  // Auch hier: Drizzle-string-vs-Date normalisieren.
  const existingRow = existing[0]
  if (!existingRow) return true
  const existingGeaendertAm = toDateOrThrow(existingRow.geaendertAm)
  if (incomingGeaendertAm.getTime() <= existingGeaendertAm.getTime()) {
    return false
  }
  await tx
    .update(einstellungen)
    .set({ value: p.value, geaendertAm: incomingGeaendertAm })
    .where(where)
  return true
}
