// Extraktion der Kommissionsnummer aus OCR-Text (Kamera-Scan).
//
// Der OCR-Text ist unsauber: Zeilenumbrüche fehlen, Labels stehen
// manchmal in einer eigenen Zeile über dem Wert, Zeichen werden
// vertauscht. Deshalb greifen hier zwei Heuristiken:
//
//   1) Inline-Muster — "Projektnummer: AA 1234", "AA: 1234", "SA: 5678",
//      "Servicenummer 91011", "Kommission K-22" usw.
//   2) Die bestehende Auftrags-Parser-Logik (domain/kommission-scan.ts),
//      die Label-Block und Wert-Block positionell zuordnet.
//
// Findet sich kein Label, greift ein Rückfall: plausible Nummern aus
// freiem Text (Datum, Uhrzeit und Telefonnummer werden verworfen) —
// der User markiert den Ausschnitt ja oft über genau der Nummer.

import { erkenneKommission, normalisiereKommission, type AuftragsArt } from './kommission-scan'

export interface OcrKandidat {
  /** Die erkannte Nummer (bereits getrimmt, Leerzeichen normalisiert). */
  wert: string
  /** Das Keyword, dem die Nummer folgt (z. B. "Projektnummer"). */
  keyword: string
  /** Der umgebende Textabschnitt — hilft dem User beim Prüfen. */
  kontext: string
  /** Herkunft: an einem Label erkannt oder als freie Nummer gefunden. */
  quelle: 'label' | 'frei'
}

/**
 * Eine Kommissionsnummer: optionaler Buchstaben-Präfix, optionaler
 * Trenner, dann Ziffern. Leerzeichen sind nur zwischen Präfix und
 * Ziffern erlaubt ("AA 1234"), damit der Fang nicht ins nächste Feld
 * hineinläuft.
 */
const NUMMER = '[A-Za-z]{0,6}[-/. ]?\\d[\\dA-Za-z./-]{0,30}'

interface KeywordMuster {
  label: string
  re: RegExp
  /** Niedrigere Zahl = höhere Priorität. */
  rang: number
}

const KEYWORD_MUSTER: KeywordMuster[] = [
  {
    label: 'Projektnummer',
    rang: 0,
    re: new RegExp(`projekt[\\s-]*nummer\\s*[:=]?\\s*(${NUMMER})`, 'gi'),
  },
  { label: 'Projektnr', rang: 0, re: new RegExp(`projektnr\\s*[:=]?\\s*(${NUMMER})`, 'gi') },
  { label: 'Kommission', rang: 0, re: new RegExp(`kommission\\s*[:=]?\\s*(${NUMMER})`, 'gi') },
  { label: 'KomNr', rang: 0, re: new RegExp(`komnr\\s*[:=]?\\s*(${NUMMER})`, 'gi') },
  { label: 'AA', rang: 0, re: new RegExp(`\\bAA\\s*[:=]\\s*(${NUMMER})`, 'gi') },
  { label: 'SA', rang: 1, re: new RegExp(`\\bSA\\s*[:=]\\s*(${NUMMER})`, 'gi') },
  {
    label: 'Servicenummer',
    rang: 1,
    re: new RegExp(`service[\\s-]*nummer\\s*[:=]?\\s*(${NUMMER})`, 'gi'),
  },
  { label: 'Servicenr', rang: 1, re: new RegExp(`service[\\s-]*nr\\s*[:=]?\\s*(${NUMMER})`, 'gi') },
  {
    label: 'Auftragsnummer',
    rang: 2,
    re: new RegExp(`auftrag[\\s-]*nummer\\s*[:=]?\\s*(${NUMMER})`, 'gi'),
  },
  { label: 'AANr', rang: 2, re: new RegExp(`\\bAANr\\s*[:=]?\\s*(${NUMMER})`, 'gi') },
]

/** Rang der Auftragsart aus domain/kommission-scan.ts. */
const ART_RANG: Record<AuftragsArt, number> = {
  kommission: 0,
  serviceauftrag: 1,
  arbeitsauftrag: 2,
  unbekannt: 3,
}

const DATUM_RE = /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/
const ZEIT_RE = /^\d{1,2}[:.]\d{2}([:.]\d{2})?$/
const TOKEN_RE = /[A-Za-z0-9][A-Za-z0-9./-]{1,40}/g

function anzahlZiffern(text: string): number {
  return (text.match(/\d/g) ?? []).length
}

/**
 * Prüft, ob die Zeile eine Telefonnummer enthaelt — dann liefert sie
 * keine Kommissionsnummer. Ein vorangestelltes Label ("Tel: …") wird
 * uebersprungen.
 */
function istTelefonzeile(zeile: string): boolean {
  const roh = zeile.trim()
  if (roh === '') return false
  const nachLabel = roh.includes(':') ? roh.slice(roh.lastIndexOf(':') + 1).trim() : roh
  if (nachLabel === '') return false
  if (!/^\+?\d[\d\s()/-]*$/.test(nachLabel)) return false
  return anzahlZiffern(nachLabel) >= 9
}

/** Normalisiert eine erkannte Nummer (trimmt, Leerzeichen zusammenfasst). */
export function normalisiereOcrNummer(wert: string): string {
  return wert.trim().replace(/\s+/g, ' ')
}

