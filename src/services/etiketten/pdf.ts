// PDF-Erzeugung der Etiketten-Bogen (DIN A4).
//
// Ablauf:
//   1. Layout: `planeEtiketten()` verteilt die Auswahl auf die Seiten.
//   2. Artikelname: `passeTextEin()` bricht den Namen wortweise um und
//      waehlt die groesste Schriftgroesse, die in die Textzone passt.
//      Der Name bleibt vollstaendig — erst wenn selbst die kleinste Groesse
//      nicht reicht, wird die letzte Zeile mit "…" gekuerzt und eine
//      Warnung ausgegeben.
//   3. Barcode: JsBarcode zeichnet den Code in ein Offscreen-Canvas
//      (300 dpi), das Ergebnis wird als PNG in das PDF eingebettet.
//      Vektor-PDF ist nicht moeglich, ohne die Barcode-Encoder selbst
//      nachzubauen — 300 dpi reicht fuer handelsuebliche Scanner.
//      Der Code weicht dem Namen bis auf `BARCODE_MIN_HOEHE_MM`.
//   4. jsPDF wird erst beim Klick geladen (`await import('jspdf')`),
//      damit das initiale Bundle der PWA klein bleibt.
//
// Alle Masse in Millimetern, Seitenformat A4 hochkant.

import JsBarcode from 'jsbarcode'
import type { jsPDF } from 'jspdf'
import { planeEtiketten, type EtikettPosition } from './layout'
import { seitenAnzahl, type EtikettenPreset } from './presets'
import type { BarcodeTyp } from '../../stores/settings'

/** Aufloesung der eingebetteten Barcode-Bilder. */
const DPI = 300
const MM_PRO_INCH = 25.4
/** Ziel-Modulbreite eines Barcodes in mm (handelsueblich 0.33–0.5 mm). */
const MODUL_MM = 0.4
/** Wunschhoehe des Barcodes in mm. */
const BARCODE_HOEHE_MM = 12
/** Innenabstand des Etiketts in mm. */
const PAD_MM = 1.5
/** Innenabstand einer Listenzeile in mm. */
const LISTE_PAD_MM = 1
/** Mindesthoehe des Barcodes, wenn der Artikelname mehr Platz braucht. */
const BARCODE_MIN_HOEHE_MM = 6
/** Mindesthoehe des Barcodes in einer Listenzeile (flache Zeilen). */
const LISTE_BAR_MIN_HOEHE_MM = 4
/** Textzone (Name + Barcode-Wert) in mm, solange der Name hineinpasst. */
const TEXT_ZONE_MM = 9
/** Anteil der Etikettenhoehe, die maximal als Textzone dienen darf. */
const TEXT_ZONE_ANTEIL = 0.32
/** Faktor der Zeilenhoehe relativ zum Schriftgrad. */
const ZEILEN_FAKTOR = 1.2
/** Schriftgroessen des Artikelnamens in pt (abwaerts probiert, abbruchsicher). */
const NAMEN_GROSSEN_RASTER = [7, 6.5, 6, 5.5, 5]
const NAMEN_GROSSEN_LISTE = [8, 7, 6.5, 6, 5.5, 5]
/** Schriftgroessen des Barcode-Werts in pt (abwaerts probiert). */
const WERT_GROESSE_PT = 6
const WERT_GROSSEN = [WERT_GROESSE_PT, 5.5, 5, 4.5]

export interface EtikettDaten {
  id: string
  titel: string
  typ: string
  barcode: string | null
}

export interface PdfErgebnis {
  blob: Blob
  dateiname: string
  seiten: number
  /** Hinweise (z. B. ungueltige Barcode-Werte) — der Bogen wird trotzdem erzeugt. */
  warnungen: string[]
}

interface BarcodeBild {
  dataUrl: string
  /** natuerliche Breite in mm (px / dpi) */
  breiteMm: number
  /** natuerliche Hoehe in mm (px / dpi) */
  hoeheMm: number
}

