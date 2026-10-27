// Pure calculation logic for the Akkutausch tool.
//
// No Vue, no Dexie, no server imports — every function is a deterministic
// transformation of its input. That keeps the planning rules unit-testable
// and lets the server reuse the same rules (see server/src/domain/akkutausch.ts).
//
// Date handling: all dates are calendar dates (`YYYY-MM-DD`), never
// timestamps. Arithmetic therefore runs in UTC — a local-time conversion
// would shift the due date by a day around time zone changes.

import type {
  AkkuTyp,
  Bestellzeile,
  IsoDatum,
  Netzteil,
  Planung,
  Planwarnung,
  Planzeile,
  Projektakku,
} from './types'

/** Error codes of the size-range validation. */
export type TypFehlerCode =
  | 'ungueltige_kapazitaet'
  | 'ungueltiger_bereich'
  | 'nominal_ausserhalb'
  | 'ueberlappung'
  | 'ungueltige_id'

/** A single validation problem of a configured battery size. */
export interface TypFehler {
  code: TypFehlerCode
  /** Id of the offending type. */
  typId: string
  /** Id of the second type — only set for `ueberlappung`. */
  otherTypId?: string
  /** Offending value, formatted for display. */
  wert?: string
}

/** Input of {@link berechnePlanung}. */
export interface PlanungEingabe {
  /** Configured battery sizes. */
  typen: readonly AkkuTyp[]
  /** Installed devices (tombstones are ignored). */
  netzteile: readonly Netzteil[]
  /** Project batteries (tombstones are ignored). */
  projektakkus: readonly Projektakku[]
  /** Total stock per article id (all locations). */
  bestand: ReadonlyMap<string, number>
  /** Safety stock per article id (minimum stock at the main warehouse). */
  reserve: ReadonlyMap<string, number>
  /** Selected quarter (1..4). */
  quartal: number
  /** Selected year. */
  jahr: number
}

/**
 * Parses a capacity input. Accepts a comma or a dot as decimal separator and
 * a leading dot (`.5` -> `0.5`). Returns `null` for anything that is not a
 * positive finite number.
 */
export function parseKapazitaet(input: string): number | null {
  const raw = input.trim().replace(',', '.')
  if (raw === '') return null
  if (!/^\d*\.?\d+$/.test(raw)) return null
  const wert = Number(raw)
  if (!Number.isFinite(wert) || wert <= 0) return null
  return wert
}

/**
 * Parses a calendar date. Accepts `YYYY-MM-DD` and `DD.MM.YYYY` and returns
 * the normalized `YYYY-MM-DD`. Invalid calendar dates (e.g. 31.02.) yield
 * `null`.
 */
export function parseDatum(input: string): IsoDatum | null {
  const raw = input.trim()
  let jahr = 0
  let monat = 0
  let tag = 0

  const isoTreffer = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw)
  const deTreffer = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(raw)
  if (isoTreffer) {
    jahr = Number(isoTreffer[1])
    monat = Number(isoTreffer[2])
    tag = Number(isoTreffer[3])
  } else if (deTreffer) {
    tag = Number(deTreffer[1])
    monat = Number(deTreffer[2])
    jahr = Number(deTreffer[3])
  } else {
    return null
  }

  if (monat < 1 || monat > 12 || tag < 1) return null
  if (tag > tageImMonat(jahr, monat)) return null
  return `${pad(jahr, 4)}-${pad(monat, 2)}-${pad(tag, 2)}`
}

/** True when the input is a valid `YYYY-MM-DD` calendar date. */
export function istIsoDatum(input: string): boolean {
  return parseDatum(input) === input
}

/** Quarter (1..4) of a calendar date. */
export function quartalVonDatum(datum: IsoDatum): number | null {
  const iso = parseDatum(datum)
  if (!iso) return null
  const monat = Number(iso.slice(5, 7))
  return Math.floor((monat - 1) / 3) + 1
}

/**
 * Due date of a device: installation date plus the replacement interval.
 * The day of month is clamped to the last day of the target month, so
 * 29.02.2020 + 1 year becomes 28.02.2021 instead of 01.03.2021.
 *
 * Returns `null` when the date or the interval is missing (devices from CSV
 * imports may not have them yet).
 */
