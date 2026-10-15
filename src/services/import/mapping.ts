// Mapping zwischen SharePoint-Spaltennamen und Dexie-Feldern.
// Beide Quell-CSVs (`Lager`, `Warenfluss`) werden hier beschrieben.

import type { ArtikelStatus, NachbestellHinweis } from '../../db/types'

/** SharePoint-Spaltenname aus dem Original-Export. */
export type SharePointSpalte = string

/** Dexie-Feld in unserem Datenmodell. */
export type ArtikelFeld =
  | 'titel'
  | 'foto'
  | 'status'
  | 'typ'
  | 'lieferant'
  | 'verpackungseinheit'
  | 'mindestbestand'
  | 'nachbestellHinweis'
  | 'bestellnummer'
  | 'barcode'
  | 'listenpreis'
  | 'geaendertAm'
  | 'sharePointId'

export type WarenFeld =
  | 'erstelltAm'
  | 'erstelltVon'
  | 'menge'
  | 'kommentar'
  | 'mitteilungAn'
  | 'projekt'
  | 'artikelTitle'
  | 'typ'
  | 'standortName'

/** Mapping-Tabelle: SharePoint-Spalte → Dexie-Feld oder null (ungenutzt). */
export type ArtikelMapping = Partial<Record<SharePointSpalte, ArtikelFeld | null>>
export type WarenMapping = Partial<Record<SharePointSpalte, WarenFeld | null>>

/** Vorschlag-Heuristik: SharePoint-Header → Dexie-Feld. */
export function defaultArtikelMapping(headers: string[]): ArtikelMapping {
  const map: ArtikelMapping = {}
  for (const h of headers) {
    const key = h.toLowerCase().replace(/[^a-z0-9äöü]/gi, '')
    if (key === 'id') map[h] = 'sharePointId'
    else if (key === 'title' || key === 'titel') map[h] = 'titel'
    else if (key === 'foto') map[h] = 'foto'
    else if (key === 'status') map[h] = 'status'
    else if (key === 'type' || key === 'typ') map[h] = 'typ'
    else if (key === 'lieferant') map[h] = 'lieferant'
    else if (key === 've' || key === 'verpackungseinheit') map[h] = 'verpackungseinheit'
    else if (key === 'bestandmin' || key === 'mindestbestand') map[h] = 'mindestbestand'
    else if (key === 'nachbestellung') map[h] = 'nachbestellHinweis'
    else if (key === 'bestellnr' || key === 'bestellnummer') map[h] = 'bestellnummer'
    else if (key === 'barcode' || key === 'ean' || key === 'strichcode') map[h] = 'barcode'
    else if (key === 'listenpreis') map[h] = 'listenpreis'
    else if (
      key === 'gendert' ||
      key === 'geaendert' ||
      key === 'geaendertam' ||
      key === 'geändert'
    )
      map[h] = 'geaendertAm'
    else map[h] = null
  }
  return map
}

export function defaultWarenMapping(headers: string[]): WarenMapping {
  const map: WarenMapping = {}
  for (const h of headers) {
    const key = h.toLowerCase().replace(/[^a-z0-9äöü]/gi, '')
    if (key === 'entnahme') map[h] = 'typ'
    else if (key === 'erstellt') map[h] = 'erstelltAm'
    else if (key === 'erstelltvon') map[h] = 'erstelltVon'
    else if (key === 'menge') map[h] = 'menge'
    else if (key === 'kommentar') map[h] = 'kommentar'
    else if (key === 'mitteilungan') map[h] = 'mitteilungAn'
    else if (key === 'projektaasa' || key === 'projektaasanummer' || key === 'projekt')
      map[h] = 'projekt'
    else if (key === 'artikel' || key === 'artikeltitle') map[h] = 'artikelTitle'
    else if (key === 'entnommenau' || key === 'standort') map[h] = 'standortName'
    else map[h] = null
  }
  return map
}

// Normalisierungs-Helfer für Enum-Felder.

export const ARTIKEL_STATUS_WERTE: ArtikelStatus[] = [
  'verfuegbar',
  'reserviert',
  'gesperrt',
  'ausgesondert',
]

export function normalizeArtikelStatus(raw: string): ArtikelStatus {
  const k = raw.toLowerCase().trim()
  if (k === '' || k === 'verfügbar' || k === 'verfuegbar') return 'verfuegbar'
  if (k === 'reserviert') return 'reserviert'
  if (k === 'gesperrt') return 'gesperrt'
  if (k === 'ausgesondert' || k === 'ausgemustert') return 'ausgesondert'
  // Fallback: nicht zuordbar → verfuegbar; Validierung meldet das.
  return 'verfuegbar'
}

export function normalizeNachbestellHinweis(raw: string): NachbestellHinweis {
  const k = raw.toLowerCase().trim()
  if (k === '' || k === 'i.o.' || k === 'io' || k === 'i.o') return 'i.O'
  if (k === 'bald') return 'bald'
  if (k === 'dringend') return 'dringend'
  return null
}

/** SharePoint-Entnahme-Typ → unser `BuchungsTyp`. */
export function normalizeWarenTyp(raw: string): 'einlagerung' | 'entnahme' | 'umlagerung' {
  const k = raw.toLowerCase().trim()
  if (k.includes('einlager')) return 'einlagerung'
  if (k.includes('umlager') || k.includes('umlag')) return 'umlagerung'
  // Standardannahme: „Entnahme" ist die häufigste Bewegung.
  return 'entnahme'
}

/** SharePoint-Menge (kann „5,5" mit Komma sein) → JS-Number. */
export function parseMenge(raw: string): number {
  return Number(raw.replace(/\./g, '').replace(',', '.'))
}

/** SharePoint-ISO oder leer → ISO-String. */
export function parseIsoDatum(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const d = new Date(trimmed)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

export function parseInt0(raw: string): number {
  const t = raw.trim()
  if (!t) return 0
  return Number.parseInt(t, 10) || 0
}

export function parseFloatOrNull(raw: string): number | null {
  const t = raw.trim()
  if (!t) return null
  const n = Number(t.replace(/\./g, '').replace(',', '.'))
  return Number.isFinite(n) ? n : null
}