/** Misst die Textbreite in mm ( fuer eine feste Schriftgroesse). */
export type BreitenMesser = (text: string) => number
/** Misst die Textbreite in mm bei beliebigem Schriftgrad in pt. */
export type SkalenMesser = (text: string, groessePt: number) => number

function pxZuMm(px: number): number {
  return (px / DPI) * MM_PRO_INCH
}

export interface BarcodeGeometrie {
  /** Modulbreite in px (ein Modul = ein Balken + Zwischenraum). */
  modulPx: number
  /** Balkenhoehe in px. */
  hoehePx: number
  /** Balkenhoehe in mm. */
  hoeheMm: number
}

/**
 * Berechnet die Rastergroesse des Barcodes (rein, ohne Canvas).
 *
 * Der Barcode wird mit `modulPx` Pixeln je Modul gezeichnet; die
 * Balkenhoehe richtet sich nach dem verfuegbaren Platz im Etikett.
 * Bei sehr langen Codes (z. B. Code128 mit 30 Zeichen) schrumpft die
 * Modulbreite, bis der Code in die Etikettenbreite passt.
 */
export function barcodeGeometrie(
  moduleCount: number,
  verfuegbareBreiteMm: number,
  verfuegbareHoeheMm: number,
): BarcodeGeometrie {
  const zielBreiteMm = Math.min(verfuegbareBreiteMm, moduleCount * MODUL_MM)
  const zielBreitePx = Math.max(1, Math.round((zielBreiteMm / MM_PRO_INCH) * DPI))
  const modulPx = Math.max(1, Math.floor(zielBreitePx / moduleCount))
  const hoeheMm = Math.max(3, Math.min(BARCODE_HOEHE_MM, verfuegbareHoeheMm))
  const hoehePx = Math.max(30, Math.round((hoeheMm / MM_PRO_INCH) * DPI))
  return { modulPx, hoehePx, hoeheMm }
}

/**
 * Rendert einen Barcode in ein Canvas und liefert ihn als PNG-Data-URL.
 * `null`, wenn der Wert fuer das Format ungueltig ist (z. B. EAN-13 mit
 * 8 Ziffern) — der Aufrufer zeichnet dann einen Platzhalter.
 */
