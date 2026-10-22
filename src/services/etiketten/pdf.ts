// PDF-Erzeugung der Etiketten-Bogen (DIN A4).
//
// Ablauf:
//   1. Layout: `planeEtiketten()` verteilt die Auswahl auf die Seiten.
//   2. Barcode: JsBarcode zeichnet den Code in ein Offscreen-Canvas
//      (300 dpi), das Ergebnis wird als PNG in das PDF eingebettet.
//      Vektor-PDF ist nicht moeglich, ohne die Barcode-Encoder selbst
//      nachzubauen — 300 dpi reicht fuer handelsuebliche Scanner.
//   3. jsPDF wird erst beim Klick geladen (`await import('jspdf')`),
//      damit das initiale Bundle der PWA klein bleibt.
//
// Alle Masse in Millimetern, Seitenformat A4 hochkant.

import JsBarcode from 'jsbarcode'
import { planeEtiketten } from './layout'
import { etikettenJeSeite, type EtikettenPreset } from './presets'
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

/** Kuerzt einen Text auf eine maximale Zeichenzahl (Anzeige mit "…"). */
export function kuerze(text: string, maxZeichen: number): string {
  if (maxZeichen <= 0) return ''
  if (text.length <= maxZeichen) return text
  return `${text.slice(0, Math.max(1, maxZeichen - 1))}…`
}

/** Grobe Zeichenbreite eines Helvetica-Satzes in mm (0.52 * Schriftgrad). */
function zeichenBreiteMm(fontSizePt: number): number {
  return (0.52 * fontSizePt * MM_PRO_INCH) / 72
}

function datumHeute(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * Erzeugt das A4-PDF der Auswahl.
 * `auswahl` = Artikel in der Reihenfolge, in der sie etikettiert werden
 * sollen. Artikel ohne Barcode werden uebersprungen (mit Warnung).
 */
export async function erzeugeEtikettenPdf(
  auswahl: EtikettDaten[],
  preset: EtikettenPreset,
  format: BarcodeTyp,
): Promise<PdfErgebnis> {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })
  const warnungen: string[] = []

  const mitBarcode = auswahl.filter((a) => {
    if (a.barcode && a.barcode.trim() !== '') return true
    warnungen.push(`${a.titel}: kein Barcode hinterlegt — Etikett übersprungen.`)
    return false
  })

  const positionen = planeEtiketten(mitBarcode.length, preset)
  const jeSeite = etikettenJeSeite(preset)
  const istListe = preset.layout === 'liste'

  // Etiketten-Box: Innenraum, Textplatz und Barcode-Flaeche.
  const boxW = preset.labelW
  const boxH = preset.labelH
  const textHoehe = istListe ? 0 : Math.min(9, boxH * 0.32)
  const barHoehe = istListe ? Math.max(3, boxH - 1.2) : boxH - 2 * PAD_MM - textHoehe
  const barBreite = istListe ? Math.min(55, boxW * 0.35) : boxW - 2 * PAD_MM

  mitBarcode.forEach((artikel, i) => {
    const pos = positionen[i]
    if (!pos) return
    if (pos.seite > 1 && (i === 0 || positionen[i - 1]?.seite !== pos.seite)) {
      doc.addPage()
    }

    const wert = (artikel.barcode ?? '').trim()
    const bild = barcodeBild(wert, format, barBreite, barHoehe)
    if (!bild) {
      warnungen.push(`${artikel.titel}: Barcode „${wert}" ist für ${format} ungültig.`)
    }

    doc.setFont('helvetica', 'normal')
    doc.setTextColor(0, 0, 0)

    if (istListe) {
      // Listenzeile: Artikelname links, Barcode-Wert + Bild rechts.
      const nameX = pos.x + 1
      const imageW = Math.min(55, boxW * 0.35)
      const imageH = Math.max(3, boxH - 1.2)
      const valueX = pos.x + boxW - 1 - imageW - 2
      const nameMax = Math.max(4, Math.floor((valueX - 4 - nameX) / zeichenBreiteMm(8)))
      doc.setFontSize(8)
      doc.text(kuerze(artikel.titel, nameMax), nameX, pos.y + boxH / 2 + 1)
      doc.setFontSize(6)
      doc.text(wert, valueX, pos.y + boxH / 2 + 1, { align: 'right' })
      if (bild) {
        const skala = Math.min(1, imageW / bild.breiteMm, imageH / bild.hoeheMm)
        const w = bild.breiteMm * skala
        const h = bild.hoeheMm * skala
        doc.addImage(bild.dataUrl, 'PNG', pos.x + boxW - 1 - w, pos.y + (boxH - h) / 2, w, h)
      }
      return
    }

    // Raster-Etikett: Barcode oben, Artikelname + Wert darunter.
    const skala = bild
      ? Math.min(1, barBreite / bild.breiteMm, Math.max(1, barHoehe) / bild.hoeheMm)
      : 1
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

    const titelY = pos.y + boxH - PAD_MM - 4.2
    doc.setFontSize(7)
    const maxZeichen = Math.max(4, Math.floor((boxW - 2 * PAD_MM) / zeichenBreiteMm(7)))
    doc.text(kuerze(artikel.titel, maxZeichen), pos.x + boxW / 2, titelY, { align: 'center' })
    doc.setFontSize(6)
    doc.text(wert, pos.x + boxW / 2, pos.y + boxH - PAD_MM, { align: 'center' })
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
    seiten: Math.max(1, Math.ceil(mitBarcode.length / jeSeite)),
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
