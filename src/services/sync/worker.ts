// Sync-Worker: pusht die lokale Outbox zum Server und holt den aktuellen
// Snapshot.
//
// Strategie (PLAN §9b):
//   1. Push (POST /api/sync/push): alle Outbox-Einträge mit syncedAt=null
//   2. Pull (GET /api/sync/snapshot?since=<lastPull>): aktualisiert lokale DB
//   3. Conflict-Resolution: Server hat Vorrang (Last-Writer-Wins auf
//      geaendertAm), Client sieht Server-Version in der nächsten Pull
//
// Backoff bei Server-Fehlern (5xx, Network, Origin-unavailable):
//   - Cloudflare / Fastify können `Retry-After` setzen — wir respektieren
//     ihn (cap 5 Min) und pausieren den Worker entsprechend.
//   - Sonst: 1s, 2s, 4s, 8s, 16s, 32s, 60s (Cap), gesteuert über
//     `computeBackoffMs(attempts)`.
// Wir laufen in einem setInterval + bei `online`-Event + bei `visibilitychange`.

import { getDb } from '../../db/database'
import type {
  Artikel,
  Buchung,
  Einstellung,
  MindestbestandEreignis,
  OutboxEintrag,
  OutboxOp,
  Projekt,
  Standort,
} from '../../db/types'
import { jetztIso, neueUuid } from '../../domain/ids'
import { setApiBaseUrl } from '../../auth/api'
import { sessionLesen } from '../../auth/session'
import { prepareRoleForSync } from './preise'

// ---------- Konfiguration ----------

const BATCH_SIZE = 200
/** Maximales Backoff-Intervall, wenn der Server nichts Konkreteres sagt. */
const BACKOFF_CAP_MS = 60_000
/** Hard cap für ein vom Server vorgegebenes Retry-After (Cloudflare 502: 60s). */
const RETRY_AFTER_CAP_MS = 5 * 60_000
/** Anzahl Fehlversuche, nach denen ein Outbox-Item stillgelegt wird. */
const QUARANTINE_THRESHOLD = 5
/** Server-Codes, die ein Item sofort stilllegen (kein Retry hilft). */
const HARD_QUARANTINE_CODES = new Set(['UNKNOWN_REFERENCE', 'BEREITS_STORNIED', 'HAS_DEPENDENCIES'])

export const PUSH_TIMEOUT_MS = 30_000
export const SNAPSHOT_TIMEOUT_MS = 90_000
export const SERVER_STATUS_TIMEOUT_MS = 10_000
export const RUN_TIMEOUT_MS = 120_000

// ---------- Backoff (rein, ohne Side-Effects → testbar) ----------

/**
 * Exponentielles Backoff: 1s, 2s, 4s, … mit Cap.
 * `attempts` ist die Anzahl der bisherigen Fehlversuche in Folge (≥ 0).
 */
export function computeBackoffMs(attempts: number, capMs: number = BACKOFF_CAP_MS): number {
  if (attempts <= 0) return 0
  const exp = Math.min(attempts - 1, 16)
  const ms = 1_000 * 2 ** exp
  return Math.min(ms, capMs)
}

/**
 * Zählt, in wie vielen Tabellen `lokal` von `server` abweicht. Wird vom
 * Self-Healing-Pfad in `runSync` benutzt, um zu entscheiden, ob der
 * `lastPullAt`-Marker ungültig ist und ein voller Re-Pull nötig ist.
 * Spiegel der Logik in src/App.vue (UI-Anzeige); hier dupliziert, damit
 * der Worker ohne Vue-Imports testbar bleibt.
 */
export function zaehleAbweichungen(l: TableCounts | null, s: TableCounts | null): number {
  if (!l || !s) return 0
  let n = 0
  if (l.artikel !== s.artikel) n++
  if (l.standorte !== s.standorte) n++
  if (l.commission !== s.commission) n++
  if (l.buchungen !== s.buchungen) n++
  return n
}

/**
 * Bestimmt die Identität eines Outbox-Items innerhalb eines Push-Batches.
 * Der Server referenziert jedes Item in `result.accepted` / `result.errors`
 * / `result.conflicts` unter dieser ID, damit der Client das passende
 * Outbox-Item markieren kann.
 *
 * Stammdaten (artikel, standort, projekt) und Buchungen haben eine UUID
 * als `payload.id`. Einstellungen NICHT — dort ist die Identität der
 * Compound-Key `(key, userId)`. Wir spiegeln die Server-Logik aus
 * `server/src/sync/resolver.ts` (Zeile um 150), damit `accepted.has(...)`
 * und `errorsById.has(...)` auf beiden Seiten denselben String matchen.
 *
 * Liefert `null`, wenn weder `id` noch `key`+`userId` vorhanden sind — der
 * Aufrufer behandelt das als `MISSING_PAYLOAD_ID` (bzw. als
 * korrupten Payload, je nach Kontext).
 */
export function payloadIdFor(entity: OutboxEintrag['entity'], payload: unknown): string | null {
  if (entity === 'einstellung') {
    if (!payload || typeof payload !== 'object') return null
    const p = payload as { key?: unknown; userId?: unknown }
    if (typeof p.key !== 'string' || p.key.length === 0) return null
    const userPart = p.userId === null || p.userId === undefined ? 'global' : p.userId
    if (typeof userPart !== 'string' || userPart.length === 0) return null
    return `${p.key}#${userPart}`
  }
  if (payload && typeof payload === 'object' && 'id' in payload) {
    const id = (payload as { id: unknown }).id
    if (typeof id === 'string' && id.length > 0) return id
  }
  return null
}

/**
 * Parst `Retry-After`-Header (Sekunden ODER HTTP-Datum) und cappt auf
 * `capMs`. Liefert `null`, wenn nichts Verwertbares drinsteht.
 */
export function parseRetryAfter(
  header: string | null | undefined,
  capMs: number = RETRY_AFTER_CAP_MS,
  now: number = Date.now(),
): number | null {
  if (!header) return null
  const trimmed = header.trim()
  if (!trimmed) return null
  // Sekunden (relativ)
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const sec = Number(trimmed)
    if (!Number.isFinite(sec) || sec < 0) return null
    return Math.min(sec * 1_000, capMs)
  }
  // HTTP-Datum
  const t = Date.parse(trimmed)
  if (!Number.isNaN(t)) {
    return Math.min(Math.max(0, t - now), capMs)
  }
  return null
}

// ---------- HTTP-Fehler ----------

export class SyncTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SyncTimeoutError'
  }
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' ||
      (typeof DOMException !== 'undefined' && err instanceof DOMException))
  )
}

/** Vom Server stammender Fehler mit optionalem Retry-After. */
export class SyncHttpError extends Error {
  readonly status: number
  readonly retryAfterMs: number | null
  /** Kurzer Anzeige-Code für die UI (z. B. "origin-unavailable"). */
  readonly category: 'origin-unavailable' | 'auth' | 'validation' | 'http'

  constructor(
    status: number,
    message: string,
    opts: { retryAfterMs?: number | null; category?: SyncHttpError['category'] } = {},
  ) {
    super(message)
    this.name = 'SyncHttpError'
    this.status = status
    this.retryAfterMs = opts.retryAfterMs ?? null
    this.category = opts.category ?? (status >= 500 ? 'origin-unavailable' : 'http')
  }
}

function categorizeStatus(status: number): SyncHttpError['category'] {
  if (status === 401 || status === 403) return 'auth'
  if (status >= 400 && status < 500) return 'validation'
  if (status >= 500) return 'origin-unavailable'
  return 'http'
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text()
    // Cloudflare-5xx-Fehlermeldungen sind JSON, aber für die UI reicht
    // ein kurzer Header plus der Status.
    return text.length > 240 ? `${text.slice(0, 240)}…` : text
  } catch {
    return ''
  }
}

