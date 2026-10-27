// Formatting helpers for the Akkutausch tool.
//
// German locale uses a comma as decimal separator and a dot as thousands
// separator, the date format is `TT.MM.JJJJ`. The formatting is implemented
// explicitly instead of via `Intl` so the output is identical on every
// runtime (some minimal ICU builds only ship English data).
//
// The helpers are pure so the plan table, the order list and the CSV export
// all render the same values.

import type { IsoDatum } from './types'

/** True when the given locale should use German formatting. */
function istDeutsch(locale: string): boolean {
  return locale.toLowerCase().startsWith('de')
}

/** Formats a number with the given locale (e.g. `12,5` for `de`). */
export function formatZahl(wert: number, locale: string): string {
  if (!Number.isFinite(wert)) return ''
  const deutsch = istDeutsch(locale)
  const negativ = wert < 0
  const gerundet = Math.abs(wert).toFixed(2)
  const teile = gerundet.split('.')
  const intTeil = teile[0] ?? '0'
  const dezTeil = (teile[1] ?? '').replace(/0+$/, '')

  const mitTausender = intTeil.replace(/\B(?=(\d{3})+(?!\d))/g, deutsch ? '.' : ',')
  const vorzeichen = negativ ? '-' : ''
  if (dezTeil === '') return `${vorzeichen}${mitTausender}`
  return `${vorzeichen}${mitTausender}${deutsch ? ',' : '.'}${dezTeil}`
}

/** Formats a capacity including the unit, e.g. `12,5 Ah`. */
export function formatKapazitaet(wert: number, locale: string): string {
  return `${formatZahl(wert, locale)} Ah`
}

/** Formats a capacity range including the unit, e.g. `1,0–1,9 Ah`. */
export function formatKapazitaetBereich(von: number, bis: number, locale: string): string {
  return `${formatZahl(von, locale)}–${formatZahl(bis, locale)} Ah`
}

/**
 * Title of the battery article: the nominal capacity, not the band.
 * Example: `Akku 12,5 Ah` (the band 12,0–12,9 Ah is only the matching rule).
 */
export function artikelTitel(kapazitaetAh: number, locale: string): string {
  return `Akku ${formatKapazitaet(kapazitaetAh, locale)}`
}

/**
 * Formats a calendar date (`YYYY-MM-DD`) for display. The date is built in
 * UTC so it never shifts by a day through the local time zone.
 */
export function formatDatum(datum: IsoDatum, locale: string): string {
  const jahr = Number(datum.slice(0, 4))
  const monat = Number(datum.slice(5, 7))
  const tag = Number(datum.slice(8, 10))
  if (!Number.isFinite(jahr) || !Number.isFinite(monat) || !Number.isFinite(tag)) return ''
  if (monat < 1 || monat > 12 || tag < 1 || tag > 31) return ''
  if (istDeutsch(locale)) {
    return `${String(tag).padStart(2, '0')}.${String(monat).padStart(2, '0')}.${jahr}`
  }
  return `${String(monat).padStart(2, '0')}/${String(tag).padStart(2, '0')}/${jahr}`
}

/**
 * Builds a CSV file for Excel: semicolon separated, German decimal comma
 * and a BOM so Excel detects UTF-8. Values that contain the separator or a
 * line break are quoted.
 */
export function csvDatei(
  zeilen: readonly (readonly string[])[],
  kopfzeilen: readonly string[],
): string {
  const esc = (wert: string): string => {
    if (/[";\n\r]/.test(wert)) return `"${wert.replace(/"/g, '""')}"`
    return wert
  }
  const alle = [kopfzeilen, ...zeilen].map((zeile) => zeile.map(esc).join(';'))
  return `﻿${alle.join('\r\n')}\r\n`
}

/** Formats a number as a German decimal string (used inside CSV exports). */
export function csvZahl(wert: number, locale: string): string {
  return formatZahl(wert, locale)
}