function barcodeBild(
  wert: string,
  format: BarcodeTyp,
  verfuegbareBreiteMm: number,
  verfuegbareHoeheMm: number,
): BarcodeBild | null {
  if (typeof document === 'undefined') return null

  // 1) Probe mit 1 px je Modul -> daraus die Modulanzahl.
  let moduleCount = 0
  try {
    const probe = document.createElement('canvas')
    JsBarcode(probe, wert, {
      format,
      width: 1,
      height: 10,
      displayValue: false,
      margin: 0,
    })
    moduleCount = probe.width
  } catch {
    return null
  }
  if (!Number.isFinite(moduleCount) || moduleCount <= 0) return null

  // 2) Rastergroesse berechnen und den Barcode zeichnen.
  const geo = barcodeGeometrie(moduleCount, verfuegbareBreiteMm, verfuegbareHoeheMm)

  try {
    const canvas = document.createElement('canvas')
    JsBarcode(canvas, wert, {
      format,
      width: geo.modulPx,
      height: geo.hoehePx,
      displayValue: false,
      margin: 0,
    })
    return {
      dataUrl: canvas.toDataURL('image/png'),
      breiteMm: pxZuMm(canvas.width),
      hoeheMm: pxZuMm(canvas.height),
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Textlayout (rein, ohne jsPDF — die Breite kommt per Messer herein)
// ---------------------------------------------------------------------------

/** Zeilenhoehe (Baselines-Abstand) eines Helvetica-Satzes in mm. */
export function zeilenHoeheMm(fontSizePt: number): number {
  return (fontSizePt * ZEILEN_FAKTOR * MM_PRO_INCH) / 72
}

/** Abstand zweier Textblock-Stapel (Name / Barcode-Wert) in mm. */
function textAbstandMm(nameZeileMm: number, wertZeileMm: number): number {
  return 0.45 * (nameZeileMm + wertZeileMm)
}

/** Laengste Zeichenkette am Anfang von `text`, die in `maxBreiteMm` passt. */
function langsterPraefix(text: string, maxBreiteMm: number, messen: BreitenMesser): number {
  let lo = 1
  let hi = text.length - 1
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (messen(text.slice(0, mid)) <= maxBreiteMm) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * Bricht `text` wortweise auf eine maximale Breite um. Woerter, die allein
 * breiter sind als die Zeile, werden an der Zeichenkette getrennt.
 */
export function zeilenUmbrechen(
  text: string,
  maxBreiteMm: number,
  messen: BreitenMesser,
): string[] {
  const worte = text
    .trim()
    .split(/\s+/)
    .filter((wort) => wort !== '')
  if (worte.length === 0 || maxBreiteMm <= 0) return []

  const zeilen: string[] = []
  let aktuelle = ''
  const abschliessen = (): void => {
    if (aktuelle !== '') {
      zeilen.push(aktuelle)
      aktuelle = ''
    }
  }

  for (const wort of worte) {
    if (aktuelle === '') {
      aktuelle = wort
    } else if (messen(`${aktuelle} ${wort}`) <= maxBreiteMm) {
      aktuelle = `${aktuelle} ${wort}`
    } else {
      abschliessen()
      aktuelle = wort
    }
    // Einzelwort breiter als die Zeile -> hart trennen.
    while (aktuelle.length > 1 && messen(aktuelle) > maxBreiteMm) {
      const schnitt = langsterPraefix(aktuelle, maxBreiteMm, messen)
      zeilen.push(aktuelle.slice(0, schnitt))
      aktuelle = aktuelle.slice(schnitt)
    }
  }
  abschliessen()
  return zeilen
}

/** Kuerzt einen Text auf eine maximale Breite (ohne Marker, wenn er passt). */
export function kuerzeBreite(text: string, maxBreiteMm: number, messen: BreitenMesser): string {
  if (text === '') return ''
  if (messen(text) <= maxBreiteMm) return text
  return mitAuslassung(text, maxBreiteMm, messen)
}

/** Kuerzt auf die Breite und setzt in jedem Fall "…" dahinter. */
function mitAuslassung(text: string, maxBreiteMm: number, messen: BreitenMesser): string {
  if (messen(`${text}…`) <= maxBreiteMm) return `${text}…`
  let ende = text.length
  while (ende > 1 && messen(`${text.slice(0, ende)}…`) > maxBreiteMm) ende -= 1
  return `${text.slice(0, ende)}…`
}

export interface Passform {
  zeilen: string[]
  groessePt: number
  /** true, wenn der Text nicht vollstaendig passte (letzte Zeile mit "…"). */
  abgeschnitten: boolean
}

/**
 * Wahlt die groesste Schriftgroesse aus `groessenPt` (absteigend), deren
 * umbrochener Text in Breite und Hoehe passt. Reicht die kleinste Groesse
 * nicht, werden Zeilen verworfen und die letzte mit "…" gekuerzt —
 * `abgeschnitten` zeigt das dem Aufrufer an.
 */
export function passeTextEin(
  text: string,
  groessenPt: number[],
  maxBreiteMm: number,
  maxHoeheMm: number,
  messen: SkalenMesser,
): Passform {
  const groessen = groessenPt.filter((g) => Number.isFinite(g) && g > 0).sort((a, b) => b - a)
  if (text.trim() === '') {
    return { zeilen: [], groessePt: groessen[0] ?? 0, abgeschnitten: false }
  }
  if (groessen.length === 0 || maxBreiteMm <= 0 || maxHoeheMm <= 0) {
    return { zeilen: [], groessePt: 0, abgeschnitten: true }
  }

  for (const groesse of groessen) {
    const zeilen = zeilenUmbrechen(text, maxBreiteMm, (t) => messen(t, groesse))
    if (zeilen.length * zeilenHoeheMm(groesse) <= maxHoeheMm + 1e-6) {
      return { zeilen, groessePt: groesse, abgeschnitten: false }
    }
  }

  const kleinste = groessen[groessen.length - 1]
  if (kleinste === undefined) return { zeilen: [], groessePt: 0, abgeschnitten: true }
  const messer: BreitenMesser = (t) => messen(t, kleinste)
  const zeilen = zeilenUmbrechen(text, maxBreiteMm, messer)
  const maxZeilen = Math.max(1, Math.floor((maxHoeheMm + 1e-6) / zeilenHoeheMm(kleinste)))
  const gekuerzt = zeilen.slice(0, maxZeilen)
  const letzte = gekuerzt[gekuerzt.length - 1]
  if (letzte !== undefined) {
    gekuerzt[gekuerzt.length - 1] = mitAuslassung(letzte, maxBreiteMm, messer)
  }
  return { zeilen: gekuerzt, groessePt: kleinste, abgeschnitten: true }
}

/** Einzeilige Darstellung: groesste Groesse, sonst letzte Groesse mit "…". */
export function einzeilig(
  text: string,
  groessenPt: number[],
  maxBreiteMm: number,
  messen: SkalenMesser,
): { text: string; groessePt: number } {
  const groessen = groessenPt.filter((g) => Number.isFinite(g) && g > 0).sort((a, b) => b - a)
  for (const groesse of groessen) {
    if (messen(text, groesse) <= maxBreiteMm) return { text, groessePt: groesse }
  }
  const kleinste = groessen[groessen.length - 1] ?? 0
  if (kleinste <= 0 || maxBreiteMm <= 0) return { text: '', groessePt: 0 }
  return {
    text: kuerzeBreite(text, maxBreiteMm, (t) => messen(t, kleinste)),
    groessePt: kleinste,
  }
}

// ---------------------------------------------------------------------------
// Zeichnen
// ---------------------------------------------------------------------------

function datumHeute(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

interface ZeichenKontext {
  doc: jsPDF
  misst: SkalenMesser
  format: BarcodeTyp
  warnungen: string[]
}

/**
 * Raster-Etikett: Barcode oben, Artikelname (mehrzeilig) + Barcode-Wert
 * darunter. Die Textzone waechst mit dem Namen — der Barcode weicht bis auf
 * `BARCODE_MIN_HOEHE_MM` zurueck.
 */
function zeichneRaster(
  ctx: ZeichenKontext,
  pos: EtikettPosition,
  artikel: EtikettDaten,
  wert: string,
  boxW: number,
  boxH: number,
): void {
  const { doc, misst, format, warnungen } = ctx
  const innenBreite = boxW - 2 * PAD_MM
  const innenHoehe = boxH - 2 * PAD_MM
  const wertZeile = zeilenHoeheMm(WERT_GROESSE_PT)
  const zoneStandard = Math.min(TEXT_ZONE_MM, boxH * TEXT_ZONE_ANTEIL)
  const zoneMax = Math.max(zoneStandard, innenHoehe - BARCODE_MIN_HOEHE_MM)
  const groessteName = Math.max(...NAMEN_GROSSEN_RASTER)
  const nameBudget = Math.max(
    1,
    zoneMax - wertZeile - textAbstandMm(zeilenHoeheMm(groessteName), wertZeile),
  )

  const name = passeTextEin(artikel.titel, NAMEN_GROSSEN_RASTER, innenBreite, nameBudget, misst)
  const nameZeile = zeilenHoeheMm(name.groessePt)
  const abstand = textAbstandMm(nameZeile, wertZeile)
  const benoetigt = name.zeilen.length * nameZeile + abstand + wertZeile
  const zone = Math.min(zoneMax, Math.max(zoneStandard, benoetigt))
  const barHoehe = Math.max(3, innenHoehe - zone)

  const bild = barcodeBild(wert, format, innenBreite, barHoehe)
  if (!bild) {
    warnungen.push(`${artikel.titel}: Barcode „${wert}" ist für ${format} ungültig.`)
  }

  // Barcode oben, zentriert in der freien Flaeche.
  const skala = bild ? Math.min(1, innenBreite / bild.breiteMm, barHoehe / bild.hoeheMm) : 1
  const bW = bild ? bild.breiteMm * skala : 0
  const bH = bild ? bild.hoeheMm * skala : 0
  const bX = pos.x + (boxW - bW) / 2
  const bY = pos.y + PAD_MM + Math.max(0, (barHoehe - bH) / 2)
  if (bild) {
    doc.addImage(bild.dataUrl, 'PNG', bX, bY, bW, bH)
  } else {
    // Kein valider Barcode: Platzhalter in der Barcode-Flaeche, damit
    // die Luecke auf dem Bogen sichtbar ist.
    doc.setFontSize(8)
    doc.text('kein gueltiger Barcode', pos.x + boxW / 2, bY + barHoehe / 2, { align: 'center' })
  }

  // Barcode-Wert auf der letzten Baseline, Name darueber (von unten nach oben).
  const mitte = pos.x + boxW / 2
  const wertDarstellung = einzeilig(wert, WERT_GROSSEN, innenBreite, misst)
  doc.setFontSize(wertDarstellung.groessePt)
  doc.text(wertDarstellung.text, mitte, pos.y + boxH - PAD_MM, { align: 'center' })

  doc.setFontSize(name.groessePt)
  const untersteBaseline = pos.y + boxH - PAD_MM - abstand
  name.zeilen.forEach((zeile, idx) => {
    const vonUnten = name.zeilen.length - 1 - idx
    doc.text(zeile, mitte, untersteBaseline - vonUnten * nameZeile, { align: 'center' })
  })

  if (name.abgeschnitten) {
    warnungen.push(
      `${artikel.titel}: Name passt nicht vollständig aufs Etikett (${name.groessePt} pt, ${name.zeilen.length} Zeile(n)).`,
    )
  }
}

/**
 * Listenzeile: Artikelname links (bis zu zwei Zeilen, mehr wenn die Schrift
 * dafuer kleiner wird), Barcode rechts, Barcode-Wert unter dem Code.
 */
function zeichneListe(
  ctx: ZeichenKontext,
  pos: EtikettPosition,
  artikel: EtikettDaten,
  wert: string,
  boxW: number,
  boxH: number,
): void {
  const { doc, misst, format, warnungen } = ctx
  const wertZeile = zeilenHoeheMm(WERT_GROESSE_PT)
  const innenHoehe = boxH - 2 * LISTE_PAD_MM
  // Der Barcode-Wert braucht eine eigene Zeile unter dem Code — wenn die
  // Zeile dafuer zu flach ist, faellt er weg.
  const zeigtWert = innenHoehe - LISTE_BAR_MIN_HOEHE_MM >= wertZeile
  const imageW = Math.min(45, boxW * 0.26)
  const nameX = pos.x + LISTE_PAD_MM
  const nameBreite = boxW - 2 * LISTE_PAD_MM - imageW - 3
  const name = passeTextEin(artikel.titel, NAMEN_GROSSEN_LISTE, nameBreite, innenHoehe, misst)
  const barHoehe = Math.max(
    LISTE_BAR_MIN_HOEHE_MM,
    innenHoehe - (zeigtWert ? zeilenHoeheMm(WERT_GROESSE_PT) : 0),
  )

  const bild = barcodeBild(wert, format, imageW, barHoehe)
  if (!bild) {
    warnungen.push(`${artikel.titel}: Barcode „${wert}" ist für ${format} ungültig.`)
  }

  const nameZeile = zeilenHoeheMm(name.groessePt)
  const blockHoehe = name.zeilen.length * nameZeile
  const yStart = pos.y + Math.max(LISTE_PAD_MM, (boxH - blockHoehe) / 2) + nameZeile * 0.8
  doc.setFontSize(name.groessePt)
  name.zeilen.forEach((zeile, idx) => {
    doc.text(zeile, nameX, yStart + idx * nameZeile)
  })

  const codeX = pos.x + boxW - LISTE_PAD_MM
  if (bild) {
    const skala = Math.min(1, imageW / bild.breiteMm, barHoehe / bild.hoeheMm)
    const w = bild.breiteMm * skala
    const h = bild.hoeheMm * skala
    doc.addImage(bild.dataUrl, 'PNG', codeX - w, pos.y + LISTE_PAD_MM, w, h)
  } else {
    doc.setFontSize(6)
    doc.text('kein gueltiger Barcode', codeX, pos.y + boxH / 2, { align: 'right' })
  }

  if (zeigtWert) {
    const darstellung = einzeilig(wert, WERT_GROSSEN, imageW, misst)
    doc.setFontSize(darstellung.groessePt)
    doc.text(darstellung.text, codeX, pos.y + boxH - LISTE_PAD_MM, { align: 'right' })
  }

  if (name.abgeschnitten) {
    warnungen.push(
      `${artikel.titel}: Name passt nicht vollständig aufs Etikett (${name.groessePt} pt, ${name.zeilen.length} Zeile(n)).`,
    )
  }
}

/**
 * Erzeugt das A4-PDF der Auswahl.
 * `auswahl` = Artikel in der Reihenfolge, in der sie etikettiert werden
 * sollen. Artikel ohne Barcode werden uebersprungen (mit Warnung).
 *
 * `startFeld` (1-basiert, von links oben) ueberspringt auf der ersten
 * Seite die bereits benutzten Felder eines angebrochenen Bogens.
 */
export async function erzeugeEtikettenPdf(
  auswahl: EtikettDaten[],
  preset: EtikettenPreset,
  format: BarcodeTyp,
  startFeld = 1,
): Promise<PdfErgebnis> {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })
  const warnungen: string[] = []

  const mitBarcode = auswahl.filter((a) => {
    if (a.barcode && a.barcode.trim() !== '') return true
    warnungen.push(`${a.titel}: kein Barcode hinterlegt — Etikett übersprungen.`)
    return false
  })

  const positionen = planeEtiketten(mitBarcode.length, preset, startFeld)
  const istListe = preset.layout === 'liste'
  const boxW = preset.labelW
  const boxH = preset.labelH

  doc.setFont('helvetica', 'normal')
  doc.setTextColor(0, 0, 0)
  // Echte Helvetica-Metriken statt Zeichen-Zaehlung: nur so ist der Umbruch
  // identisch mit dem, spaeter auch gedruckt wird.
  const misst: SkalenMesser = (text, groessePt) => {
    doc.setFontSize(groessePt)
    return doc.getTextWidth(text)
  }
  const ctx: ZeichenKontext = { doc, misst, format, warnungen }

  mitBarcode.forEach((artikel, i) => {
    const pos = positionen[i]
    if (!pos) return
    if (pos.seite > 1 && (i === 0 || positionen[i - 1]?.seite !== pos.seite)) {
      doc.addPage()
    }
    const wert = (artikel.barcode ?? '').trim()
    if (istListe) {
      zeichneListe(ctx, pos, artikel, wert, boxW, boxH)
      return
    }
    zeichneRaster(ctx, pos, artikel, wert, boxW, boxH)
  })

  // Wenn nichts druckbar war, bleibt ein leeres Blatt — besser ein Hinweis
  // auf der Seite, damit der Nutzer nicht glaubt, es sei gedruckt worden.
  if (mitBarcode.length === 0) {
    doc.setFontSize(12)
    doc.text('Keine Artikel mit Barcode ausgewählt.', 105, 150, { align: 'center' })
  }

  const blob = doc.output('blob')
  const dateiname = `etiketten-${datumHeute()}-${mitBarcode.length}.pdf`
  return {
    blob,
    dateiname,
    seiten: Math.max(1, seitenAnzahl(mitBarcode.length, preset, startFeld)),
    warnungen,
  }
}

/** Startet den Download einer erzeugten PDF-Datei. */
export function downloadPdf(blob: Blob, dateiname: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = dateiname
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
