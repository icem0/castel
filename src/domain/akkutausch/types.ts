// Domain types for the battery replacement tool (Akkutausch).
//
// The module is deliberately free of Vue, Dexie and server imports so it can
// be unit-tested in isolation and mirrored on the server side.
//
// Identity rules:
//   - Every record carries a UUID (`id`), generated on the client.
//   - A battery size ("AkkuTyp") points at a regular `Artikel` via
//     `artikelId`. The article stays fully editable (supplier, price, ...),
//     the link survives renames.

/** ISO date, `YYYY-MM-DD`. */
export type IsoDatum = string

/** ISO timestamp, e.g. `2025-04-14T11:17:49.000Z`. */
export type IsoZeit = string

/**
 * A configured battery size range.
 *
 * `von`/`bis` are the inclusive capacity bounds in Ah that a battery is
 * assigned to. `kapazitaetAh` is the nominal capacity used for the order
 * list and must lie inside the range.
 */
export interface AkkuTyp {
  id: string
  /** Nominal capacity in Ah (e.g. 12.5). */
  kapazitaetAh: number
  /** Lower bound of the capacity range in Ah (inclusive). */
  von: number
  /** Upper bound of the capacity range in Ah (inclusive). */
  bis: number
  /** Linked article; `null` when no article is assigned (yet). */
  artikelId: string | null
}

/** A installed device whose battery is replaced on a fixed interval. */
export interface Netzteil {
  id: string
  /** Plant / system the device belongs to. */
  anlage: string
  /** Object (machine, vehicle, unit) the device is mounted in. */
  objekt: string
  /** Device name. */
  name: string
  /**
   * Installation date (`YYYY-MM-DD`).
   *
   * `null` while it is still unknown — devices from CSV imports are often
   * incomplete and get completed later.
   */
  einbaudatum: IsoDatum | null
  /** Replacement interval in years — `null` while it is still unknown. */
  intervallJahre: number | null
  /** Battery capacity of the installed battery in Ah — `null` while unknown. */
  kapazitaetAh: number | null
  /** Number of batteries per device — `null` while unknown. */
  anzahl: number | null
  /** Free grouping label. */
  gruppe: string | null
  /** Postal code of the site. */
  plz: string | null
  /** VDS approval reference. */
  vdsAnerkennung: string | null
  /** Free-text note. */
  bemerkung: string | null
  /** Soft-delete marker — the row stays in the sync as a tombstone. */
  geloescht: boolean
  erstelltAm: IsoZeit
  geaendertAm: IsoZeit
}

/** A battery that has to be purchased for a project in a given quarter. */
export interface Projektakku {
  id: string
  /** Project name. */
  projekt: string
  /** Number of batteries. */
  menge: number
  /** Battery type in Ah (e.g. 100). */
  artAh: number
  /** Quarter (1..4). */
  quartal: number
  /** Year. */
  jahr: number
  /** Soft-delete marker — the row stays in the sync as a tombstone. */
  geloescht: boolean
  erstelltAm: IsoZeit
  geaendertAm: IsoZeit
}

/** Warning codes raised while computing the plan. */
export type PlanwarnungCode =
  | 'netzteil_ungueltiges_datum'
  | 'netzteil_keine_groesse'
  | 'netzteil_unvollstaendig'
  | 'projektakku_keine_groesse'
  | 'typ_ohne_artikel'

/** A single warning with enough context for an i18n message. */
export interface Planwarnung {
  code: PlanwarnungCode
  /** Human readable reference (device name, project name, ...). */
  bezug: string
  /** Additional value, e.g. the unmatched capacity. */
  wert?: string
  /** Plant / system of the device, shown to disambiguate warnings. */
  anlage?: string
  /** Device ID — lets the UI jump straight to the entry for editing. */
  netzteilId?: string
}

/** One row of the replacement plan (one configured battery size). */
export interface Planzeile {
  typ: AkkuTyp
  /** Demand for the selected quarter (devices due x batteries each). */
  soll: number
  /** Total stock of the linked article across all locations. */
  bestand: number
  /** Safety stock (minimum stock at the main warehouse). */
  reserve: number
  /** Stock available for the plan: `bestand - reserve`, never negative. */
  verfuegbar: number
  /** Quantity to order: `soll - verfuegbar`, never negative. */
  benoetigt: number
  /** Warnings that belong to this row. */
  warnungen: Planwarnung[]
}

/** One line of the order list. */
export interface Bestellzeile {
  typId: string
  /** Nominal capacity in Ah. */
  kapazitaetAh: number
  /** Lower bound of the capacity range in Ah. */
  von: number
  /** Upper bound of the capacity range in Ah. */
  bis: number
  /** Quantity to order. */
  menge: number
}

/** Result of the plan calculation. */
export interface Planung {
  /** Plan rows, ordered by nominal capacity ascending. */
  zeilen: Planzeile[]
  /** Order list — only rows with a demand. */
  bestellzeilen: Bestellzeile[]
  /** Warnings that cannot be assigned to a single row. */
  warnungen: Planwarnung[]
}
