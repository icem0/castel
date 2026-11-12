// Update state document (scripts/update.sh <-> API).
//
// The update itself is executed by an external host-side runner (see
// scripts/update.sh). The API only:
//   - writes the "requested" marker (server.updateState) when an update is
//     requested through the inbound webhook, and
//   - serves the status document written back by update.sh.
//
// There is no updater sidecar container any more. The DB is the channel because
// it survives the API container restart during an update.

import type { FastifyInstance } from 'fastify'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { einstellungen } from '../db/schema.js'

/** Marker-Key in `einstellungen` (globale Zeile, user_id IS NULL). */
export const UPDATE_STATE_KEY = 'server.updateState'

export type UpdatePhase = 'requested' | 'running' | 'done' | 'failed'

export type UpdateState = {
  phase: UpdatePhase
  ok: boolean | null
  exitCode: number | null
  requestedAt: string | null
  startedAt: string | null
  finishedAt: string | null
  step: string | null
  message: string | null
  /** Log-Tail des Update-Laufs. */
  log: string | null
  gitBefore: string | null
  gitAfter: string | null
  versionBefore: string | null
  versionAfter: string | null
  imageTag: string | null
  host: string | null
}

export const EMPTY_UPDATE_STATE: UpdateState = {
  phase: 'requested',
  ok: null,
  exitCode: null,
  requestedAt: null,
  startedAt: null,
  finishedAt: null,
  step: null,
  message: null,
  log: null,
  gitBefore: null,
  gitAfter: null,
  versionBefore: null,
  versionAfter: null,
  imageTag: null,
  host: null,
}

/**
 * Reads a string field out of the state JSON. The runner writes a flat
 * document, so a simple scan is enough - and a broken document must never
 * take the API down.
 *
 * The matcher understands escaped characters (\" \\ \n ...) because the log
 * tail can contain quotes and line breaks.
 */
function stateString(json: string | null, key: string): string | null {
  if (!json) return null
  const match = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`).exec(json)
  if (!match?.[1]) return match?.[1] ?? null
  return unescapeJsonString(match[1])
}

/** Turns the escape sequences of a JSON string into their real characters. */
function unescapeJsonString(value: string): string {
  return value
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
}

function stateNumber(json: string | null, key: string): number | null {
  if (!json) return null
  const match = new RegExp(`"${key}":(-?\\d+)`).exec(json)
  if (!match?.[1]) return null
  const value = Number.parseInt(match[1], 10)
  return Number.isFinite(value) ? value : null
}

function stateBoolean(json: string | null, key: string): boolean | null {
  if (!json) return null
  const match = new RegExp(`"${key}":(true|false|null)`).exec(json)
  if (!match) return null
  if (match[1] === 'null') return null
  return match[1] === 'true'
}

const PHASES: readonly UpdatePhase[] = ['requested', 'running', 'done', 'failed']

/**
 * Parses the state document written by scripts/update.sh. Unknown or broken
 * values fall back to the empty state instead of throwing.
 */
export function parseUpdateState(json: string | null | undefined): UpdateState {
  if (!json) return { ...EMPTY_UPDATE_STATE }
  const rawPhase = stateString(json, 'phase')
  const phase = PHASES.includes(rawPhase as UpdatePhase)
    ? (rawPhase as UpdatePhase)
    : 'requested'
  return {
    phase,
    ok: stateBoolean(json, 'ok'),
    exitCode: stateNumber(json, 'exitCode'),
    requestedAt: stateString(json, 'requestedAt'),
    startedAt: stateString(json, 'startedAt'),
    finishedAt: stateString(json, 'finishedAt'),
    step: stateString(json, 'step'),
    message: stateString(json, 'message'),
    log: stateString(json, 'log'),
    gitBefore: stateString(json, 'gitBefore'),
    gitAfter: stateString(json, 'gitAfter'),
    versionBefore: stateString(json, 'versionBefore'),
    versionAfter: stateString(json, 'versionAfter'),
    imageTag: stateString(json, 'imageTag'),
    host: stateString(json, 'host'),
  }
}

/** Reads the current state from the database. */
export async function readUpdateState(): Promise<UpdateState> {
  const db = getDb()
  const rows = await db
    .select({ value: einstellungen.value })
    .from(einstellungen)
    .where(and(eq(einstellungen.key, UPDATE_STATE_KEY), isNull(einstellungen.userId)))
    .limit(1)
  return parseUpdateState(rows[0]?.value ?? null)
}

/** Writes the state as a global settings row (LWW on geaendert_am). */
export async function writeUpdateState(json: string): Promise<void> {
  const db = getDb()
  await db.execute(sql`
    INSERT INTO einstellungen (key, user_id, value, geaendert_am)
    VALUES (${UPDATE_STATE_KEY}, NULL, ${json}, NOW())
    ON CONFLICT (key) WHERE (user_id IS NULL) DO UPDATE
      SET value = EXCLUDED.value,
          geaendert_am = EXCLUDED.geaendert_am
  `)
}

/** Builds the "update requested" document. */
export function buildRequestDocument(now: string): string {
  return JSON.stringify({
    phase: 'requested',
    ok: null,
    exitCode: null,
    requestedAt: now,
    startedAt: null,
    finishedAt: null,
    step: null,
    message: null,
    log: null,
    gitBefore: null,
    gitAfter: null,
    versionBefore: null,
    versionAfter: null,
    imageTag: null,
    host: null,
  })
}

export async function updateRoutes(app: FastifyInstance): Promise<void> {
  // ---------- GET /api/admin/update/status ----------
  // Admin-only. Read-only diagnostics: phase, log and versions of the last
  // update run, written by scripts/update.sh.
  app.get('/api/admin/update/status', { preHandler: app.requireAdmin }, async (_req, reply) => {
    const state = await readUpdateState()
    return reply.send({ state })
  })
}