export function faelligkeit(
  einbaudatum: string | null,
  intervallJahre: number | null,
): IsoDatum | null {
  if (einbaudatum === null || intervallJahre === null) return null
  const iso = parseDatum(einbaudatum)
  if (!iso) return null
  if (!Number.isFinite(intervallJahre) || intervallJahre <= 0) return null
  const jahre = Math.trunc(intervallJahre)

  const jahr = Number(iso.slice(0, 4))
  const monat = Number(iso.slice(5, 7))
  const tag = Number(iso.slice(8, 10))

  const zielJahr = jahr + jahre
  const zielTag = Math.min(tag, tageImMonat(zielJahr, monat))
  return `${pad(zielJahr, 4)}-${pad(monat, 2)}-${pad(zielTag, 2)}`
}

/**
 * Finds the configured size a capacity belongs to. The first matching range
 * wins — ranges must not overlap (see {@link pruefeTypen}).
 */
export function typFuerKapazitaet(kapazitaet: number, typen: readonly AkkuTyp[]): AkkuTyp | null {
  if (!Number.isFinite(kapazitaet)) return null
  for (const typ of typen) {
    if (kapazitaet >= typ.von && kapazitaet <= typ.bis) return typ
  }
  return null
}

/**
 * Validates the configured sizes. Returns an empty list when everything is
 * fine. Overlapping ranges are rejected; ranges that only touch (e.g. 1.0-1.9
 * and 2.0-2.9) are allowed.
 */
export function pruefeTypen(typen: readonly AkkuTyp[]): TypFehler[] {
  const fehler: TypFehler[] = []

  for (const typ of typen) {
    if (typ.id.trim() === '') {
      fehler.push({ code: 'ungueltige_id', typId: typ.id })
      continue
    }
    if (
      !Number.isFinite(typ.von) ||
      !Number.isFinite(typ.bis) ||
      typ.von <= 0 ||
      typ.bis < typ.von
    ) {
      fehler.push({ code: 'ungueltiger_bereich', typId: typ.id })
      continue
    }
    if (!Number.isFinite(typ.kapazitaetAh) || typ.kapazitaetAh <= 0) {
      fehler.push({
        code: 'ungueltige_kapazitaet',
        typId: typ.id,
        wert: String(typ.kapazitaetAh),
      })
      continue
    }
    if (typ.kapazitaetAh < typ.von || typ.kapazitaetAh > typ.bis) {
      fehler.push({
        code: 'nominal_ausserhalb',
        typId: typ.id,
        wert: String(typ.kapazitaetAh),
      })
    }
  }

  for (let i = 0; i < typen.length; i++) {
    const a = typen[i]
    if (!a) continue
    for (let j = i + 1; j < typen.length; j++) {
      const b = typen[j]
      if (!b) continue
      if (a.von <= b.bis && b.von <= a.bis) {
        fehler.push({ code: 'ueberlappung', typId: a.id, otherTypId: b.id })
      }
    }
  }

  return fehler
}

/**
 * Computes the replacement plan for one quarter.
 *
 * Demand (`soll`) comes from the devices whose due date falls into the
 * selected quarter plus the project batteries booked for that quarter.
 * The order quantity keeps the safety stock (`reserve`) untouched:
 *
 *   verfuegbar = max(0, bestand - reserve)
 *   benoetigt  = max(0, soll - verfuegbar)
 */
