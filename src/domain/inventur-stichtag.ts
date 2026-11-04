// Pure helpers for the inventory cut-off date (`inventur.stichtag`).
//
// The value is an annually repeating calendar date `MM-TT` without a year.
// These rules mirror the server validator (`server/src/domain/inventur.ts`)
// so the PWA never queues an op the server would reject.
//
// Regression background: the settings form had two separate number inputs
// and concatenated them blindly. An untouched day produced `11-00`, the
// server rejected it (`VALIDATION: Tag muss zwischen 1 und 31 liegen`) and
// the poisoned op retried in the outbox until it was quarantined.

/** Discriminated result of assembling a cut-off date from month and day. */
export type StichtagStatus = 'leer' | 'gueltig' | 'unvollstaendig' | 'ungueltig'

export interface StichtagPruefung {
  status: StichtagStatus
  /** Canonical `MM-TT`, only set when `status` is `'gueltig'`. */
  wert: string | null
}

const STICHAG_MUSTER = /^\d{1,2}-\d{1,2}$/

/**
 * Reads one form field. `zahl === null` with `ungueltig === false` means the
 * field is empty; a non-integer or non-numeric entry is reported as invalid so
 * the form can say so instead of writing half of it to the outbox.
 */
function feldWert(wert: unknown): { zahl: number | null; ungueltig: boolean } {
  if (wert === null || wert === undefined) return { zahl: null, ungueltig: false }
  if (typeof wert === 'number') {
    if (!Number.isFinite(wert) || !Number.isInteger(wert)) return { zahl: null, ungueltig: true }
    return { zahl: wert, ungueltig: false }
  }
  if (typeof wert === 'string') {
    const teks = wert.trim()
    if (teks === '') return { zahl: null, ungueltig: false }
    const zahl = Number(teks)
    if (!Number.isFinite(zahl) || !Number.isInteger(zahl)) return { zahl: null, ungueltig: true }
    return { zahl, ungueltig: false }
  }
  return { zahl: null, ungueltig: true }
}

/** True when `monat`/`tag` form a real calendar date (leap years use 2000). */
export function istKalendertag(monat: number, tag: number): boolean {
  if (!Number.isInteger(monat) || monat < 1 || monat > 12) return false
  if (!Number.isInteger(tag) || tag < 1 || tag > 31) return false
  const probe = new Date(Date.UTC(2000, monat - 1, tag))
  return probe.getUTCMonth() === monat - 1 && probe.getUTCDate() === tag
}

/**
 * Assembles the cut-off date from the two form fields.
 *
 * `'leer'` — both fields empty: the setting is cleared ("not set").
 * `'unvollstaendig'` — only one field filled: never write that to the
 * outbox, it is what produced the rejected `11-00` ops.
 */
export function stichtagAusTeilen(monat: unknown, tag: unknown): StichtagPruefung {
  const m = feldWert(monat)
  const t = feldWert(tag)
  if (m.ungueltig || t.ungueltig) return { status: 'ungueltig', wert: null }
  if (m.zahl === null && t.zahl === null) return { status: 'leer', wert: null }
  if (m.zahl === null || t.zahl === null) return { status: 'unvollstaendig', wert: null }
  if (!istKalendertag(m.zahl, t.zahl)) return { status: 'ungueltig', wert: null }
  return {
    status: 'gueltig',
    wert: `${String(m.zahl).padStart(2, '0')}-${String(t.zahl).padStart(2, '0')}`,
  }
}

/**
 * Canonicalises a stored/raw value: returns the padded `MM-TT` form when the
 * value is a real calendar date, `null` otherwise (including `''` and legacy
 * values such as `11-00` written by the old form). A one-digit month/day is
 * accepted on input and padded, because that is the only form the server
 * stores.
 */
export function parseInventurStichtag(wert: unknown): string | null {
  if (typeof wert !== 'string') return null
  const teks = wert.trim()
  if (teks === '') return null
  if (!STICHAG_MUSTER.test(teks)) return null
  const [monatStr, tagStr] = teks.split('-')
  const monat = Number.parseInt(monatStr ?? '', 10)
  const tag = Number.parseInt(tagStr ?? '', 10)
  if (!istKalendertag(monat, tag)) return null
  return `${String(monat).padStart(2, '0')}-${String(tag).padStart(2, '0')}`
}

/** Month and day of a stored value, `null` when nothing is configured. */
export function inventurStichtagTeile(wert: unknown): { monat: number; tag: number } | null {
  const genormt = parseInventurStichtag(wert)
  if (genormt === null) return null
  return {
    monat: Number.parseInt(genormt.slice(0, 2), 10),
    tag: Number.parseInt(genormt.slice(3, 5), 10),
  }
}

/** Formats the stored `MM-TT` for display (day/month, as users expect). */
export function inventurStichtagAnzeige(wert: unknown): string | null {
  const teile = inventurStichtagTeile(wert)
  if (teile === null) return null
  return `${String(teile.tag).padStart(2, '0')}.${String(teile.monat).padStart(2, '0')}.`
}
