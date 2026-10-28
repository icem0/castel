// Service: rebuild the (wiped) server database from the local IndexedDB mirror.
//
// Use case: an admin cleared the server DB (`POST /api/admin/db/clear`). The
// local IndexedDB still holds the full working copy, but the sync worker only
// pushes OUTBOX items — master data that was previously synced is not queued
// again. As a result new bookings referencing (now missing) artikel are
// rejected with `UNKNOWN_REFERENCE` and get hard-quarantined; incremental
// sync can never heal this state because the referenced master data would
// never be pushed.
//
// This service queues ALL local data into the outbox in dependency order
// (standorte → artikel → kommission → buchungen → settings) with strictly
// increasing `createdAt` timestamps, so the worker's `orderBy('createdAt')`
// batch order is deterministic and precedes any naturally pending items.
// The server resolver is idempotent (master data `create` inserts when
// missing, bookings are deduped by UUID, settings are LWW upserts), so
// re-pushing previously synced rows is safe.
//
// Order of operations:
//   1) Refuse when the server still holds domain data (unless `force`).
//   2) Queue every local row into the outbox (dependency-ordered, umlagerung
//      halves adjacent so they land in the same push batch).
//   3) Drain the outbox through repeated `triggerSyncNow` cycles.
//   4) Release quarantined items whose payload was part of the reseed —
//      after the master data exists on the server again they push through.
//   5) Reset the `sync.lastPullAt` marker and run one final full-pull sync
//      so the server (source of truth) re-confirms every row.
//
// Not restorable from the client (deliberately not handled here): artikel
// photos, supplier catalogs (datanorm) and their tables — none of them are
// mirrored into IndexedDB. The UI must warn about this before starting.

import { getDb } from '../../db/database'
import type {
  AkkuBestellung,
  Artikel,
  ArtikelStandortMindestbestand,
  Buchung,
  Einstellung,
  Hersteller,
  Netzteil,
  OutboxEintrag,
  Projekt,
  Projektakku,
  Standort,
} from '../../db/types'
import { sessionLesen } from '../../auth/session'
import {
  fetchServerStatus,
  getSyncStatus,
  pendingCount,
  queueOp,
  releaseQuarantine,
  triggerSyncNow,
  type TableCounts,
} from './worker'

/**
 * Whitelist of pushable setting keys — mirror of the settings store
 * (src/stores/settings.ts GLOBAL_KEYS + PER_USER_KEYS) and of the server
 * `EINSTELLUNG_KEYS` enum (server/src/domain/validierung.ts). Server-internal
 * keys (`sync.*`, `backup.*`, `mindestbestand.*`) are never queued.
 */
const GLOBAL_SETTING_KEYS = new Set<string>([
  'artikelTypen',
  'akkuTypen',
  'akkutauschAktiv',
  'kommissionen',
  'companyName',
  'barcodeTyp',
])
const PER_USER_SETTING_KEYS = new Set<string>([
  'sprache',
  'standardStandortId',
  'onboardingSeen',
  'firstLoginDone',
  'mindestbestandSoundAn',
  'mindestbestandLautstaerke',
  'mindestbestandWiederholen',
])

/** Epoch far in the past — guarantees reseed ops precede natural outbox items. */
const QUEUE_EPOCH_MS = Date.parse('2000-01-01T00:00:00.000Z')

/** Hard cap for drain cycles (200 ops per batch → plenty for realistic data). */
const MAX_DRAIN_CYCLES = 500
/** Cap for waiting on a worker-set `nextRetryAt` between drain cycles. */
const DRAIN_WAIT_CAP_MS = 65_000

export interface ReseedPlan {
  standorte: number
  hersteller: number
  artikel: number
  artikelStandortMindestbestaende: number
  kommission: number
  buchungen: number
  einstellungen: number
  akkuNetzteile: number
  akkuProjekte: number
  akkuBestellungen: number
}

export interface ReseedResult {
  queued: ReseedPlan
  /** Outbox items still pending when the drain stopped (0 on success). */
  pendingLeft: number
  /** Quarantined items still held back after the reseed finished. */
  quarantinedLeft: number
  /** Server counts after the final sync. */
  serverCounts: TableCounts | null
}