/**
 * Fetch wrapper with a hard client-side timeout. A hung request must not
 * leave the worker in a silent `syncing` state, so the timer rejects even
 * when the fetch mock/transport ignores `signal`.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  parentSignal: AbortSignal | null = null,
): Promise<Response> {
  const controller = new AbortController()
  let onParentAbort: (() => void) | null = null

  if (parentSignal) {
    if (parentSignal.aborted) {
      if (parentSignal.reason instanceof SyncTimeoutError) throw parentSignal.reason
      throw new SyncTimeoutError(`Sync-Fetch abgebrochen: ${url}`)
    }
    onParentAbort = () => controller.abort(parentSignal.reason)
    parentSignal.addEventListener('abort', onParentAbort, { once: true })
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  try {
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        const err = new SyncTimeoutError(`Sync-Timeout nach ${timeoutMs}ms: ${url}`)
        controller.abort(err)
        reject(err)
      }, timeoutMs)
    })

    try {
      return await Promise.race([fetch(url, { ...init, signal: controller.signal }), timeout])
    } catch (err) {
      if (parentSignal?.aborted && parentSignal.reason instanceof SyncTimeoutError) {
        throw parentSignal.reason
      }
      if (isAbortError(err)) {
        if (parentSignal?.aborted && parentSignal.reason instanceof SyncTimeoutError) {
          throw parentSignal.reason
        }
        throw new SyncTimeoutError(`Sync-Fetch abgebrochen: ${url}`)
      }
      throw err
    }
  } finally {
    if (timeoutHandle !== null) clearTimeout(timeoutHandle)
    if (onParentAbort) parentSignal?.removeEventListener('abort', onParentAbort)
  }
}

// ---------- Typen ----------

export interface SyncSnapshot {
  serverTime: string
  since: string
  artikel: Artikel[]
  standorte: Standort[]
  commission: Projekt[]
  buchungen: Buchung[]
  /** Cross-Device-synchronisierte Einstellungen. Pro User gefiltert. */
  einstellungen: Einstellung[]
  /**
   * Mindestbestand-Ereignisse, die der Server-Resolver seit
   * `mindestSince` ausgelöst hat. Append-only, getrieben vom
   * Marker `mindestbestand.lastPullAt` in `einstellungen`.
   */
  mindestbestandEreignisse: MindestbestandEreignis[]
  /** Server-Zeitstempel, an dem `mindestbestandEreignisse` gefiltert
   *  wurde. Wir spiegeln den Wert zurück, damit der Client den
   *  Marker aktualisieren kann (Pagination-Support). */
  mindestSince?: string
}

export interface PushResult {
  accepted: string[]
  /** Valid ops that changed nothing on the server (idempotent no-ops). */
  skipped?: Array<{ id: string; reason: string }>
  conflicts: Array<{ id: string; reason: string }>
  errors: Array<{
    id: string
    code: string
    message: string
    currentBestand?: number
    /** Nur bei code === 'INTERNAL' — Server-Stack + eingegangenes Payload,
     *  damit die PWA-Diagnose den Bug sichtbar macht. */
    stack?: string
    payload?: unknown
  }>
}

export interface TableCounts {
  artikel: number
  standorte: number
  commission: number
  buchungen: number
}

export interface ServerStatus {
  serverTime: string
  counts: TableCounts
}

/** Wo der letzte Server-Fehler aufgetreten ist. */
export type SyncFailureSource = 'push' | 'snapshot' | 'status' | 'network' | null

/** Strukturierte Diagnose-Info für den letzten Fehler. */
export interface SyncLastFailure {
  /** Wann der Fehler aufgetreten ist (ISO). */
  at: string
  /** Welcher Sync-Schritt hat versagt. */
  source: SyncFailureSource
  /** HTTP-Status, falls zutreffend. */
  status: number | null
  /** Kurzer Code aus der Server-Antwort (z. B. "VALIDATION", "NEGATIVE_BESTAND"). */
  code: string | null
  /** Menschenlesbare Message. */
  message: string
  /** Vom Server gesetztes Retry-After (ms), falls vorhanden. */
  retryAfterMs: number | null
  /** Anzahl Outbox-Items, die im letzten Push abgelehnt wurden (errors+conflicts). */
  rejectedItems: number
  /** Erste paar Beispiele aus `result.errors` für Diagnose. `stack` und
   *  `payload` werden nur vom Server geliefert, wenn der Fehler
   *  unerwartet war (code === 'INTERNAL'). Die UI zeigt beides an —
   *  ohne diese Felder war der Bug "value.toISOString is not a function"
   *  nicht greifbar, weil nur die nackte Message sichtbar war. */
  sampleErrors: Array<{
    id: string
    code: string
    message: string
    stack?: string
    payload?: unknown
    currentBestand?: number
  }>
  /** Erste paar Outbox-Items mit lastError (sichtbar in der UI). */
  stuckItems: Array<{
    outboxId: string
    entity: string
    op: string
    payloadId: string
    attempts: number
    lastError: string | null
    createdAt: string
  }>
}

/**
 * Ein manuell stillgelegtes Outbox-Item. Erscheint im Sync-Panel
 * separat von "Stuck Items" — diese sind absichtlich gestoppt und
 * warten auf eine Entscheidung des Users.
 */
export interface QuarantinedItem {
  outboxId: string
  entity: string
  op: string
  payloadId: string
  attempts: number
  lastError: string | null
  quarantinedAt: string
  quarantineReason: string
  createdAt: string
}

export type SyncStep =
  | 'prepare'
  | 'push'
  | 'snapshot'
  | 'serverStatus'
  | 'counts'
  | 'reconcile'
  | 'done'
  | 'timeout'
  | null

export interface SyncStatus {
  status: 'idle' | 'syncing' | 'offline' | 'error' | 'origin-unavailable'
  pending: number
  /** Pending + quarantined items that still need an explicit user action. */
  unresolved: number
  /** Anzahl manuell stillgelegter Outbox-Items (Quarantäne). */
  quarantined: number
  /** Erste paar quarantinierte Items für die UI. */
  quarantinedItems: QuarantinedItem[]
  lastSyncAt: string | null
  lastError: string | null
  /** Counts pro Tabelle, zuletzt vom Server gemeldet. */
  serverCounts: TableCounts | null
  /** Counts pro Tabelle in der lokalen IndexedDB. */
  localCounts: TableCounts | null
  /** Server-Zeitpunkt der letzten Counts-Abfrage (ISO). */
  serverTime: string | null
  /** Wann der nächste Sync-Versuch starten soll (ISO). `null` = sofort erlaubt. */
  nextRetryAt: string | null
  /** Strukturierte Diagnose-Info für den letzten Fehler (oder `null`). */
  lastFailure: SyncLastFailure | null
  /** Last worker phase for UI/diagnostics. */
  lastStep: SyncStep
  lastStepAt: string | null
  lastErrorCode: string | null
  lastErrorAt: string | null
  lastErrorFingerprint: string | null
}

const LISTENERS = new Set<(s: SyncStatus) => void>()
let _status: SyncStatus = {
  status: 'idle',
  pending: 0,
  unresolved: 0,
  quarantined: 0,
  quarantinedItems: [],
  lastSyncAt: null,
  lastError: null,
  serverCounts: null,
  localCounts: null,
  serverTime: null,
  nextRetryAt: null,
  lastFailure: null,
  lastStep: null,
  lastStepAt: null,
  lastErrorCode: null,
  lastErrorAt: null,
  lastErrorFingerprint: null,
}
let _intervalHandle: ReturnType<typeof setInterval> | null = null
/**
 * Refs to the event listeners registered by `startSyncWorker`. Null before
 * `start`, null again after `stop` — prevents double registration when
 * `startSyncWorker` is called repeatedly (App.vue's `watchEffect`).
 */
let _onlineHandler: (() => void) | null = null
let _visibilityHandler: (() => void) | null = null
/** Handle of the boot tick (`setTimeout(tick, 2_000)`) from startSyncWorker. */
let _bootHandle: ReturnType<typeof setTimeout> | null = null
/**
 * `true` while the worker is stopped. `tick` checks this flag so an
 * `online`/`visibilitychange` event that is still queued after
 * `stopSyncWorker()` cannot start a sync. Critical for the "delete local
 * DB" flow: a sync there would immediately reopen and refill the database
 * that was just wiped.
 */
let _paused = false
/**
 * Hard latch: while set, `startSyncWorker()` ignores every call. Required
 * for the admin "delete local DB" flow — App.vue's `watchEffect` calls
 * `sync.start()` on every reactivity change and would otherwise revive
 * the worker in the middle of the reset. Cleared by a page reload (or by
 * `_resetSyncForTests()`).
 */
let _suspended = false
let _running = false
/** Anzahl der aufeinanderfolgenden Fehlversuche (für Backoff). */
let _consecutiveFailures = 0
/** Callback, der bei 401 einmalig aufgerufen wird, damit die App den
 *  Auth-Store zurücksetzen und zur Login-View navigieren kann. */
