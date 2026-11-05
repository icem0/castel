// Pure helpers for the inventory cut-off date (`inventur.stichtag`).
//
// The value is a concrete calendar date `DD.MM.YYYY` (with year). These rules
// mirror the server validator (`server/src/domain/inventur.ts`) so the PWA
// never queues an op the server would reject.
//
// Regression background: the settings form had separate inputs and concatenated
// them blindly. An untouched field produced poisoned values such as `11-00`;
// the server rejected them and the op retried in the outbox until quarantined.
// The helpers therefore refuse incomplete and impossible dates and treat
// "all fields empty" as "clear the setting".

/** Discriminated result of assembling a cut-off date from day, month and year. */
export type StichtagStatus = 'leer' | 'gueltig' | 'unvollstaendig' | 'ungueltig'

export interface StichtagPruefung {
  status: StichtagStatus
  /** Canonical `DD.MM.YYYY`, only set when `status` is `'gueltig'`. */
  wert: string | null
}

const STICHAG_MUSTER = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/

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

/** True when `tag`/`monat`/`jahr` form a real calendar date. */
export function istKalendertag(tag: number, monat: number, jahr: number): boolean {
  if (!Number.isInteger(tag) || tag < 1 || tag > 31) return false
  if (!Number.isInteger(monat) || monat < 1 || monat > 12) return false
  if (!Number.isInteger(jahr) || jahr < 1 || jahr > 9999) return false
  const probe = new Date(Date.UTC(jahr, monat - 1, tag))
  return (
    probe.getUTCFullYear() === jahr &&
    probe.getUTCMonth() === monat - 1 &&
    probe.getUTCDate() === tag
  )
}

/**
 * Assembles the cut-off date from the three form fields.
 *
 * `'leer'` — all fields empty: the setting is cleared ("not set").
 * `'unvollstaendig'` — only some fields filled: never write that to the
 * outbox.
 */
export function stichtagAusTeilen(tag: unknown, monat: unknown, jahr: unknown): StichtagPruefung {
  const t = feldWert(tag)
  const m = feldWert(monat)
  const j = feldWert(jahr)
  if (t.ungueltig || m.ungueltig || j.ungueltig) return { status: 'ungueltig', wert: null }
  if (t.zahl === null && m.zahl === null && j.zahl === null) return { status: 'leer', wert: null }
  if (t.zahl === null || m.zahl === null || j.zahl === null)
    return { status: 'unvollstaendig', wert: null }
  if (!istKalendertag(t.zahl, m.zahl, j.zahl)) return { status: 'ungueltig', wert: null }
  return {
    status: 'gueltig',
    wert: `${String(t.zahl).padStart(2, '0')}.${String(m.zahl).padStart(2, '0')}.${j.zahl}`,
  }
}

/**
 * Canonicalises a stored/raw value: returns the padded `DD.MM.YYYY` form when
 * the value is a real calendar date, `null` otherwise (including `''` and
 * legacy values such as `11-00` written by the old form). One-digit day/month
 * is accepted on input and padded, because that is the only form the server
 * stores.
 */
export function parseInventurStichtag(wert: unknown): string | null {
  if (typeof wert !== 'string') return null
  const teks = wert.trim()
  if (teks === '') return null
  if (!STICHAG_MUSTER.test(teks)) return null
  const [tagStr, monatStr, jahrStr] = teks.split('.')
  const tag = Number.parseInt(tagStr ?? '', 10)
  const monat = Number.parseInt(monatStr ?? '', 10)
  const jahr = Number.parseInt(jahrStr ?? '', 10)
  if (!istKalendertag(tag, monat, jahr)) return null
  return `${String(tag).padStart(2, '0')}.${String(monat).padStart(2, '0')}.${jahr}`
}

/** Day, month and year of a stored value, `null` when nothing is configured. */
export function inventurStichtagTeile(
  wert: unknown,
): { tag: number; monat: number; jahr: number } | null {
  const genormt = parseInventurStichtag(wert)
  if (genormt === null) return null
  const [tagStr, monatStr, jahrStr] = genormt.split('.')
  return {
    tag: Number.parseInt(tagStr ?? '', 10),
    monat: Number.parseInt(monatStr ?? '', 10),
    jahr: Number.parseInt(jahrStr ?? '', 10),
  }
}

/** Formats the stored `DD.MM.YYYY` for display. */
export function inventurStichtagAnzeige(wert: unknown): string | null {
  const teile = inventurStichtagTeile(wert)
  if (teile === null) return null
  return `${String(teile.tag).padStart(2, '0')}.${String(teile.monat).padStart(2, '0')}.${teile.jahr}`
}