export function berechnePlanung(eingabe: PlanungEingabe): Planung {
  const { typen, netzteile, projektakkus, bestand, reserve, quartal, jahr } = eingabe

  const sollJeTyp = new Map<string, number>()
  const warnungen: Planwarnung[] = []

  for (const netzteil of netzteile) {
    if (netzteil.geloescht) continue

    // Devices from CSV imports may still be incomplete — they cannot be
    // planned, but the user has to see them in the warning list.
    const fehlend = fehlendeNetzteilFelder(netzteil)
    if (fehlend.length > 0) {
      warnungen.push({
        code: 'netzteil_unvollstaendig',
        bezug: netzteil.name || netzteil.anlage,
        wert: fehlend.join(','),
      })
      continue
    }

    const faellig = faelligkeit(netzteil.einbaudatum, netzteil.intervallJahre)
    if (!faellig) {
      warnungen.push({
        code: 'netzteil_ungueltiges_datum',
        bezug: netzteil.name || netzteil.anlage,
        wert: netzteil.einbaudatum ?? undefined,
      })
      continue
    }
    const faelligQuartal = quartalVonDatum(faellig)
    const faelligJahr = Number(faellig.slice(0, 4))
    if (faelligQuartal !== quartal || faelligJahr !== jahr) continue

    const kapazitaet = netzteil.kapazitaetAh
    if (kapazitaet === null) continue
    const typ = typFuerKapazitaet(kapazitaet, typen)
    if (!typ) {
      warnungen.push({
        code: 'netzteil_keine_groesse',
        bezug: netzteil.name || netzteil.anlage,
        wert: String(kapazitaet),
      })
      continue
    }
    sollJeTyp.set(typ.id, (sollJeTyp.get(typ.id) ?? 0) + (netzteil.anzahl ?? 0))
  }

  for (const projektakku of projektakkus) {
    if (projektakku.geloescht) continue
    if (projektakku.quartal !== quartal || projektakku.jahr !== jahr) continue

    const typ = typFuerKapazitaet(projektakku.artAh, typen)
    if (!typ) {
      warnungen.push({
        code: 'projektakku_keine_groesse',
        bezug: projektakku.projekt,
        wert: String(projektakku.artAh),
      })
      continue
    }
    sollJeTyp.set(typ.id, (sollJeTyp.get(typ.id) ?? 0) + projektakku.menge)
  }

  const zeilen: Planzeile[] = []
  const bestellzeilen: Bestellzeile[] = []

  const sortierteTypen = [...typen].sort((a, b) => {
    if (a.kapazitaetAh !== b.kapazitaetAh) return a.kapazitaetAh - b.kapazitaetAh
    return a.von - b.von
  })

  for (const typ of sortierteTypen) {
    const artikelId = typ.artikelId
    const bestandWert = artikelId ? (bestand.get(artikelId) ?? 0) : 0
    const reserveWert = artikelId ? (reserve.get(artikelId) ?? 0) : 0
    const soll = sollJeTyp.get(typ.id) ?? 0
    const verfuegbar = Math.max(0, bestandWert - reserveWert)
    const benoetigt = Math.max(0, soll - verfuegbar)

    const zeilenWarnungen: Planwarnung[] = []
    if (!artikelId) {
      zeilenWarnungen.push({ code: 'typ_ohne_artikel', bezug: String(typ.von) })
    }

    zeilen.push({
      typ,
      soll,
      bestand: bestandWert,
      reserve: reserveWert,
      verfuegbar,
      benoetigt,
      warnungen: zeilenWarnungen,
    })

    if (benoetigt > 0) {
      bestellzeilen.push({
        typId: typ.id,
        kapazitaetAh: typ.kapazitaetAh,
        von: typ.von,
        bis: typ.bis,
        menge: benoetigt,
      })
    }
  }

  return { zeilen, bestellzeilen, warnungen }
}

/**
 * Battery data of a device that is still missing.
 *
 * Returns the field keys (`einbaudatum`, `intervallJahre`, `kapazitaetAh`,
 * `anzahl`) that are still unknown — an empty list means the device is
 * complete.
 */
export function fehlendeNetzteilFelder(netzteil: Netzteil): string[] {
  const fehlend: string[] = []
  if (!netzteil.einbaudatum) fehlend.push('einbaudatum')
  if (netzteil.intervallJahre === null) fehlend.push('intervallJahre')
  if (netzteil.kapazitaetAh === null) fehlend.push('kapazitaetAh')
  if (netzteil.anzahl === null) fehlend.push('anzahl')
  return fehlend
}

/** Number of days in a month (1-based month). */
function tageImMonat(jahr: number, monat: number): number {
  return new Date(Date.UTC(jahr, monat, 0)).getUTCDate()
}

function pad(wert: number, laenge: number): string {
  return String(wert).padStart(laenge, '0')
}