let _onAuthRevoked: (() => void) | null = null
/** Latch: verhindert mehrfaches Feuern von onAuthRevoked, bis ein
 *  erfolgreicher Push die Auth-Validität wieder bestätigt. */
let _authRevokedNotified = false
/**
 * Set when a caller asks for a sync while one is already running. The
 * pending run is started immediately after the current one finishes, so a
 * booking created mid-sync is not delayed until the next 30s tick.
 */
let _rerunRequested = false
let _rerunOpts: { token: string | null; apiBase: string } | null = null
let _runToken = 0
let _runAbort: AbortController | null = null
let _watchdogHandle: ReturnType<typeof setTimeout> | null = null

export function getSyncStatus(): SyncStatus {
  return _status
}

export function onSyncStatus(fn: (s: SyncStatus) => void): () => void {
  LISTENERS.add(fn)
  return () => LISTENERS.delete(fn)
}

function updateStatus(patch: Partial<SyncStatus>): void {
  _status = { ..._status, ...patch }
  for (const l of LISTENERS) l(_status)
}

// ---------- API-Calls ----------

/**
 * Lädt einen Snapshot vom Server. Wird vom regulären Sync-Pfad und vom
 * "Lokale DB löschen"-Flow benutzt — daher exportiert, nicht privat.
 * `since` ist optional: leerer String zieht den kompletten Snapshot.
 * `mindestSince` filtert zusätzlich `mindestbestandEreignisse`. Default
 * = "seit Anbeginn der Zeit" (= alle Events).
 */
export async function fetchSnapshot(
  apiBase: string,
  token: string | null,
  since: string,
  mindestSince?: string,
  signal: AbortSignal | null = null,
  timeoutMs: number = SNAPSHOT_TIMEOUT_MS,
): Promise<SyncSnapshot> {
  const params = new URLSearchParams()
  if (since) params.set('since', since)
  if (mindestSince) params.set('mindestSince', mindestSince)
  const qs = params.toString()
  const url = `${apiBase}/api/sync/snapshot${qs ? `?${qs}` : ''}`
  const res = await fetchWithTimeout(
    url,
    {
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      credentials: 'include',
    },
    timeoutMs,
    signal,
  )
  if (!res.ok) {
    const body = await readErrorBody(res)
    const retryAfterMs = parseRetryAfter(res.headers.get('Retry-After'))
    throw new SyncHttpError(res.status, `Snapshot HTTP ${res.status}: ${body}`, {
      retryAfterMs,
      category: categorizeStatus(res.status),
    })
  }
  return (await res.json()) as SyncSnapshot
}

async function pushOps(
  apiBase: string,
  token: string | null,
  ops: unknown[],
  signal: AbortSignal | null = null,
  timeoutMs: number = PUSH_TIMEOUT_MS,
): Promise<PushResult> {
  const res = await fetchWithTimeout(
    `${apiBase}/api/sync/push`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      credentials: 'include',
      body: JSON.stringify({ ops }),
    },
    timeoutMs,
    signal,
  )
  if (!res.ok) {
    const body = await readErrorBody(res)
    const retryAfterMs = parseRetryAfter(res.headers.get('Retry-After'))
    throw new SyncHttpError(res.status, `Push HTTP ${res.status}: ${body}`, {
      retryAfterMs,
      category: categorizeStatus(res.status),
    })
  }
  return (await res.json()) as PushResult
}

export async function fetchServerStatus(
  apiBase: string,
  token: string | null,
  signal: AbortSignal | null = null,
  timeoutMs: number = SERVER_STATUS_TIMEOUT_MS,
): Promise<ServerStatus> {
  const res = await fetchWithTimeout(
    `${apiBase}/api/sync/status`,
    {
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      credentials: 'include',
    },
    timeoutMs,
    signal,
  )
  if (!res.ok) {
    const body = await readErrorBody(res)
    const retryAfterMs = parseRetryAfter(res.headers.get('Retry-After'))
    throw new SyncHttpError(res.status, `Status HTTP ${res.status}: ${body}`, {
      retryAfterMs,
      category: categorizeStatus(res.status),
    })
  }
  return (await res.json()) as ServerStatus
}

interface ReconcileResult {
  present: string[]
  missing: string[]
}

const RECONCILE_BATCH_SIZE = 500

async function postReconcile(
  apiBase: string,
  token: string | null,
  ids: string[],
  signal: AbortSignal | null,
): Promise<ReconcileResult> {
  const res = await fetchWithTimeout(
    `${apiBase}/api/sync/reconcile`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      credentials: 'include',
      body: JSON.stringify({ ids }),
    },
    PUSH_TIMEOUT_MS,
    signal,
  )
  if (!res.ok) {
    const body = await readErrorBody(res)
    const retryAfterMs = parseRetryAfter(res.headers.get('Retry-After'))
    throw new SyncHttpError(res.status, `Reconcile HTTP ${res.status}: ${body}`, {
      retryAfterMs,
      category: categorizeStatus(res.status),
    })
  }
  return (await res.json()) as ReconcileResult
}

/**
 * Compare local booking IDs with the server. Missing IDs are marked locally
 * as "not saved" (never deleted). IDs that are present clear an older mark.
 * With `allLocal = false` only already-marked rows are checked, which keeps
 * later syncs cheap once the known divergence has been marked.
 */
async function reconcileBookings(
  apiBase: string,
  token: string | null,
  signal: AbortSignal | null,
  allLocal: boolean,
): Promise<number> {
  const db = getDb()
  const rows = allLocal
    ? await db.buchungen.toArray()
    : await db.buchungen.filter((b) => b.nichtGespeichert === true).toArray()
  const ids = rows.map((b) => b.id)
  if (ids.length === 0) return 0

  let missingCount = 0
  for (let i = 0; i < ids.length; i += RECONCILE_BATCH_SIZE) {
    if (signal?.aborted) throw new SyncTimeoutError('Sync abgebrochen')
    const chunk = ids.slice(i, i + RECONCILE_BATCH_SIZE)
    const result = await postReconcile(apiBase, token, chunk, signal)
    const present = new Set(result.present)
    const missing = new Set(result.missing)
    const at = jetztIso()
    for (const id of chunk) {
      if (present.has(id)) {
        await db.buchungen.update(id, {
          nichtGespeichert: false,
          skipReason: null,
          skipBemerkung: null,
          serverVerworfenAt: null,
        })
      } else if (missing.has(id)) {
        missingCount++
        await db.buchungen.update(id, {
          nichtGespeichert: true,
          skipReason: 'SERVER_MISSING',
          skipBemerkung: 'Buchung ist lokal vorhanden, fehlt aber auf dem Server.',
          serverVerworfenAt: at,
        })
      }
    }
  }
  return missingCount
}

async function getLocalCounts(): Promise<TableCounts> {
  const db = getDb()
  const [artikel, standorte, projekte, buchungen] = await Promise.all([
    db.artikel.count(),
    db.standorte.count(),
    db.commission.count(),
    db.buchungen.count(),
  ])
  return { artikel, standorte, commission: projekte, buchungen }
}

// ---------- Outbox-Helfer ----------

export async function pendingCount(): Promise<number> {
  // Dexie/IndexedDB unterstützt kein `where('syncedAt').equals(null)` —
  // daher der Full-Scan. Outbox-Größe bleibt im Lager-Use-Case klein
  // (≪ 1k Einträge zwischen Sync-Ticks), ein Index hier wäre teurer
  // als der Scan. Bewusst beibehalten.
  // `quarantinedAt == null` (nicht `===`), damit Items ohne das Feld
  // (alte Test-Helper / vor-v7) nicht versehentlich als quarantiniert
  // zählen.
  const all = await getDb().outbox.toArray()
  return all.filter((o) => o.syncedAt == null && o.quarantinedAt == null).length
}

async function nextBatch(): Promise<OutboxEintrag[]> {
  // WICHTIG: niemals `limit(BATCH_SIZE)` direkt auf die Outbox-Tabelle
  // setzen — sonst übersehen wir pending Items, wenn die ersten 200
  // bereits synced sind (Bug 2025-12). Stattdessen alle pending lesen
  // und die ersten BATCH_SIZE nehmen.
  const all = await getDb().outbox.orderBy('createdAt').toArray()
  return all.filter((o) => o.syncedAt == null && o.quarantinedAt == null).slice(0, BATCH_SIZE)
}

