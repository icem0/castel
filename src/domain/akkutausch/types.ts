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
  /**
   * Demand for the selected quarter — devices due in the quarter (device list)
   * plus the project batteries booked for it.
   */
  bedarf: number
  /** Total stock of the linked article across all locations. */
  bestand: number
  /**
   * Buffer ("zur freien Verfuegung") — the minimum stock of the battery
   * article at the main warehouse. It is maintained by an admin and only
   * feeds into the order quantity.
   */
  puffer: number
  /**
   * Quantity to order: `bedarf - max(0, bestand) + puffer`, never negative.
   * Zero for a quarter that was already ordered — it is covered.
   */
  bestellmenge: number
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

/**
 * Minimal shape of a booking needed to determine the battery inventory date.
 * Kept free of Dexie types so the logic stays unit-testable.
 */
export interface InventurBuchung {
  artikelId: string
  typ: string
  storno: boolean
  erstelltAm: IsoZeit
  erstelltVon: string
}

/**
 * Result of the inventory check.
 *
 * The stock is dated with the oldest inventory booking of a battery article
 * that lies within the last four weeks. Each inventory booking belongs to the
 * same inventory run, so the oldest date marks the cut-off and the initials of
 * the people who booked on that day identify who conducted it.
 */
export interface InventurStatus {
  /** `true` when at least one valid inventory booking exists. */
  gueltig: boolean
  /** Cut-off date (`YYYY-MM-DD`) — the oldest booking date in the window. */
  datum: IsoDatum | null
  /** Initials of the people who booked the inventory on the cut-off date. */
  kuerzel: string | null
  /** Number of valid inventory bookings inside the window. */
  anzahlBuchungen: number
}

/**
 * One archived row of the planning table.
 *
 * The field names are the frozen wire format of the server contract and
 * stay unchanged — `soll` is the demand ("Bedarf"), `reserve` the buffer
 * ("zur freien Verfügung") and `bedarf` the order quantity
 * ("Bestellmenge").
 */
export interface AkkuBestellungZeile {
  typId: string
  /**
   * Article of the battery size at the time of the order. Needed to restore
   * the buffer ("zur freien Verfuegung") when the order is undone — the
   * buffer lives as the minimum stock of that article at the main warehouse.
   */
  artikelId: string | null
  kapazitaetAh: number
  von: number
  bis: number
  /** Demand ("Bedarf"). */
  soll: number
  bestand: number
  /** Buffer ("zur freien Verfügung"). */
  reserve: number
  /**
   * Frozen stock that was usable for the plan (`bestand - reserve`).
   *
   * Part of the wire format of the server contract — the planning itself does
   * not know an intermediate "verfuegbar" value any more.
   */
  verfuegbar: number
  /** Order quantity ("Bestellmenge"). */
  bedarf: number
}

/**
 * Snapshot of a "marked as ordered" quarter.
 *
 * The snapshot freezes the planning table, the inventory cut-off and the
 * initials of the person who triggered the order, so later stock changes do
 * not rewrite the archive. Identity is a UUID; a new order run creates a new
 * row.
 *
 * The last order can be undone ("rueckgaengig gemacht"): the row is kept as
 * history and marked with `storno`. The minimum stock of the battery
 * articles is restored from the frozen buffer (`zeilen[].reserve`).
 */
export interface AkkuBestellung {
  id: string
  quartal: number
  jahr: number
  /** Server-authoritative order timestamp (ISO). */
  bestelltAm: IsoZeit
  /** Display name of the user who marked the order. */
  bestelltVon: string
  /** Initials of the user who marked the order. */
  bestelltVonKuerzel: string
  /** Inventory cut-off date at the time of the order. */
  inventurDatum: IsoDatum | null
  /** Initials of the people who conducted that inventory. */
  inventurVonKuerzel: string | null
  /**
   * Main warehouse at the time of the order — the buffer was written there
   * as the minimum stock of the battery articles.
   */
  standortId: string | null
  /** The order was undone. The row stays as history. */
  storno: boolean
  /** Timestamp of the undo (server-authoritative). */
  stornoAm: IsoZeit | null
  /** Display name of the user who undid the order. */
  stornoVon: string | null
  /** Initials of the user who undid the order. */
  stornoVonKuerzel: string | null
  /** Frozen planning table. */
  zeilen: AkkuBestellungZeile[]
}
