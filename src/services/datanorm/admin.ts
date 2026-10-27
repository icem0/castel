// Admin-Api für Hersteller-Kataloge (DATANORM).
//
// Lieferanten werden vom Admin gepflegt (anlegen, aktivieren/deaktivieren).
// Ein Lieferant = ein DATANORM-Katalog. Die eigentlichen Katalog-Einträge
// (hersteller_artikel) werden erst durch einen Upload auf dem Server
// befüllt.

import { apiFetch } from '../../auth/api'
import type { DatanormFormat, Lieferant } from './lookup'

export interface AnlageLieferantBody {
  name: string
  matchcode?: string | null
  ort?: string | null
  strasse?: string | null
  plz?: string | null
  telefon?: string | null
  email?: string | null
  aktiv?: boolean
  /** DATANORM format of the supplier's export. */
  format?: DatanormFormat
}

/** Lieferantenliste (aktive, bzw. alle für Admin). */
export async function ladeLieferanten(alle = false): Promise<Lieferant[]> {
  return apiFetch<Lieferant[]>(`/api/lieferanten?${alle ? 'alle=true' : ''}`)
}

/** Einen Lieferanten (Katalog) anlegen. Admin nur. */
export async function anlageLieferant(
  body: AnlageLieferantBody,
): Promise<{ id: string; name: string }> {
  return apiFetch<{ id: string; name: string }>('/api/lieferanten', {
    method: 'POST',
    body,
  })
}

/** Lieferanten-Patch (name, aktiv, matchcode, ort). Admin nur. */
export async function patchLieferant(
  id: string,
  body: Partial<AnlageLieferantBody>,
): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/api/lieferanten/${id}`, {
    method: 'PATCH',
    body,
  })
}

/** What a destructive catalogue action removed. */
export interface LoeschErgebnis {
  artikel: number
  dateien: number
  /** Only set when the whole supplier was deleted. */
  importe?: number
}

/**
 * Deletes the supplier with everything attached: catalogue mirror, stored
 * DATANORM files and import reports. Castel articles are not affected — the
 * supplier name is a free-text field on the article, not a reference.
 */
export async function loescheLieferant(id: string): Promise<LoeschErgebnis> {
  return apiFetch<LoeschErgebnis & { ok: boolean }>(`/api/lieferanten/${id}`, {
    method: 'DELETE',
  })
}

/**
 * Empties the supplier's catalogue (mirror + stored files) but keeps the
 * supplier itself. The import history survives on purpose.
 */
export async function leereKatalog(id: string): Promise<LoeschErgebnis> {
  return apiFetch<LoeschErgebnis & { ok: boolean }>(`/api/lieferanten/${id}/katalog-leeren`, {
    method: 'POST',
  })
}

export interface DatanormUploadBody {
  lieferantId: string
  encoding?: 'utf-8' | 'cp850' | 'windows-1252'
  /** 'auto' (default), 'v4' or 'v5'. */
  format?: DatanormFormat
}

/** Status eines Imports — spiegelt `datanorm_importe.status` (Server). */
export type DatanormImportStatus = 'erfolg' | 'teilfehler' | 'fehler' | 'duplikat'

/**
 * Ergebnis von POST /api/datanorm/upload.
 *
 * Deckt sich mit `ImportErgebnis` auf dem Server (server/src/datanorm/
 * import-service.ts). Die Zähler heissen dort `neu`/`aktualisiert`/
 * `deaktiviert` — NICHT `artikelNeu` (das ist die DB-Spalte und nur im
 * Importverlauf so benannt).
 */
export interface DatanormUploadErgebnis {
  importId: string
  status: DatanormImportStatus
  artikelAnzahl: number
  neu: number
  aktualisiert: number
  deaktiviert: number
  uebersprungen: number
  fehlerAnzahl: number
  fehlerDetails: Array<{
    satzart: string
    zeile: number
    code: string
    meldung: string
  }>
  encoding: 'utf-8' | 'cp850' | 'windows-1252' | null
  version: number | null
  /** Gesetzt, wenn dieselbe Datei für diesen Lieferanten schon importiert wurde. */
  vorhandenerImportId?: string
  /** Hinweise des Parsers, z. B. "das ist eine DATPREIS-Preisdatei". */
  auffaelligkeiten: string[]
}

/** DATANORM-Datei hochladen und importieren. Admin nur. */
export async function uploadDatanormDatei(
  file: File,
  lieferantId: string,
  encoding?: 'utf-8' | 'cp850' | 'windows-1252',
  format?: DatanormFormat,
): Promise<DatanormUploadErgebnis> {
  const form = new FormData()
  form.append('datei', file)
  form.append('lieferantId', lieferantId)
  if (encoding) form.append('encoding', encoding)
  if (format) form.append('format', format)

  return apiFetch<DatanormUploadErgebnis>('/api/datanorm/upload', {
    method: 'POST',
    body: form,
  })
}

/** Eine Import-Historie-Zeile. */
export interface DatanormImportZeile {
  id: string
  lieferantId: string
  originalDateiname: string
  status: string
  artikelAnzahl: number
  artikelNeu: number
  artikelAktualisiert: number
  artikelDeaktiviert: number
  fehlerAnzahl: number
  gestartetAm: string
  beendetAm: string | null
}

/** Import-Historie laden. Admin nur. */
export async function ladeImporte(lieferantId?: string): Promise<DatanormImportZeile[]> {
  const q = lieferantId ? `?lieferantId=${encodeURIComponent(lieferantId)}` : ''
  const { treffer } = await apiFetch<{ treffer: DatanormImportZeile[] }>(
    `/api/datanorm/importe${q}`,
  )
  return treffer
}