/** Rows of one entity that the reseed would queue right now. */
async function collectRows(): Promise<{
  standorte: Standort[]
  hersteller: Hersteller[]
  artikel: Artikel[]
  artikelStandortMindestbestaende: ArtikelStandortMindestbestand[]
  kommission: Projekt[]
  buchungen: Buchung[]
  einstellungen: Array<{ key: string; userId: string | null; value: string; geaendertAm: string }>
  akkuNetzteile: Netzteil[]
  akkuProjekte: Projektakku[]
  akkuBestellungen: AkkuBestellung[]
}> {
  const db = getDb()
  const currentUserId = sessionLesen()?.userId ?? null

  const standorte = await db.standorte.toArray()
  const hersteller = await db.hersteller.toArray()
  const artikel = await db.artikel.toArray()
  const artikelStandortMindestbestaende = await db.artikelStandortMindestbestaende.toArray()
  const kommission = await db.commission.toArray()
  const buchungen = sortBuchungenForReseed(await db.buchungen.toArray())
  const akkuNetzteile = await db.akkuNetzteile.toArray()
  const akkuProjekte = await db.akkuProjekte.toArray()
  const akkuBestellungen = await db.akkuBestellungen.toArray()

  const einstellungen: Array<{
    key: string
    userId: string | null
    value: string
    geaendertAm: string
  }> = []
  for (const row of await db.einstellungen.toArray()) {
    const e = reseedSettingPayload(row, currentUserId)
    if (e) einstellungen.push(e)
  }

  return {
    standorte,
    hersteller,
    artikel,
    artikelStandortMindestbestaende,
    kommission,
    buchungen,
    einstellungen,
    akkuNetzteile,
    akkuProjekte,
    akkuBestellungen,
  }
}

/**
 * Counts of what a reseed would upload. Used by the confirmation UI.
 */
export async function collectReseedPlan(): Promise<ReseedPlan> {
  const rows = await collectRows()
  return {
    standorte: rows.standorte.length,
    hersteller: rows.hersteller.length,
    artikel: rows.artikel.length,
    artikelStandortMindestbestaende: rows.artikelStandortMindestbestaende.length,
    kommission: rows.kommission.length,
    buchungen: rows.buchungen.length,
    einstellungen: rows.einstellungen.length,
    akkuNetzteile: rows.akkuNetzteile.length,
    akkuProjekte: rows.akkuProjekte.length,
    akkuBestellungen: rows.akkuBestellungen.length,
  }
}

/**
 * Sorts bookings by `erstelltAm` (the server's canonical ordering) and keeps
 * umlagerung halves (same `paarId`) adjacent so the worker's batch split at
 * BATCH_SIZE boundaries cannot separate them into different push batches.
 */
export function sortBuchungenForReseed(buchungen: readonly Buchung[]): Buchung[] {
  const sorted = [...buchungen].sort((a, b) =>
    a.erstelltAm < b.erstelltAm ? -1 : a.erstelltAm > b.erstelltAm ? 1 : 0,
  )
  const halves = new Map<string, Buchung[]>()
  for (const b of sorted) {
    if (b.typ === 'umlagerung' && b.paarId) {
      const list = halves.get(b.paarId) ?? []
      list.push(b)
      halves.set(b.paarId, list)
    }
  }
  const out: Buchung[] = []
  const placed = new Set<string>()
  for (const b of sorted) {
    if (placed.has(b.id)) continue
    out.push(b)
    placed.add(b.id)
    if (b.typ === 'umlagerung' && b.paarId) {
      for (const twin of halves.get(b.paarId) ?? []) {
        if (twin.id !== b.id && !placed.has(twin.id)) {
          out.push(twin)
          placed.add(twin.id)
        }
      }
    }
  }
  return out
}

/**
 * Translates a local `einstellungen` row into a pushable payload, or `null`
 * when it must not be reseeded: server-internal keys (not whitelisted),
 * per-user rows of other users, and global rows for keys that are actually
 * per-user (and vice versa — scope is decided by the key, mirroring the
 * settings store).
 */
export function reseedSettingPayload(
  row: Einstellung,
  currentUserId: string | null,
): { key: string; userId: string | null; value: string; geaendertAm: string } | null {
  const isGlobalRow = row.userId === '' || row.userId === null
  if (GLOBAL_SETTING_KEYS.has(row.key)) {
    if (!isGlobalRow) return null
    return { key: row.key, userId: null, value: row.value, geaendertAm: row.geaendertAm }
  }
  if (PER_USER_SETTING_KEYS.has(row.key)) {
    if (isGlobalRow) return null
    if (row.userId !== currentUserId) return null
    return { key: row.key, userId: currentUserId, value: row.value, geaendertAm: row.geaendertAm }
  }
  return null
}

