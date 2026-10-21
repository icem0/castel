// Client for the supplier catalogue (Hersteller-Katalog).
//
// The catalogue lives on the server and is fetched on demand: a supplier can
// ship 50k+ articles, and mirroring all of that into IndexedDB for offline
// use would cost hundreds of megabytes on a phone to serve a lookup that
// happens a handful of times a day. The trade-off is deliberate — the
// article form shows a clear "offline" state instead of silently offering
// stale catalogue data.

import { apiFetch } from '../../auth/api'

/** A supplier whose DATANORM catalogue has been imported. */
export interface Lieferant {
  id: string
  name: string
  matchcode: string | null
  aktiv: boolean
  ort: string | null
  geaendertAm: string
}

/** One catalogue entry, ready to fill the article form from. */
export interface HerstellerArtikel {
  id: string
  matchcode: string
  matchcode2: string | null
  ean: string | null
  titel: string
  beschreibung: string | null
  mengeneinheit: string | null
  /** "This price covers N units" — display hint only, castel never converts. */
  preiseinheit: number | null
  inhalt: string | null
  warengruppe: string | null
  preisNettoCent: number | null
  preisBruttoCent: number | null
  gueltigAb: string | null
  ersatzMatchcode: string | null
  /** Supplier marked this article as withdrawn (v5 delete record). */
  deaktiviert: boolean
  deaktiviertAm: string | null
  geaendertAm: string
}

export interface LookupAntwort {
  lieferant: { id: string; name: string } | null
  /** Which search strategy the server used — lets the UI explain itself. */
  suchstrategie: 'ean' | 'matchcode' | 'titel' | 'alle'
  treffer: HerstellerArtikel[]
  page: number
  pageSize: number
  total: number
  hasMore: boolean
}

export interface LookupParameter {
  lieferantId: string
  q?: string
  ean?: string
  matchcode?: string
  page?: number
  limit?: number
  /** Include withdrawn articles (the drawer shows them greyed out). */
  inklDeaktivierte?: boolean
}

export async function ladeLieferanten(alle = false): Promise<Lieferant[]> {
  const suffix = alle ? '?alle=true' : ''
  return apiFetch<Lieferant[]>(`/api/lieferanten${suffix}`)
}

export async function sucheHerstellerArtikel(params: LookupParameter): Promise<LookupAntwort> {
  const q = new URLSearchParams({ lieferantId: params.lieferantId })
  if (params.q) q.set('q', params.q)
  if (params.ean) q.set('ean', params.ean)
  if (params.matchcode) q.set('matchcode', params.matchcode)
  if (params.page !== undefined) q.set('page', String(params.page))
  if (params.limit !== undefined) q.set('limit', String(params.limit))
  if (params.inklDeaktivierte) q.set('inklDeaktivierte', 'true')
  return apiFetch<LookupAntwort>(`/api/datanorm/artikel?${q.toString()}`)
}

export async function ladeHerstellerArtikel(id: string): Promise<HerstellerArtikel> {
  return apiFetch<HerstellerArtikel>(`/api/datanorm/artikel/${id}`)
}

// ---------------------------------------------------------------------------
// Session memory
// ---------------------------------------------------------------------------

const LS_LEFERANT = 'castel.datanorm.lieferant'
const LS_BEISPIEL = 'castel.datanorm.beispiel'

/**
 * Remembers the last supplier used in the drawer.
 *
 * Suppliers are picked far more often than they change, and re-picking one of
 * eight suppliers before every single article is pure friction. Stored in
 * localStorage rather than sessionStorage: the picker is also useful after a
 * reload, and the value is a supplier UUID, nothing sensitive.
 */
export function leseLetztenLieferant(): string | null {
  try {
    return localStorage.getItem(LS_LEFERANT)
  } catch {
    return null
  }
}

export function speichereLetztenLieferant(id: string): void {
  try {
    localStorage.setItem(LS_LEFERANT, id)
  } catch {
    /* private mode / quota — the picker just starts empty next time */
  }
}

/**
 * Remembers the last catalogue entry that was applied.
 *
 * Pre-fills the drawer's search so the "same thing again" case (ordering the
 * same fitting every week) is two taps instead of a full search.
 */
export function leseLetztesBeispiel(): string | null {
  try {
    return localStorage.getItem(LS_BEISPIEL)
  } catch {
    return null
  }
}

export function speichereLetztesBeispiel(begriff: string): void {
  try {
    localStorage.setItem(LS_BEISPIEL, begriff)
  } catch {
    /* ignore */
  }
}