async function markSynced(id: string): Promise<void> {
  await getDb().outbox.update(id, { syncedAt: jetztIso() })
}

async function markFailed(id: string, error: string): Promise<void> {
  const db = getDb()
  const e = await db.outbox.get(id)
  if (!e) return
  // put (statt update) sorgt dafür, dass `quarantinedAt` (falls schon
  // gesetzt) erhalten bleibt. Dexie's `update` ist zwar partial, aber
  // in Kombination mit dem späteren `quarantine`-put kann es zu
  // seltsamen Reihenfolgen kommen — wir schreiben lieber gleich den
  // ganzen Record neu.
  await db.outbox.put({
    id: e.id,
    entity: e.entity,
    op: e.op,
    payload: e.payload,
    createdAt: e.createdAt,
    syncedAt: e.syncedAt,
    attempts: e.attempts + 1,
    lastError: error,
    quarantinedAt: e.quarantinedAt,
    quarantineReason: e.quarantineReason,
  })
}

/**
 * Markiert ein Outbox-Item als stillgelegt. Der Worker pusht es nicht
 * mehr automatisch; die UI muss es manuell freigeben oder verwerfen.
 */
async function quarantine(id: string, reason: string): Promise<void> {
  const db = getDb()
  const e = await db.outbox.get(id)
  if (!e) return
  await db.outbox.put({
    id: e.id,
    entity: e.entity,
    op: e.op,
    payload: e.payload,
    createdAt: e.createdAt,
    syncedAt: e.syncedAt,
    attempts: e.attempts,
    lastError: e.lastError,
    quarantinedAt: jetztIso(),
    quarantineReason: reason,
  })
}

async function quarantinedCount(): Promise<number> {
  const all = await getDb().outbox.toArray()
  return all.filter((o) => o.quarantinedAt != null).length
}

async function collectQuarantinedItems(limit: number): Promise<QuarantinedItem[]> {
  const all = await getDb().outbox.orderBy('createdAt').toArray()
  const quar = all.filter((o) => o.quarantinedAt != null)
  const out: QuarantinedItem[] = []
  for (const o of quar.slice(0, limit)) {
    let payloadId = ''
    try {
      const parsed = JSON.parse(o.payload) as unknown
      payloadId = payloadIdFor(o.entity, parsed) ?? ''
    } catch {
      // korrupte payload
    }
    out.push({
      outboxId: o.id,
      entity: o.entity,
      op: o.op,
      payloadId,
      attempts: o.attempts,
      lastError: o.lastError,
      quarantinedAt: o.quarantinedAt ?? '',
      quarantineReason: o.quarantineReason ?? '',
      createdAt: o.createdAt,
    })
  }
  return out
}

async function quarantinedSnapshot(): Promise<{
  quarantined: number
  quarantinedItems: QuarantinedItem[]
}> {
  const [quar, items] = await Promise.all([quarantinedCount(), collectQuarantinedItems(10)])
  return { quarantined: quar, quarantinedItems: items }
}

async function syncCountPatch(): Promise<
  Pick<SyncStatus, 'pending' | 'unresolved' | 'quarantined' | 'quarantinedItems'>
> {
  const [pending, q] = await Promise.all([pendingCount(), quarantinedSnapshot()])
  return {
    pending,
    unresolved: pending + q.quarantined,
    quarantined: q.quarantined,
    quarantinedItems: q.quarantinedItems,
  }
}

/**
 * Setzt alle Outbox-Items zurück (attempts=0, lastError=null), die wegen
 * eines abgelaufenen Tokens als failed markiert wurden. syncedAt bleibt
 * unangetastet (sind eh noch nicht gepusht). Nach erfolgreichem Re-Login
 * werden sie beim nächsten Sync-Lauf wieder gepusht.
 *
 * Quarantinierte Items bleiben quarantiniert — der Auth-Reset ist kein
 * Freigabe-Anlass.
 */
async function resetOutboxAfterAuthRevoked(): Promise<void> {
  const all = await getDb().outbox.toArray()
  for (const o of all) {
    if (
      o.syncedAt === null &&
      o.quarantinedAt == null &&
      (o.attempts > 0 || o.lastError !== null)
    ) {
      await getDb().outbox.update(o.id, { attempts: 0, lastError: null })
    }
  }
}

/**
 * Liest die ersten N Outbox-Items mit lastError, die noch nicht synced
 * und nicht quarantiniert sind. Dient als Diagnose für die UI:
 * "Was genau hängt?". Quarantinierte Items werden separat über
 * `collectQuarantinedItems` aufgelistet.
 */
async function collectStuckItems(limit = 5): Promise<SyncLastFailure['stuckItems']> {
  const all = await getDb().outbox.orderBy('createdAt').toArray()
  const stuck = all.filter((o) => o.syncedAt == null && o.quarantinedAt == null && o.lastError)
  const out: SyncLastFailure['stuckItems'] = []
  for (const o of stuck.slice(0, limit)) {
    let payloadId = ''
    try {
      const parsed = JSON.parse(o.payload) as unknown
      payloadId = payloadIdFor(o.entity, parsed) ?? ''
    } catch {
      // korrupte payload — Diagnose zeigt leere ID
    }
    out.push({
      outboxId: o.id,
      entity: o.entity,
      op: o.op,
      payloadId,
      attempts: o.attempts,
      lastError: o.lastError,
      createdAt: o.createdAt,
    })
  }
  return out
}

function syncErrorFingerprint(
  source: SyncFailureSource,
  code: string,
  status: number | null,
  message: string,
): string {
  const normalized = message.replace(/\s+/g, ' ').trim().slice(0, 180)
  return `${source ?? 'unknown'}:${code}:${status ?? 0}:${normalized}`
}

// ---------- Snapshot-Merge ----------

export async function applySnapshot(snap: SyncSnapshot): Promise<void> {
  const db = getDb()
  await db.transaction(
    'rw',
    [
      db.artikel,
      db.standorte,
      db.commission,
      db.buchungen,
      db.einstellungen,
      db.mindestbestandEreignisse,
    ],
    async () => {
      // Artikel
      for (const a of snap.artikel) {
        const existing = await db.artikel.get(a.id)
        if (!existing) {
          await db.artikel.add(a)
        } else if ((a.geaendertAm ?? '') > (existing.geaendertAm ?? '')) {
          await db.artikel.put(a)
        }
      }
      // Standorte
      for (const s of snap.standorte) {
        const existing = await db.standorte.get(s.id)
        if (!existing) {
          await db.standorte.add(s)
        } else if ((s.geaendertAm ?? '') > (existing.geaendertAm ?? '')) {
          await db.standorte.put(s)
        }
      }
      // Projekte
      for (const p of snap.commission) {
        const existing = await db.commission.get(p.id)
        if (!existing) {
          await db.commission.add(p)
        } else if ((p.geaendertAm ?? '') > (existing.geaendertAm ?? '')) {
          await db.commission.put(p)
        }
      }
      // Buchungen — append-only, nur insert wenn unbekannt
      for (const b of snap.buchungen) {
        const existing = await db.buchungen.get(b.id)
        if (!existing) await db.buchungen.add(b)
      }
      // Einstellungen — LWW auf geaendertAm, Identität = (key, userId).
      // IndexedDB-Konvention: null in userId wird als '' indexiert.
      for (const e of snap.einstellungen) {
        const indexedUserId = e.userId === null ? '' : e.userId
        const existing = await db.einstellungen.get([e.key, indexedUserId])
        if (!existing) {
          await db.einstellungen.add({ ...e, userId: indexedUserId })
        } else if (e.geaendertAm > existing.geaendertAm) {
          await db.einstellungen.put({ ...e, userId: indexedUserId })
        }
      }
      // Mindestbestand-Ereignisse — append-only, kein LWW.
      // Identität = `id` (UUID). Wenn der Server die gleiche UUID nochmal
      // schickt (z. B. nach `clearLocalDbAndPull`), wird der Eintrag
      // einfach überschrieben — id-basiertes `put` ist hier ok.
      for (const e of snap.mindestbestandEreignisse ?? []) {
        await db.mindestbestandEreignisse.put(e)
      }
    },
  )

  // serverTime als lastPull speichern (für nächste Inkremental-Sync).
  // Diese beiden Marker sind global (userId=null) und nur Client-lokal —
  // sie werden NICHT zum Server gepusht.
  const now = jetztIso()
  await getDb().einstellungen.put({
    key: 'sync.lastPullAt',
    userId: '',
    value: snap.serverTime,
    geaendertAm: now,
  })
  await getDb().einstellungen.put({
    key: 'sync.lastPushAt',
    userId: '',
    value: snap.serverTime,
    geaendertAm: now,
  })
  // Marker für Mindestbestand-Ereignis-Snapshot: nur setzen, wenn der
  // Snapshot auch Events geliefert hat. Sonst würden wir einen
  // `mindestSince` vom Default-Wert auf den Server-Time setzen, obwohl
  // wir gar nicht wissen, ob alle bis dahin ausgelösten Events
  // enthalten waren. Wenn `mindestSince` vom Server nicht
  // zurückgespielt wird, fallen wir auf `serverTime` zurück — der
  // Server-Time ist die "sichere" Wahl, weil der Server bei einem
  // späteren Pull garantiert alle Events >= `serverTime` liefert.
  if ((snap.mindestbestandEreignisse?.length ?? 0) > 0) {
    await getDb().einstellungen.put({
      key: 'mindestbestand.lastPullAt',
      userId: '',
      value: snap.mindestSince ?? snap.serverTime,
      geaendertAm: now,
    })
  }
}

