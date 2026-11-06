// Buchungsarchiv: PDF-Export (client-seitig, jsPDF lazy import).
//
// Daten kommen direkt vom Archiv-Endpoint (POST /api/inventur/archiv).
// Der Export erfordert die Berechtigung `inventur.export`;
// Preisspalten (EK/Listenpreis) sind hier nicht verfügbar, da das Archiv
// reine Buchungszeilen ohne Preis-Snapshot ausliefert.

import { i18n } from '../../i18n'
import { version } from '../../version'

function msg(key: string, named?: Record<string, unknown>): string {
  return named === undefined ? i18n.global.t(key) : i18n.global.t(key, named)
}

function typText(typ: string): string {
  const map: Record<string, string> = {
    eingang: msg('view.inventurArchiv.typEingang'),
    ausgang: msg('view.inventurArchiv.typAusgang'),
    inventur: msg('view.inventurArchiv.typInventur'),
    storno: msg('view.inventurArchiv.typStorno'),
    kommission: msg('view.inventurArchiv.typKommission'),
    umbuchung: msg('view.inventurArchiv.typUmbuchung'),
  }
  return map[typ] ?? typ
}

/** Archiv-Einträge als PDF erzeugen (A4, quer nichts, hochformat). */
export async function exportArchivPdf(
  items: Array<{
    id: string
    typ: string
    menge: number
    erstelltAm: string
    kommentar: string | null
    artikelId: string
    standortId: string
    artikelTitel: string | null
    standortName: string | null
    erstelltVon: string | null
    projekt: string | null
    storno: boolean
    storniertDurch: string | null
  }>,
  _mitPreise: boolean,
): Promise<Blob> {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })

  let y = 20

  doc.setFontSize(16)
  doc.text(msg('view.inventurArchiv.pdfTitel'), 15, y)
  y += 8
  doc.setFontSize(10)
  doc.text(msg('view.inventurArchiv.pdfErstellt', { zeit: new Date().toISOString() }), 15, y)
  y += 6

  const colWidths = [22, 20, 14, 44, 30, 30, 26, 44]
  const headers = [
    msg('view.inventurArchiv.colDatum'),
    msg('view.inventurArchiv.colTyp'),
    msg('view.inventurArchiv.colMenge'),
    msg('view.inventurArchiv.colArtikel'),
    msg('view.inventurArchiv.colStandort'),
    msg('view.inventurArchiv.colKommission'),
    msg('view.inventurArchiv.colGebuchtVon'),
    msg('view.inventurArchiv.colKommentar'),
  ]

  // Sticky-ähnlicher Header pro Seite: bei jedem neuen Blatt wiederholen
  let seite = 1
  let zeilenAufSeite = 0

  function zeichneKopfzeile() {
    doc.setFontSize(8)
    doc.setFont('helvetica', 'bold')
    let x = 15
    headers.forEach((h, i) => {
      doc.text(h, x, y)
      x += colWidths[i]!
    })
    y += 5
    doc.setFont('helvetica', 'normal')
    zeilenAufSeite = 0
  }

  zeichneKopfzeile()

  for (const item of items) {
    if (zeilenAufSeite >= 38) {
      doc.addPage()
      seite++
      y = 20
      zeichneKopfzeile()
    }
    const x = 15
    const datum = item.erstelltAm.slice(0, 10)
    const artikel = (item.artikelTitel ?? item.artikelId).slice(0, 42)
    const standort = (item.standortName ?? item.standortId).slice(0, 28)
    const kommission = (item.projekt ?? '').slice(0, 28)
    const gebuchtVon = (item.erstelltVon ?? '').slice(0, 24)
    const kommentar = (item.kommentar ?? '').slice(0, 42)
    const stornoText = item.storno ? (item.storniertDurch ? `S(${item.storniertDurch})` : 'S') : ''

    doc.text(datum, x, y)
    doc.text(typText(item.typ), x + colWidths[0]!, y)
    doc.text(String(item.menge), x + colWidths[0]! + colWidths[1]!, y)
    doc.text(artikel, x + colWidths[0]! + colWidths[1]! + colWidths[2]!, y)
    doc.text(standort, x + colWidths[0]! + colWidths[1]! + colWidths[2]! + colWidths[3]!, y)
    doc.text(
      kommission,
      x + colWidths[0]! + colWidths[1]! + colWidths[2]! + colWidths[3]! + colWidths[4]!,
      y,
    )
    doc.text(
      gebuchtVon,
      x +
        colWidths[0]! +
        colWidths[1]! +
        colWidths[2]! +
        colWidths[3]! +
        colWidths[4]! +
        colWidths[5]!,
      y,
    )
    doc.text(
      kommentar,
      x +
        colWidths[0]! +
        colWidths[1]! +
        colWidths[2]! +
        colWidths[3]! +
        colWidths[4]! +
        colWidths[5]! +
        colWidths[6]!,
      y,
    )
    doc.text(
      stornoText,
      x +
        colWidths[0]! +
        colWidths[1]! +
        colWidths[2]! +
        colWidths[3]! +
        colWidths[4]! +
        colWidths[5]! +
        colWidths[6]! +
        colWidths[7]!,
      y,
    )
    y += 4
    zeilenAufSeite++
  }

  // Fußzeile auf jeder Seite
  const jetzt = new Date().toISOString()
  for (let pageNum = 1; pageNum <= seite; pageNum++) {
    doc.setPage(pageNum)
    doc.setFontSize(8)
    doc.text(
      msg('view.inventurArchiv.pdfFusszeile', {
        zeit: jetzt,
        version: `v${version}`,
        seite: pageNum,
        gesamt: seite,
      }),
      15,
      doc.internal.pageSize.height - 10,
    )
  }

  return doc.output('blob')
}