/** Server still holds domain data in any of the synced tables. */
function serverHasData(counts: TableCounts): boolean {
  return (
    counts.artikel > 0 ||
    counts.standorte > 0 ||
    counts.commission > 0 ||
    counts.buchungen > 0 ||
    (counts.hersteller ?? 0) > 0 ||
    (counts.artikelStandortMindestbestand ?? 0) > 0 ||
    (counts.akkuNetzteile ?? 0) > 0 ||
    (counts.akkuProjekte ?? 0) > 0 ||
    (counts.akkuBestellungen ?? 0) > 0
  )
}

/**
 * Thrown by `reseedServer` when the server is not empty and `force` was not
 * set. The UI reacts with an explicit "continue anyway" confirmation step.
 */
export class ReseedGuardError extends Error {
  readonly code = 'RESEED_SERVER_NOT_EMPTY'
  constructor(message: string) {
    super(message)
    this.name = 'ReseedGuardError'
  }
}

/**
 * Wipe-recovery push: rebuild the server from the local mirror.
 *
 * Throws when the server is not empty (guard against pushing an old client
 * mirror onto a live server — set `force` only after explicit confirmation)
 * or when the local DB holds nothing to push.
 */
export async function reseedServer(opts: {
  token: string | null
  apiBase: string
  /** Override the "server must be empty" guard (explicit UI confirmation). */
  force?: boolean
}): Promise<ReseedResult> {
  const { token, apiBase, force = false } = opts

  // 1) Guard: reseed only makes sense onto an (almost) empty server.
  const status = await fetchServerStatus(apiBase, token)
  if (!force && serverHasData(status.counts)) {
    throw new ReseedGuardError(
      'Server enthält noch Daten — Reseed ist nur zum Wiederaufbau einer geleerten Server-DB gedacht.',
    )
  }

  const rows = await collectRows()
  const total =
    rows.standorte.length +
    rows.hersteller.length +
    rows.artikel.length +
    rows.artikelStandortMindestbestaende.length +
    rows.kommission.length +
    rows.buchungen.length +
    rows.akkuNetzteile.length +
    rows.akkuProjekte.length +
    rows.akkuBestellungen.length
  if (total === 0) {
    throw new Error('Lokale Datenbank ist leer — es gibt nichts, das hochgeladen werden könnte.')
  }

  // 2) Queue everything with strictly increasing timestamps (epoch-based) so
  //    `orderBy('createdAt')` yields exactly this dependency order and the
  //    reseed precedes naturally pending outbox items.
  let seq = 0
  const nextTs = (): string => new Date(QUEUE_EPOCH_MS + seq++).toISOString()
  for (const s of rows.standorte) {
    await queueOp('standort', 'create', normalizeStammdaten(s), nextTs())
  }
  for (const h of rows.hersteller) {
    await queueOp('hersteller', 'create', normalizeStammdaten(h), nextTs())
  }
  for (const a of rows.artikel) {
    await queueOp('artikel', 'create', normalizeStammdaten(a), nextTs())
  }
  for (const m of rows.artikelStandortMindestbestaende) {
    await queueOp('artikel_standort_mindestbestand', 'create', m, nextTs())
  }
  for (const p of rows.kommission) {
    await queueOp('kommission', 'create', normalizeStammdaten(p), nextTs())
  }
  for (const b of rows.buchungen) {
    await queueOp('buchung', 'create', b, nextTs())
  }
  for (const e of rows.einstellungen) {
    await queueOp('einstellung', 'upsert', e, nextTs())
  }
  for (const n of rows.akkuNetzteile) {
    await queueOp('akku_netzteil', 'create', n, nextTs())
  }
  for (const p of rows.akkuProjekte) {
    await queueOp('akku_projekt', 'create', p, nextTs())
  }
  for (const b of rows.akkuBestellungen) {
    await queueOp('akku_bestellung', 'create', b, nextTs())
  }

  // 3) Drain the outbox through the regular worker (full sync per cycle,
  //    including pull — idempotent merges). Respect `nextRetryAt` backoff.
  const reseededIds = new Set<string>([
    ...rows.standorte.map((s) => s.id),
    ...rows.hersteller.map((h) => h.id),
    ...rows.artikel.map((a) => a.id),
    ...rows.artikelStandortMindestbestaende.map((m) => `${m.artikelId}#${m.standortId}`),
    ...rows.kommission.map((p) => p.id),
    ...rows.buchungen.map((b) => b.id),
    ...rows.akkuBestellungen.map((b) => b.id),
  ])
  await drainOutbox(token, apiBase)

  // 4) Release quarantined items that belong to the reseeded payload set —
  //    their references exist on the server again, so they now push through
  //    (booking duplicates are deduped idempotently by the server).
  const db = getDb()
  for (const o of await db.outbox.toArray()) {
    if (o.quarantinedAt == null) continue
    const payloadId = payloadIdOfOutbox(o)
    if (payloadId !== null && reseededIds.has(payloadId)) {
      await releaseQuarantine(o.id)
    }
  }

  // 5) Reset the incremental watermark, push the released items through and
  //    finish with one full pull so the server (source of truth) re-confirms
  //    every row.
  await db.einstellungen.put({
    key: 'sync.lastPullAt',
    userId: '',
    value: '',
    geaendertAm: new Date().toISOString(),
  })
  await drainOutbox(token, apiBase)
  await triggerSyncNow({ token, apiBase })

  let serverCounts: TableCounts | null = null
  try {
    serverCounts = (await fetchServerStatus(apiBase, token)).counts
  } catch {
    // Counts are display-only — the reseed itself already completed.
  }

  const quarantinedLeft = (await db.outbox.toArray()).filter((o) => o.quarantinedAt != null).length
  return {
    queued: {
      standorte: rows.standorte.length,
      hersteller: rows.hersteller.length,
      artikel: rows.artikel.length,
      artikelStandortMindestbestaende: rows.artikelStandortMindestbestaende.length,
      kommission: rows.kommission.length,
      buchungen: rows.buchungen.length,
      einstellungen: rows.einstellungen.length,
      akkuNetzteile: rows.akkuNetzteile.length,
      akkuProjekte: rows.akkuProjekte.length,
      akkuBestellungen: rows.akkuBestellungen.length,
    },
    pendingLeft: await pendingCount(),
    quarantinedLeft,
    serverCounts,
  }
}

