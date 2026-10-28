// Offline heuristic for the commission "Sannen" (scan) feature.
//
// Input is pasted free text from a work order / service order (Arbeits- bzw.
// Serviceauftrag). The parser handles the typical two-column PDF copy: first
// a block of labels (one per line, sometimes glued together by colons, e.g.
// `Arbeitsauftrag - Nr:Kd.-Nummer:`), then a block of values below. Label
// and value are associated line-by-line (blank value lines act as
// placeholders); date and phone values are filtered out by format. Inline
// pairs such as `Auftrags-Nr.: 908454` are recognised directly as well.
//
// Everything is pure and offline — no OCR, no network, no LLM.

export type AuftragsArt = 'kommission' | 'serviceauftrag' | 'arbeitsauftrag' | 'unbekannt'

export interface ScanKandidat {
  /** The number as it appeared in the text (trimmed). */
  wert: string
  /** Classification derived from the surrounding label. */
  art: AuftragsArt
  /** The label the number was matched to ('' for free numbers). */
  label: string
}

export interface ScanErgebnis {
  /** Recognised commission/service/work order numbers, sorted by priority. */
  kandidaten: ScanKandidat[]
  /** The highest-priority candidate, or null when nothing was found. */
  beste: ScanKandidat | null
  /** Name of an existing commission that matches the best candidate. */
  treffer: string | null
}

/** Lowercase, expand German umlauts, drop all separators. */
export function normalisiereKommission(text: string): string {
  return text
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '')
}

const KOMMISSION_WOERTER = ['kommission', 'kanr', 'projektnummer']
const SERVICE_WOERTER = [
  'serviceauftrag',
  'service',
  'einsatzauftrag',
  'einsatz',
  'stoerung',
  'sanr',
]
const AUFTRAG_WOERTER = ['arbeitsauftrag', 'auftrag', 'aanr']

/**
 * Label vocabulary: anything a label line in an order document can look
 * like. Unknown segments are NOT treated as label slots (they must not
 * consume a value during block alignment).
 */
const LABEL_WOERTER = [
  'kommission',
  'service',
  'einsatz',
  'stoerung',
  'auftrag',
  'kanr',
  'sanr',
  'aanr',
  'projekt',
  'kd',
  'kunde',
  'nr',
  'nummer',
  'beleg',
  'datum',
  'anfrage',
  'zeichen',
  'telefon',
  'mobil',
  'fax',
  'seite',
  'rechnung',
  'lieferschein',
  'angebot',
  'objekt',
  'bearbeiter',
  'sachbearbeiter',
  'hausmeister',
  'strasse',
  'email',
  'mail',
]

/** Formats that never identify a commission, regardless of their label. */
const DATUM_RE = /^\d{1,2}[./]\d{1,2}[./]\d{2,4}$/

const ZAHL_RE = /^[A-Za-z]{0,3}[-\s]?\d[\d./\s-]*\d$/

const TELEFON_RE = /^(\+|00)[\d\s()/-]{5,}$/

interface Klassifizierung {
  art: AuftragsArt | 'fremd'
  nummeriert: boolean
  imVokabular: boolean
}

function klassifiziereSegment(segment: string): Klassifizierung {
  const norm = normalisiereKommission(segment)
  const imVokabular = LABEL_WOERTER.some((w) => norm.includes(w))
  if (norm === '') return { art: 'fremd', nummeriert: false, imVokabular: false }
  if (KOMMISSION_WOERTER.some((w) => norm.includes(w)))
    return { art: 'kommission', nummeriert: true, imVokabular: true }
  if (SERVICE_WOERTER.some((w) => norm.includes(w)))
    return { art: 'serviceauftrag', nummeriert: true, imVokabular: true }
  if (AUFTRAG_WOERTER.some((w) => norm.includes(w)))
    return { art: 'arbeitsauftrag', nummeriert: true, imVokabular: true }
  const nummeriert = norm.includes('nr') || norm.includes('nummer') || norm.includes('number')
  return { art: 'fremd', nummeriert, imVokabular: imVokabular || nummeriert }
}

function anzahlZiffern(text: string): number {
  return (text.match(/\d/g) ?? []).length
}

type WertArt = 'leer' | 'datum' | 'telefon' | 'zahl' | 'text'

function klassifiziereWert(zeile: string): { art: WertArt; wert: string } {
  const roh = zeile.trim().replace(/\s+/g, ' ')
  if (roh === '') return { art: 'leer', wert: '' }
  if (DATUM_RE.test(roh)) return { art: 'datum', wert: roh }
  if (TELEFON_RE.test(roh) || roh.includes('(')) return { art: 'telefon', wert: roh }
  const match = roh.match(ZAHL_RE)
  if (match && anzahlZiffern(match[0]) >= 2) return { art: 'zahl', wert: match[0].trim() }
  return { art: 'text', wert: roh }
}

interface Paarung {
  label: string
  wert: string
}

interface Analyse {
  paarungen: Paarung[]
  freieZahlen: string[]
}

/** `Label: 908454` style pairs, extracted from a single line. */
const INLINE_RE = /([A-Za-zÄÖÜäöüßÄÖÜ._-]{2,40}?)\s*:\s*([A-Za-z]{0,3}[-\s]?\d[\d./()-]*\d)/g

function zeilenMitZiffern(zeilen: string[]): number[] {
  const idx: number[] = []
  for (let i = 0; i < zeilen.length; i++) if (/\d/.test(zeilen[i] ?? '')) idx.push(i)
  return idx
}