// ---------- Sync-Hauptaufruf ----------

/**
 * Stillgelegt ein Outbox-Item, wenn der Server es dauerhaft ablehnt.
 * Bedingungen:
 *  - Fehler-Code in HARD_QUARANTINE_CODES (z. B. unbekannte Referenz)
 *  - ODER attempts hat QUARANTINE_THRESHOLD erreicht
 * Idempotent: bereits quarantinierte Items werden nicht doppelt markiert.
 */
async function maybeQuarantine(
  outboxId: string,
  row: OutboxEintrag | undefined,
  errorCode: string,
): Promise<void> {
  if (!row || row.quarantinedAt !== null) return
  const hard = HARD_QUARANTINE_CODES.has(errorCode)
  const exhausted = row.attempts >= QUARANTINE_THRESHOLD
  if (hard || exhausted) {
    const reason = hard
      ? `Server lehnt dauerhaft ab (${errorCode})`
      : `Nach ${row.attempts} Fehlversuchen stillgelegt`
    await quarantine(outboxId, reason)
  }
}

export async function runSync(opts: { token: string | null; apiBase: string }): Promise<void> {
  // While the worker is stopped (e.g. during the admin local-DB reset) NO
  // sync may run — it would immediately reopen the freshly wiped IndexedDB
  // and partly refill it.
  if (_paused) return
  if (_running) return

  const runToken = ++_runToken
  const timeoutToken = runToken + 1
  _running = true
  _runAbort = new AbortController()
  const signal = _runAbort.signal

  const safeUpdate = (patch: Partial<SyncStatus>): void => {
    if (_runToken === runToken) updateStatus(patch)
  }
  const setStep = (step: SyncStep): void => {
    safeUpdate({ lastStep: step, lastStepAt: jetztIso() })
  }

  _watchdogHandle = setTimeout(() => {
    if (_runToken !== runToken || !_running) return
    const err = new SyncTimeoutError(`Sync-Lauf nach ${RUN_TIMEOUT_MS}ms abgebrochen`)
    const at = jetztIso()
    const backoffMs = computeBackoffMs(_consecutiveFailures + 1)
    const nextRetryAt = backoffMs > 0 ? new Date(Date.now() + backoffMs).toISOString() : null

    _runToken = timeoutToken
    _running = false
    if (_watchdogHandle) {
      clearTimeout(_watchdogHandle)
      _watchdogHandle = null
    }
    _runAbort?.abort(err)
    _runAbort = null
    console.error('[sync]', err)
    _consecutiveFailures += 1
    updateStatus({
      status: 'error',
      lastError: err.message,
      lastFailure: {
        at,
        source: 'network',
        status: null,
        code: 'SYNC_TIMEOUT',
        message: err.message,
        retryAfterMs: null,
        rejectedItems: 0,
        sampleErrors: [],
        stuckItems: [],
      },
      lastStep: 'timeout',
      lastStepAt: at,
      lastErrorCode: 'SYNC_TIMEOUT',
      lastErrorAt: at,
      lastErrorFingerprint: syncErrorFingerprint('network', 'SYNC_TIMEOUT', null, err.message),
      nextRetryAt,
    })
    void Promise.all([
      syncCountPatch().catch(() => ({
        pending: _status.pending,
        unresolved: _status.unresolved,
        quarantined: _status.quarantined,
        quarantinedItems: _status.quarantinedItems,
      })),
      getLocalCounts().catch(() => _status.localCounts),
      collectStuckItems(5).catch(() => []),
    ]).then(([counts, localCounts, stuckItems]) => {
      if (_runToken !== timeoutToken) return
      updateStatus({
        ...counts,
        localCounts,
        lastFailure: {
          at,
          source: 'network',
          status: null,
          code: 'SYNC_TIMEOUT',
          message: err.message,
          retryAfterMs: null,
          rejectedItems: 0,
          sampleErrors: [],
          stuckItems,
        },
      })
    })
  }, RUN_TIMEOUT_MS)

  const { token, apiBase } = opts
  const session = sessionLesen()
  const currentUserId = session?.userId ?? null

  // Must run before `lastPull` is read: an admin promotion clears the
  // marker so this run fetches a full snapshot (including prices).
  try {
    await prepareRoleForSync(session?.rolle === 'admin')
  } catch (e) {
    console.warn('[sync] role preparation failed:', e)
  }

  const lastPull = (await getDb().einstellungen.get(['sync.lastPullAt', '']))?.value ?? null

  try {
    safeUpdate({ status: 'syncing', lastStep: 'prepare', lastStepAt: jetztIso() })
    // Latch: merkt, ob der Push-Handler Items abgelehnt hat.
    // Wird im success-Pfad genutzt, um den Status auf 'error' zu
    // belassen und die Diagnose nicht wegzuschmeißen.
    let hadPartialRejection = false

    // 1) Push
    setStep('push')
    const batch = await nextBatch()
    if (batch.length > 0) {
      // Wir behalten für jedes Item den Outbox-Eintrag, damit wir hinterher
      // die richtige outbox.id markieren können. Der Server antwortet mit
      // `op.payload.id` (Domain-UUID) — nicht mit der Outbox-UUID.
      const items: Array<{ outboxId: string; payloadId: string }> = []
      const ops: Array<{ op: OutboxOp; entity: OutboxEintrag['entity']; payload: unknown }> = []
      for (const o of batch) {
        let payload: unknown
        try {
          payload = JSON.parse(o.payload)
        } catch (e) {
          // Korrupte Outbox-Zeile — markieren und überspringen.
          await markFailed(o.id, `CORRUPT_PAYLOAD: ${e instanceof Error ? e.message : String(e)}`)
          continue
        }
        const payloadId = payloadIdFor(o.entity, payload)
        if (payloadId === null) {
          await markFailed(o.id, 'MISSING_PAYLOAD_ID')
          continue
        }
        // Einstellungen pro User dürfen nur vom authentifizierten User
        // gepusht werden. Eine fremde userId würde vom Server mit
        // "Eine fremde User-ID ist nicht erlaubt" abgelehnt
        // (server/src/sync/resolver.ts:resolveEinstellung). Wir pushen
        // solche Items nicht (vermeidet PARTIAL_REJECTED + Endlos-Retry)
        // und markieren sie stattdessen lokal als fehlgeschlagen, damit
        // sie in der Sync-Diagnose sichtbar bleiben und beim nächsten
        // Login des passenden Users erneut pushbar sind.
        if (o.entity === 'einstellung') {
          const p = payload as { key?: unknown; userId?: unknown }
          const puid = p.userId
          if (
            puid !== null &&
            puid !== undefined &&
            puid !== '' &&
            String(puid) !== currentUserId
          ) {
            const row = await getDb().outbox.get(o.id)
            if (row) {
              await getDb().outbox.put({
                ...row,
                lastError: `VALIDATION: einstellung.userId gehört zu einem anderen Nutzer`,
              })
            }
            continue
          }
        }
        items.push({ outboxId: o.id, payloadId })
        ops.push({ op: o.op, entity: o.entity, payload })
      }
      if (ops.length > 0) {
        try {
          const result = await pushOps(apiBase, token, ops, signal)
          if (_runToken !== runToken) return
          const acceptedIds = new Set(result.accepted)
          const skippedIds = new Set((result.skipped ?? []).map((s) => s.id))
          const conflictsById = new Map(result.conflicts.map((c) => [c.id, c.reason]))
          const errorsById = new Map(
            result.errors.map((e) => [e.id, { code: e.code, msg: `${e.code}: ${e.message}` }]),
          )
          // Diagnose: sammle die ersten paar Server-Fehler, damit die UI
          // zeigen kann, WARUM der Server das Item abgelehnt hat. Bei
          // INTERNAL-Fehlern reichen wir `stack` und `payload` 1:1
          // durch — das ist der einzige Weg, einen serverseitigen Bug
          // aus der PWA-Diagnose heraus zu debuggen.
          const sampleErrors: SyncLastFailure['sampleErrors'] = result.errors
            .slice(0, 3)
            .map((e) => ({
              id: e.id,
              code: e.code,
              message: e.message,
              ...(e.code === 'INTERNAL' ? { stack: e.stack, payload: e.payload } : {}),
              ...(typeof e.currentBestand === 'number' ? { currentBestand: e.currentBestand } : {}),
            }))
          const lastPushDiagnosis: Pick<SyncLastFailure, 'rejectedItems' | 'sampleErrors'> = {
            rejectedItems: result.conflicts.length + result.errors.length,
            sampleErrors,
          }
          for (const it of items) {
            const outboxRow = await getDb().outbox.get(it.outboxId)
            if (acceptedIds.has(it.payloadId) || skippedIds.has(it.payloadId)) {
              await markSynced(it.outboxId)
            } else if (conflictsById.has(it.payloadId)) {
              // Quarantäne VOR markFailed — wenn das Item quarantiniert
              // wird, überschreibt das nachfolgende markFailed sonst die
              // quarantinedAt-Felder (Dexie's `update` würde das eigentlich
              // behalten, aber sicherheitshalber so rum).
              await maybeQuarantine(it.outboxId, outboxRow, 'CONFLICT')
              await markFailed(it.outboxId, `CONFLICT: ${conflictsById.get(it.payloadId)}`)
            } else if (errorsById.has(it.payloadId)) {
              const err = errorsById.get(it.payloadId)
              await maybeQuarantine(it.outboxId, outboxRow, err?.code ?? 'ERROR')
              await markFailed(it.outboxId, err?.msg ?? 'ERROR')
            }
            // Wenn der Server das Item weder in accepted noch in conflicts/errors
            // erwähnt, lassen wir es unangetastet — kein Hinweis auf Erfolg oder
            // Misserfolg, also besser nicht voreilig markieren.
          }
          // Wenn der Server einige Items abgelehnt hat, aber der Push insgesamt
          // 200 war, ist das ein "partieller Erfolg". Das ist KEIN fataler
          // Fehler — der Worker läuft normal weiter. Wir hängen die Diagnose
          // aber an den Status, damit die UI sie sehen kann.
          if (lastPushDiagnosis.rejectedItems > 0) {
            hadPartialRejection = true
            const msg = `Server hat ${lastPushDiagnosis.rejectedItems} von ${items.length} Items abgelehnt`
            const at = jetztIso()
            const stuckItems = await collectStuckItems(5)
            const counts = await syncCountPatch()
            safeUpdate({
              lastError: msg,
              lastFailure: {
                at,
                source: 'push',
                status: 200,
                code: 'PARTIAL_REJECTED',
                message: msg,
                retryAfterMs: null,
                ...lastPushDiagnosis,
                stuckItems,
              },
              ...counts,
              lastStep: 'push',
              lastStepAt: at,
              lastErrorCode: 'PARTIAL_REJECTED',
              lastErrorAt: at,
              lastErrorFingerprint: syncErrorFingerprint('push', 'PARTIAL_REJECTED', 200, msg),
            })
          }
        } catch (e) {
          if (_runToken !== runToken) return
          // Gesamter Push fehlgeschlagen (z. B. Netzwerk oder HTTP-Fehler).
          const http = e instanceof SyncHttpError ? e : null
          const timeout = e instanceof SyncTimeoutError ? e : null
          const msg = e instanceof Error ? e.message : String(e)
          const at = jetztIso()
          const source: SyncFailureSource = http ? 'push' : 'network'
          const code = timeout ? 'SYNC_TIMEOUT' : (http?.category ?? 'NETWORK')
          for (const it of items) await markFailed(it.outboxId, msg)
          const stuckItems = await collectStuckItems(5)
          const counts = await syncCountPatch()
          safeUpdate({
            lastError: msg,
            lastFailure: {
              at,
              source,
              status: http?.status ?? null,
              code,
              message: msg,
              retryAfterMs: http?.retryAfterMs ?? null,
              rejectedItems: 0,
              sampleErrors: [],
              stuckItems,
            },
            ...counts,
            lastErrorCode: code,
            lastErrorAt: at,
            lastErrorFingerprint: syncErrorFingerprint(source, code, http?.status ?? null, msg),
          })
          throw e
        }
      }
    }

    // 2) Pull
    // Mindestbestand-Marker lesen: Default = "Anbeginn der Zeit" =
    //    komplettes Event-Set. Der Client schickt seinen letzten
    //    Event-Timestamp, um nur die Änderungen zu ziehen.
    setStep('snapshot')
    const lastMindestPull =
      (await getDb().einstellungen.get(['mindestbestand.lastPullAt', '']))?.value ?? null
    const snap = await fetchSnapshot(
      apiBase,
      token,
      lastPull ?? '1970-01-01T00:00:00.000Z',
      lastMindestPull ?? '1970-01-01T00:00:00.000Z',
      signal,
    )
    if (_runToken !== runToken) return
    await applySnapshot(snap)
    if (_runToken !== runToken) return

    // 3) Server-Status für Divergenz-Anzeige holen
    let serverCounts: TableCounts | null = _status.serverCounts
    let serverTime: string | null = _status.serverTime
    setStep('serverStatus')
    try {
      const st = await fetchServerStatus(apiBase, token, signal)
      if (_runToken !== runToken) return
      serverCounts = st.counts
      serverTime = st.serverTime
    } catch {
      // Counts sind nur Anzeige – Fehler hier sind nicht kritisch.
    }

    setStep('counts')
    let localCounts: TableCounts = await getLocalCounts()
    if (_runToken !== runToken) return

    // 4) Self-Healing: Wenn der inkrementelle Pull nichts brachte, aber
    //    der Server in mindestens einer Tabelle mehr Zeilen hat als
    //    lokal, ist der `lastPullAt`-Marker falsch (z. B. Client/Server-
    //    Clock-Drift, Artikel mit `geaendertAm` vor dem ersten Pull,
    //    oder eine Race-Condition zwischen Push und Pull). Wir löschen
    //    den Marker und holen den vollen Snapshot. Einmaliger Vorgang pro
    //    Sync-Lauf, damit wir nicht in einer Endlosschleife landen, falls
    //    der Server tatsächlich konsistent leer ist (lokal=server=0).
    if (
      lastPull !== null &&
      serverCounts !== null &&
      zaehleAbweichungen(localCounts, serverCounts) > 0 &&
      // Nur heilen, wenn der gerade ausgeführte Pull nichts geliefert
      // hat. Wenn der Pull Daten brachte und es trotzdem noch Lücken
      // gibt, ist das ein echter Konflikt (LWW) — kein Marker-Problem.
      snap.artikel.length === 0 &&
      snap.standorte.length === 0 &&
      snap.commission.length === 0 &&
      snap.buchungen.length === 0 &&
      snap.einstellungen.length === 0
    ) {
      console.warn(
        '[sync] self-healing: lastPullAt ungültig — Server hat mehr Zeilen als lokal, ' +
          'Pull lieferte nichts. Setze Marker zurück und hole vollen Snapshot.',
        { lastPull, localCounts, serverCounts },
      )
      if (_runToken !== runToken) return
      // Marker zurücksetzen: `value = ''` lässt runSync beim nächsten Lauf
      // `lastPull` als `null` lesen (siehe `?? null` weiter oben) und damit
      // den vollen Snapshot ziehen. Wir löschen NICHT die Zeile, weil
      // applySnapshot die Zeile sowieso neu schreibt — und `put` mit
      // leerem value ist robuster als `delete` (kein 404, kein Schema-Drift).
      await getDb().einstellungen.put({
        key: 'sync.lastPullAt',
        userId: '',
        value: '',
        geaendertAm: jetztIso(),
      })
      if (_runToken !== runToken) return
      const fullSnap = await fetchSnapshot(apiBase, token, '', '1970-01-01T00:00:00.000Z', signal)
      if (_runToken !== runToken) return
      await applySnapshot(fullSnap)
      if (_runToken !== runToken) return
      // Counts nach Heilung neu holen.
      try {
        const st = await fetchServerStatus(apiBase, token, signal)
        if (_runToken !== runToken) return
        serverCounts = st.counts
        serverTime = st.serverTime
      } catch {
        // Counts sind nur Anzeige.
      }
      // localCounts neu holen, sonst zeigt das Sync-Panel weiter die
      // alten (zu niedrigen) Werte, bis der nächste Tick läuft.
      try {
        localCounts = await getLocalCounts()
      } catch {
        // Counts sind nur Anzeige.
      }
    }

    if (_runToken !== runToken) return
    const notSavedRows = await getDb()
      .buchungen.filter((b) => b.nichtGespeichert === true)
      .count()
    const stillPending = await pendingCount()
    // Never reconcile while own writes are still queued: those bookings are
    // legitimately absent from the server yet and must not be flagged.
    const needsFullReconcile =
      stillPending === 0 &&
      serverCounts !== null &&
      localCounts !== null &&
      serverCounts.buchungen < localCounts.buchungen - notSavedRows
    if (stillPending === 0 && (needsFullReconcile || notSavedRows > 0)) {
      setStep('reconcile')
      await reconcileBookings(apiBase, token, signal, needsFullReconcile)
      if (_runToken !== runToken) return
    }

    const counts = await syncCountPatch()
    if (_runToken !== runToken) return
    const finishedAt = jetztIso()
    safeUpdate({
      status: hadPartialRejection ? 'error' : 'idle',
      lastSyncAt: finishedAt,
      // lastError/lastFailure nur zurücksetzen, wenn der aktuelle
      // Zyklus keine Ablehnung hatte (und der catch-Block sie nicht
      // schon wegen eines späteren Fehlers überschrieben hat).
      lastError: hadPartialRejection ? _status.lastError : null,
      lastFailure: hadPartialRejection ? _status.lastFailure : null,
      ...counts,
      serverCounts,
      serverTime,
      localCounts,
      nextRetryAt: null,
      lastStep: 'done',
      lastStepAt: finishedAt,
      lastErrorCode: hadPartialRejection ? _status.lastErrorCode : null,
      lastErrorAt: hadPartialRejection ? _status.lastErrorAt : null,
      lastErrorFingerprint: hadPartialRejection ? _status.lastErrorFingerprint : null,
    })
    _consecutiveFailures = 0
    // Erfolgreicher Push beweist: Token ist wieder gültig (oder war es die
    // ganze Zeit, z. B. nach manuellem Re-Login). Latch lösen.
    _authRevokedNotified = false
  } catch (e) {
    if (_runToken !== runToken) return
    const msg = e instanceof Error ? e.message : String(e)
    let localCounts: TableCounts | null = _status.localCounts
    try {
      localCounts = await getLocalCounts()
    } catch {
      // Counts sind nur Anzeige – Fehler hier sind nicht kritisch.
    }
    if (_runToken !== runToken) return

    const isNetwork = /Failed to fetch|NetworkError|fetch|load failed/i.test(msg)
    const http = e instanceof SyncHttpError ? e : null
    const timeout = e instanceof SyncTimeoutError ? e : null

    _consecutiveFailures++
    const backoffMs = computeBackoffMs(_consecutiveFailures)
    // Retry-After hat Vorrang, wenn der Server ihn gesetzt hat.
    const waitMs = http?.retryAfterMs ?? backoffMs
    const nextRetryAt = waitMs > 0 ? new Date(Date.now() + waitMs).toISOString() : null

    // Diagnose: nur setzen, wenn der innere Push-Handler es nicht schon getan
    // hat (partieller Erfolg mit Server-Rejects). Sonst überschreiben wir
    // dessen Source/Code mit der hier beobachteten Information.
    const existingFailure = _status.lastFailure
    const at = jetztIso()
    const source: SyncFailureSource =
      existingFailure?.source ?? (timeout || isNetwork ? 'network' : 'snapshot')
    const code = timeout ? 'SYNC_TIMEOUT' : (http?.category ?? (isNetwork ? 'NETWORK' : 'UNKNOWN'))
    const newFailure: SyncLastFailure = {
      at,
      source,
      status: http?.status ?? null,
      code,
      message: msg,
      retryAfterMs: http?.retryAfterMs ?? null,
      rejectedItems: existingFailure?.rejectedItems ?? 0,
      sampleErrors: existingFailure?.sampleErrors ?? [],
      stuckItems: await collectStuckItems(5),
    }
    if (_runToken !== runToken) return
    const counts = await syncCountPatch()
    if (_runToken !== runToken) return
    const failurePatch: Partial<SyncStatus> = {
      lastError: msg,
      ...counts,
      localCounts,
      lastFailure: newFailure,
      lastErrorCode: code,
      lastErrorAt: at,
      lastErrorFingerprint: syncErrorFingerprint(source, code, newFailure.status, msg),
    }

    if (isNetwork) {
      safeUpdate({
        ...failurePatch,
        status: 'offline',
        nextRetryAt,
      })
    } else if (http?.category === 'origin-unavailable') {
      // 5xx: Server/Origin ist down — kein Punkt, alle 30s zu hämmern.
      safeUpdate({
        ...failurePatch,
        status: 'origin-unavailable',
        nextRetryAt,
      })
    } else if (http?.category === 'auth') {
      // Token abgelaufen o. ä. — User muss sich neu einloggen.
      // Outbox-Items NICHT weiter hochzählen, sonst rennt die Loop
      // endlos mit attempts=200+. Wir setzen den nextRetryAt auf null
      // (Worker pausiert, bis der User manuell re-synct), schicken
      // einen Auth-Reset-Callback an die App, und resetten lastError/
      // attempts/lastError der Outbox-Items (sie sind nicht wirklich
      // kaputt — der Token ist es).
      await resetOutboxAfterAuthRevoked()
      if (_runToken !== runToken) return
      safeUpdate({
        ...failurePatch,
        status: 'error',
        lastError: 'Sitzung abgelaufen — bitte neu anmelden.',
        nextRetryAt: null,
      })
      // Callback NUR aufrufen, wenn er noch nicht im aktuellen
      // Auth-Invalid-Zyklus gefeuert wurde. Verhindert Endlos-Trigger,
      // falls die App den Worker nicht stoppt.
      if (!_authRevokedNotified) {
        _authRevokedNotified = true
        // Schutz: bei erfolgreichem Push zurücksetzen.
        try {
          _onAuthRevoked?.()
        } catch (e) {
          console.error('onAuthRevoked callback failed:', e)
        }
      }
    } else {
      safeUpdate({
        ...failurePatch,
        status: 'error',
        nextRetryAt,
      })
    }
  } finally {
    if (_runToken === runToken) {
      if (_watchdogHandle !== null) {
        clearTimeout(_watchdogHandle)
        _watchdogHandle = null
      }
      _runAbort = null
      _running = false
      if (_rerunRequested) {
        const opts = _rerunOpts
        _rerunRequested = false
        _rerunOpts = null
        if (opts) void runSync(opts)
      }
    }
  }
}

