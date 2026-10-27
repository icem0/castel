// Live progress for DATANORM imports (SSE).
//
// A 100k-article catalogue takes minutes to import. Without feedback the
// admin cannot tell "still working" from "hung", and a reverse proxy in
// front of the API will happily kill a silent long request. SSE gives the
// upload screen a progress bar and lets us stream the result instead of
// holding one HTTP request open for the whole parse.
//
// Why SSE rather than WebSocket: the flow is strictly one-directional
// (server → browser), SSE rides plain HTTP/2, reconnects on its own, and
// needs no extra protocol upgrade or dependency.
//
// Scope note: progress lives in memory only. If the API restarts mid-import
// the progress is gone — but `datanorm_importe` still holds the final
// outcome, which is what the admin actually needs. Persisting every
// progress tick would be write amplification for a transient UI concern.

import { EventEmitter } from 'node:events'
import type { ImportFortschritt } from './types.js'

/** How long a finished import's progress stays readable. */
const AUFBEWAHRUNG_MS = 5 * 60 * 1000

interface Eintrag {
  emitter: EventEmitter
  letzte: ImportFortschritt | null
  fertig: boolean
  timer: NodeJS.Timeout | null
}

const registry = new Map<string, Eintrag>()

/** Returns the entry for an import, creating it on first access. */
function holeOderErzeuge(importId: string): Eintrag {
  const vorhanden = registry.get(importId)
  if (vorhanden) return vorhanden

  const emitter = new EventEmitter()
  // Many browser tabs may watch one import; the default limit of 10 is
  // uncomfortably low for a shared admin screen.
  emitter.setMaxListeners(50)
  const eintrag: Eintrag = { emitter, letzte: null, fertig: false, timer: null }
  registry.set(importId, eintrag)
  return eintrag
}

/** Registers (or returns the existing) progress channel for an import. */
export function kanalFuer(importId: string): EventEmitter {
  return holeOderErzeuge(importId).emitter
}

/** Publishes a progress tick for an import. */
export function meldeFortschritt(f: ImportFortschritt): void {
  const eintrag = registry.get(f.importId)
  if (!eintrag) return
  eintrag.letzte = f
  eintrag.emitter.emit('fortschritt', f)
}

/**
 * Marks an import as finished so the SSE stream can close cleanly.
 *
 * The entry is created on demand: the browser usually subscribes AFTER
 * the import has already run (the upload runs inline), so the 'fertig'
 * flag has to survive a subscription that comes too late. Without this
 * the stream waited forever and the upload button stayed disabled.
 */
export function meldeFertig(importId: string, fehler?: string): void {
  const eintrag = holeOderErzeuge(importId)
  eintrag.fertig = true
  eintrag.emitter.emit('abschluss', fehler ? { fehler } : {})
  if (eintrag.timer) clearTimeout(eintrag.timer)
  eintrag.timer = setTimeout(() => registry.delete(importId), AUFBEWAHRUNG_MS)
  // Don't hold the process open just for the cleanup timer.
  eintrag.timer.unref?.()
}

/** Last progress seen, so a late subscriber is not left with an empty view. */
export function letzterFortschritt(importId: string): ImportFortschritt | null {
  return registry.get(importId)?.letzte ?? null
}

/** Whether the import already finished (lets a late subscriber close at once). */
export function istFertig(importId: string): boolean {
  return registry.get(importId)?.fertig ?? false
}

/** Test helper: drops all channels. */
export function resetProgressRegistry(): void {
  for (const e of registry.values()) {
    if (e.timer) clearTimeout(e.timer)
    e.emitter.removeAllListeners()
  }
  registry.clear()
}