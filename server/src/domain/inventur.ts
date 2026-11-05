// Pure validation for the inventory settings (`inventur.stichtag` and
// `inventur.vorlaufTage`). Extracted from the sync resolver so the rules are
// unit-testable without a database and so the client can mirror exactly the
// same semantics (see `src/domain/inventur-stichtag.ts` in the PWA).

/** An empty value is a legal state: it means "no cut-off date configured". */
export const INVENTUR_STICHAG_LEER = ''

/**
 * Validates `inventur.stichtag`: a concrete calendar date `DD.MM.YYYY`
 * (with year). An empty string is explicitly allowed and clears the setting
 * — the PWA uses it for "not set".
 *
 * Returns `null` when the value is acceptable, otherwise a message that is
 * shown to the user as the rejection reason.
 */
export function pruefeInventurStichtag(value: string): string | null {
  if (value === INVENTUR_STICHAG_LEER) return null
  if (!/^\d{2}\.\d{2}\.\d{4}$/.test(value)) {
    return 'muss ein Kalenderdatum im Format DD.MM.YYYY sein'
  }
  const [tagStr, monatStr, jahrStr] = value.split('.')
  const tag = Number.parseInt(tagStr ?? '', 10)
  const monat = Number.parseInt(monatStr ?? '', 10)
  const jahr = Number.parseInt(jahrStr ?? '', 10)
  if (!Number.isFinite(tag) || tag < 1 || tag > 31) return 'Tag muss zwischen 1 und 31 liegen'
  if (!Number.isFinite(monat) || monat < 1 || monat > 12) return 'Monat muss zwischen 1 und 12 liegen'
  if (!Number.isFinite(jahr) || jahr < 1 || jahr > 9999) return 'Jahr muss zwischen 1 und 9999 liegen'
  // Reject impossible combinations (e.g. 31.02.2026) and round-trip check.
  const probe = new Date(Date.UTC(jahr, monat - 1, tag))
  if (probe.getUTCFullYear() !== jahr || probe.getUTCMonth() !== monat - 1 || probe.getUTCDate() !== tag) {
    return 'kein gültiges Kalenderdatum'
  }
  return null
}

/** Validates `inventur.vorlaufTage`: whole number between 0 and 365. */
export function pruefeInventurVorlaufTage(value: string): string | null {
  const tage = Number.parseInt(value, 10)
  if (!Number.isFinite(tage) || tage < 0 || tage > 365 || String(tage) !== value.trim()) {
    return 'muss eine ganze Zahl zwischen 0 und 365 sein'
  }
  return null
}