/**
 * Split pasted order text into label/value pairings plus free numbers.
 *
 * Two layouts are handled:
 *   1. Inline pairs (`Auftrags-Nr.: 908454`) — consumed whole-line.
 *   2. Label block followed by value block — zipped line-by-line; blank
 *      lines and date/phone/text values still consume their label slot so
 *      the positional alignment survives.
 */
function analysiere(text: string): Analyse {
  const zeilen = text.split(/\r?\n/).map((z) => z.trim())
  const paarungen: Paarung[] = []
  const freieZahlen: string[] = []

  const verbraucht = new Set<number>()

  // 1) Inline pairs first — such lines carry label and value together.
  for (let i = 0; i < zeilen.length; i++) {
    const zeile = zeilen[i] ?? ''
    if (zeile === '' || !/\d/.test(zeile)) continue
    INLINE_RE.lastIndex = 0
    let match: RegExpExecArray | null
    let gefunden = false
    while ((match = INLINE_RE.exec(zeile)) !== null) {
      const label = (match[1] ?? '').trim()
      const wert = (match[2] ?? '').trim().replace(/\s+/g, ' ')
      if (label !== '' && klassifiziereSegment(label).imVokabular && anzahlZiffern(wert) >= 2) {
        paarungen.push({ label, wert })
        gefunden = true
      }
    }
    if (gefunden) verbraucht.add(i)
  }

  const ziffernIdx = zeilenMitZiffern(zeilen).filter((i) => !verbraucht.has(i))
  const letzter = ziffernIdx[ziffernIdx.length - 1] ?? -1
  if (letzter < 0) return { paarungen, freieZahlen }

  // 2) Value run: walk back from the last remaining digit line. Digit,
  //    blank and short text lines (e.g. `cf`) belong to the run; label
  //    lines (colon or long text) end it.
  let start = letzter
  for (let i = letzter; i >= 0; i--) {
    const zeile = zeilen[i] ?? ''
    if (/\d/.test(zeile)) {
      start = i
      continue
    }
    if (zeile === '') continue
    if (zeile.includes(':')) break
    if (zeile.split(/\s+/).length <= 3 && zeile.length <= 30) continue
    break
  }

  const wertSlots: { art: WertArt; wert: string }[] = []
  for (let i = start; i <= letzter; i++) {
    if (verbraucht.has(i)) continue
    wertSlots.push(klassifiziereWert(zeilen[i] ?? ''))
  }

  // 3) Label slots: lines before the value run that contain a colon.
  //    Segments split at `:` keep document order; unknown segments are
  //    skipped so they never swallow a value.
  const labelSlots: string[] = []
  for (let i = 0; i < start; i++) {
    const zeile = zeilen[i] ?? ''
    if (zeile === '' || !zeile.includes(':')) continue
    for (const segment of zeile.split(':')) {
      const label = segment.trim()
      if (label === '') continue
      if (klassifiziereSegment(label).imVokabular) labelSlots.push(label)
    }
  }

  // 4) Zip label slots against value slots by position.
  const anzahl = Math.min(labelSlots.length, wertSlots.length)
  for (let i = 0; i < anzahl; i++) {
    const slot = wertSlots[i]
    const label = labelSlots[i]
    if (!slot || !label) continue
    if (slot.art === 'zahl') paarungen.push({ label, wert: slot.wert })
  }
  for (let i = anzahl; i < wertSlots.length; i++) {
    const slot = wertSlots[i]
    if (slot && slot.art === 'zahl') freieZahlen.push(slot.wert)
  }

  return { paarungen, freieZahlen }
}

const RANG: Record<AuftragsArt, number> = {
  kommission: 0,
  serviceauftrag: 1,
  arbeitsauftrag: 2,
  unbekannt: 3,
}

/**
 * Match a scanned number against the existing commission names — first by
 * normalised equality, then by containment ("AA 908454" contains 908454).
 */
export function matcheKommission(wert: string, vorhandene: string[]): string | null {
  const norm = normalisiereKommission(wert)
  if (norm === '') return null
  for (const name of vorhandene) if (normalisiereKommission(name) === norm) return name
  if (norm.length >= 4) {
    for (const name of vorhandene) {
      if (normalisiereKommission(name).includes(norm)) return name
    }
  }
  return null
}

/**
 * Detect the commission-relevant number in a pasted order text and match it
 * against the existing commission list.
 */
export function erkenneKommission(text: string, vorhandene: string[]): ScanErgebnis {
  const { paarungen, freieZahlen } = analysiere(text)

  const kandidaten: ScanKandidat[] = []
  for (const paar of paarungen) {
    const { art } = klassifiziereSegment(paar.label)
    if (art === 'fremd') continue
    kandidaten.push({ wert: paar.wert, art, label: paar.label })
  }

  if (kandidaten.length === 0) {
    for (const wert of freieZahlen) {
      if (anzahlZiffern(wert) < 4) continue
      kandidaten.push({ wert, art: 'unbekannt', label: '' })
      if (kandidaten.length >= 3) break
    }
  }

  kandidaten.sort((a, b) => RANG[a.art] - RANG[b.art])

  const beste = kandidaten[0] ?? null
  const treffer = beste ? matcheKommission(beste.wert, vorhandene) : null
  return { kandidaten, beste, treffer }
}