// ---------- Manueller Sync + Status-Refresh ----------

/**
 * Triggert einen Sync-Lauf sofort (Push + Pull + Server-Status).
 * Kein Effekt, wenn gerade schon ein Sync läuft.
 * Backoff wird ignoriert — der User hat explizit geklickt.
 */
export async function triggerSyncNow(opts: {
  token: string | null
  apiBase: string
}): Promise<void> {
  _consecutiveFailures = 0
  updateStatus({ nextRetryAt: null })
  if (_running) {
    _rerunRequested = true
    _rerunOpts = opts
    return
  }
  await runSync(opts)
}

/**
 * Holt frische Server-Counts, ohne einen vollen Sync zu fahren.
 * Aktualisiert auch die lokalen Counts.
 */
export async function refreshStatus(opts: {
  token: string | null
  apiBase: string
}): Promise<void> {
  let localCounts: TableCounts | null = _status.localCounts
  let serverCounts: TableCounts | null = _status.serverCounts
  let serverTime: string | null = _status.serverTime
  let lastError: string | null = null

  try {
    localCounts = await getLocalCounts()
  } catch {
    // s. o.
  }

  try {
    const st = await fetchServerStatus(opts.apiBase, opts.token)
    serverCounts = st.counts
    serverTime = st.serverTime
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e)
  }

  updateStatus({
    localCounts,
    serverCounts,
    serverTime,
    lastError,
    ...(await syncCountPatch()),
  })
}