/**
 * Stammdaten payloads need non-null ISO timestamps for LWW (the server
 * `artikelSchema`/`standortSchema`/`projektSchema` reject null `geaendertAm`).
 * Locally created rows before the first server round-trip can carry null —
 * fall back to `erstelltAm`.
 */
function normalizeStammdaten<T extends { geaendertAm: string | null; erstelltAm: string }>(
  row: T,
): T {
  if (row.geaendertAm !== null) return row
  return { ...row, geaendertAm: row.erstelltAm }
}

/** Payload identity of an outbox row (mirror of worker `payloadIdFor`). */
function payloadIdOfOutbox(o: OutboxEintrag): string | null {
  let payload: unknown
  try {
    payload = JSON.parse(o.payload)
  } catch {
    return null
  }
  if (!payload || typeof payload !== 'object') return null
  if (o.entity === 'einstellung') {
    const p = payload as { key?: unknown; userId?: unknown }
    if (typeof p.key !== 'string' || p.key.length === 0) return null
    const userPart = p.userId === null || p.userId === undefined ? 'global' : String(p.userId)
    return `${p.key}#${userPart}`
  }
  if (o.entity === 'artikel_standort_mindestbestand') {
    const p = payload as { artikelId?: unknown; standortId?: unknown }
    if (typeof p.artikelId !== 'string' || p.artikelId.length === 0) return null
    if (typeof p.standortId !== 'string' || p.standortId.length === 0) return null
    return `${p.artikelId}#${p.standortId}`
  }
  const id = (payload as { id?: unknown }).id
  return typeof id === 'string' && id.length > 0 ? id : null
}

/**
 * Runs full sync cycles (push + pull) until the outbox has no pending items
 * left or the cycle cap is hit. Honors a worker-set `nextRetryAt` (e.g. the
 * server answered 429/5xx with Retry-After) by sleeping before the next try.
 * Items that end up quarantined no longer count as pending — the regular
 * worker will not retry them without explicit release.
 */
async function drainOutbox(token: string | null, apiBase: string): Promise<void> {
  for (let cycle = 0; cycle < MAX_DRAIN_CYCLES; cycle++) {
    if ((await pendingCount()) === 0) return
    await triggerSyncNow({ token, apiBase })
    if ((await pendingCount()) === 0) return
    const next = getSyncNextRetryAt()
    if (next !== null) {
      const waitMs = Math.min(Math.max(0, Date.parse(next) - Date.now()), DRAIN_WAIT_CAP_MS)
      if (waitMs > 0) await sleep(waitMs)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getSyncNextRetryAt(): string | null {
  return getSyncStatus().nextRetryAt
}