/**
 * Prüft, ob ein freistehendes Token wie eine Kommissionsnummer aussieht.
 * Datum, Uhrzeit und Telefonnummer werden verworfen.
 */
export function istPlausibleNummer(token: string): boolean {
  const wert = token.trim()
  if (wert.length < 2) return false
  if (DATUM_RE.test(wert)) return false
  if (ZEIT_RE.test(wert)) return false
  if (wert.startsWith('+')) return false
  const ziffern = anzahlZiffern(wert)
  if (ziffern < 2) return false
  // Lange reine Ziffernketten sind Telefonnummern oder Beträge.
  if (ziffern >= 9 && !/[A-Za-z]/.test(wert)) return false
  return true
}

/** Inline-Muster: Keyword und Nummer stehen in derselben Zeile. */
function inlineKandidaten(text: string): Array<OcrKandidat & { rang: number }> {
  const zeilen = text.split(/\r?\n/)
  const treffer: Array<OcrKandidat & { rang: number }> = []

  for (const zeile of zeilen) {
    const roh = zeile.trim()
    if (roh === '' || !/\d/.test(roh)) continue
    for (const muster of KEYWORD_MUSTER) {
      for (const match of roh.matchAll(muster.re)) {
        const wert = normalisiereOcrNummer(match[1] ?? '')
        if (wert.length < 2 || !/\d/.test(wert)) continue
        treffer.push({
          wert,
          keyword: muster.label,
          kontext: roh,
          quelle: 'label',
          rang: muster.rang,
        })
      }
    }
  }
  return treffer
}

/** Freie Nummern ohne Label — z. B. wenn der User nur die Nummer markiert. */
function freieKandidaten(text: string): Array<OcrKandidat & { rang: number }> {
  const treffer: Array<OcrKandidat & { rang: number }> = []
  const zeilen = text.split(/\r?\n/)

  for (const zeile of zeilen) {
    const roh = zeile.trim()
    if (roh === '') continue
    if (istTelefonzeile(roh)) continue
    // Datum und Uhrzeit herausschneiden, sonst zerfaellt "14:30" in
    // zwei Token ("14" und "30"), die wie Nummern aussehen.
    const ohneDatum = roh.replace(/\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/g, ' ')
    const ohneZeit = ohneDatum.replace(/\b\d{1,2}[:.]\d{2}([:.]\d{2})?\b/g, ' ')
    for (const match of ohneZeit.matchAll(TOKEN_RE)) {
      const token = match[0]
      if (!istPlausibleNummer(token)) continue
      treffer.push({
        wert: normalisiereOcrNummer(token),
        keyword: '',
        kontext: roh,
        quelle: 'frei',
        rang: 3,
      })
    }
  }
  return treffer
}

/**
 * Extrahiert die Kommissionsnummer aus OCR-Text.
 *
 * Die Kandidaten sind nach Priorität sortiert (Projektnummer/Kommission
 * vor Service- vor Arbeitsauftrag-Nummer). Freie Nummern ohne Label
 * stehen hinten — dort entscheidet der User.
 */
export function extrahiereKommissionsNummer(text: string): OcrKandidat[] {
  const inline = inlineKandidaten(text)

  // Die Auftrags-Parser-Logik deckt den Label-Block/Wert-Block-Aufbau ab.
  const auftrag = erkenneKommission(text, []).kandidaten.map((k) => ({
    wert: normalisiereOcrNummer(k.wert),
    keyword: k.label,
    kontext: k.label,
    quelle: (k.art === 'unbekannt' ? 'frei' : 'label') as 'label' | 'frei',
    rang: ART_RANG[k.art],
  }))

  const eigeneFreie = freieKandidaten(text)

  const labelKandidaten = [...inline, ...auftrag.filter((k) => k.quelle === 'label')]
  const freie = [...eigeneFreie, ...auftrag.filter((k) => k.quelle === 'frei')]

  // Eine freie Nummer, die bereits in einer Label-Nummer steckt, ist
  // doppelt ("AA 1234" und "1234") — die Label-Nummer gewinnt.
  const labelNorm = labelKandidaten.map((k) => normalisiereKommission(k.wert))
  const gefiltertFrei = freie.filter((k) => {
    const norm = normalisiereKommission(k.wert)
    if (norm.length < 2) return false
    return !labelNorm.some((ln) => ln.length > norm.length && ln.includes(norm))
  })

  const kandidaten = [...labelKandidaten, ...gefiltertFrei]

  kandidaten.sort((a, b) => a.rang - b.rang)

  // Nach normalisiertem Wert deduplizieren — der beste Treffer gewinnt.
  // Datum, Uhrzeit und Telefonnummer fallen dabei raus.
  const gesehen = new Set<string>()
  const ergebnis: OcrKandidat[] = []
  for (const k of kandidaten) {
    if (!istPlausibleNummer(k.wert)) continue
    const key = normalisiereKommission(k.wert)
    if (key === '' || gesehen.has(key)) continue
    gesehen.add(key)
    const { rang: _rang, ...kandidat } = k
    ergebnis.push(kandidat)
  }

  return ergebnis
}