// ---------- Worker-Lifecycle ----------

export interface WorkerOptions {
  apiBase: string
  /** Funktion, die das aktuelle JWT liefert (z. B. aus Pinia-Store). */
  getToken: () => string | null
  /** Sync-Intervall in Sekunden. */
  intervalSek?: number
  /**
   * Wird aufgerufen, wenn der Server einen 401 liefert — Token ist abgelaufen
   * oder ungültig. Hier sollte der Auth-Store zurückgesetzt und ggf. zur
   * Login-View navigiert werden. Wird maximal einmal pro Auth-Invalid-Zyklus
   * gefeuert, damit sich der Sync-Worker nicht selbst verstrickt.
   */
  onAuthRevoked?: () => void
}

export function startSyncWorker(opts: WorkerOptions): void {
  if (_intervalHandle) return
  if (_suspended) return
  _paused = false
  setApiBaseUrl(opts.apiBase)
  _onAuthRevoked = opts.onAuthRevoked ?? null
  const intervalMs = (opts.intervalSek ?? 30) * 1000

  const tick = () => {
    if (_paused) return
    if (_running) return
    // Respektiere Backoff: wenn der letzte Lauf ein `nextRetryAt` gesetzt
    // hat, das in der Zukunft liegt, überspringen wir den Tick.
    if (_status.nextRetryAt) {
      const next = Date.parse(_status.nextRetryAt)
      if (Number.isFinite(next) && next > Date.now()) return
    }
    void runSync({ token: opts.getToken(), apiBase: opts.apiBase })
  }
  _intervalHandle = setInterval(tick, intervalMs)

  // Online-Event: Retry sofort versuchen, wenn der Origin wieder da ist.
  _onlineHandler = () => {
    if (_status.status === 'offline' || _status.status === 'origin-unavailable') {
      // Backoff zurücksetzen, damit wir nicht erst auf den nächsten Tick warten.
      _consecutiveFailures = 0
      updateStatus({ nextRetryAt: null })
    }
    tick()
  }
  window.addEventListener('online', _onlineHandler)
  _visibilityHandler = () => {
    if (document.visibilityState === 'visible') tick()
  }
  document.addEventListener('visibilitychange', _visibilityHandler)

  // Initial-Push nach kurzer Verzögerung (App-Boot)
  _bootHandle = setTimeout(tick, 2_000)
}

/**
 * Stops the worker completely: interval, boot timer AND the
 * `online`/`visibilitychange` listeners are removed.
 *
 * Removing the listeners is essential — a lingering `visibilitychange`
 * (tab switch during an admin reset) would otherwise start a sync that
 * immediately reopens and refills the database that was just wiped.
 * `_paused` is the additional hard latch: even an already-queued event can
 * no longer trigger a sync.
 */
export function stopSyncWorker(): void {
  if (_intervalHandle) {
    clearInterval(_intervalHandle)
    _intervalHandle = null
  }
  if (_bootHandle !== null) {
    clearTimeout(_bootHandle)
    _bootHandle = null
  }
  if (_onlineHandler) {
    window.removeEventListener('online', _onlineHandler)
    _onlineHandler = null
  }
  if (_visibilityHandler) {
    document.removeEventListener('visibilitychange', _visibilityHandler)
    _visibilityHandler = null
  }
  abortRunningSync('Sync-Worker gestoppt')
  _paused = true
}

/**
 * Invalidates the current run token and aborts its signal so an in-flight
 * sync stops at the next guard instead of continuing against a stopped /
 * suspended worker.
 */
function abortRunningSync(reason: string): void {
  if (!_runAbort) return
  _runToken += 1
  _running = false
  _rerunRequested = false
  _rerunOpts = null
  if (_watchdogHandle !== null) {
    clearTimeout(_watchdogHandle)
    _watchdogHandle = null
  }
  const controller = _runAbort
  _runAbort = null
  controller.abort(new SyncTimeoutError(reason))
}

/**
 * Same as `stopSyncWorker()`, plus a latch that blocks
 * `startSyncWorker()`. Meant for operations that need the local DB
 * exclusively (admin local-database reset): while the latch is set the
 * worker does not restart even if the app kicks it again. The latch is
 * only released by a page reload.
 */
export function suspendSyncWorker(): void {
  stopSyncWorker()
  _suspended = true
}

// ---------- Outbox-Append ----------

export async function queueOp(
  entity: OutboxEintrag['entity'],
  op: OutboxOp,
  payload: unknown,
  /**
   * Optional explicit creation timestamp (ISO). The worker pushes pending
   * items ordered by `createdAt`, and items created in the same millisecond
   * fall back to random primary-key order. The reseed flow needs a
   * deterministic order (master data before bookings, umlagerung halves
   * adjacent), so it may pass strictly increasing timestamps. Default: now.
   */
  createdAtIso?: string,
): Promise<void> {
  await getDb().outbox.add({
    id: neueUuid(),
    entity,
    op,
    payload: JSON.stringify(payload),
    createdAt: createdAtIso ?? jetztIso(),
    syncedAt: null,
    attempts: 0,
    lastError: null,
    quarantinedAt: null,
    quarantineReason: null,
  })
}

/**
 * Gibt ein quarantiniertes Outbox-Item frei. Setzt attempts/lastError
 * zurück und entfernt quarantinedAt. Der Worker pusht es beim nächsten
 * Tick wieder.
 */
export async function releaseQuarantine(outboxId: string): Promise<void> {
  await getDb().outbox.update(outboxId, {
    attempts: 0,
    lastError: null,
    quarantinedAt: null,
    quarantineReason: null,
  })
  updateStatus(await syncCountPatch())
}

/**
 * Verwirft ein quarantiniertes Outbox-Item endgültig. Es wird aus der
 * Outbox entfernt; die zugehörige Domain-Zeile bleibt unverändert.
 */
export async function discardQuarantine(outboxId: string): Promise<void> {
  await getDb().outbox.delete(outboxId)
  updateStatus(await syncCountPatch())
}

// ---------- Test-Helfer ----------

/**
 * Setzt den internen Sync-State (Counter, Status, lastError) zurück.
 * Nur in Tests verwenden.
 */
export function _resetSyncForTests(): void {
  _status = {
    status: 'idle',
    pending: 0,
    unresolved: 0,
    quarantined: 0,
    quarantinedItems: [],
    lastSyncAt: null,
    lastError: null,
    serverCounts: null,
    localCounts: null,
    serverTime: null,
    nextRetryAt: null,
    lastFailure: null,
    lastStep: null,
    lastStepAt: null,
    lastErrorCode: null,
    lastErrorAt: null,
    lastErrorFingerprint: null,
  }
  _consecutiveFailures = 0
  _authRevokedNotified = false
  _onAuthRevoked = null
  _rerunRequested = false
  _rerunOpts = null
  _paused = false
  _suspended = false
  _runToken = 0
  _running = false
  if (_watchdogHandle !== null) {
    clearTimeout(_watchdogHandle)
    _watchdogHandle = null
  }
  if (_runAbort) {
    _runAbort.abort(new SyncTimeoutError('Sync reset for tests'))
    _runAbort = null
  }
  if (_intervalHandle) {
    clearInterval(_intervalHandle)
    _intervalHandle = null
  }
  if (_bootHandle !== null) {
    clearTimeout(_bootHandle)
    _bootHandle = null
  }
  if (_onlineHandler) {
    window.removeEventListener('online', _onlineHandler)
    _onlineHandler = null
  }
  if (_visibilityHandler) {
    document.removeEventListener('visibilitychange', _visibilityHandler)
    _visibilityHandler = null
  }
}

// Hilfsimporte (noUnusedLocals)
