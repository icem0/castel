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

type ArchivEntry = {
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
}

// Nine columns must fit into the printable width of an A4 portrait sheet (210mm).
export const archivColWidths = [17, 17, 10, 28, 22, 24, 20, 28, 12]
export const archivMarginLeft = 15
export const archivPageWidth = 210

/** Archive rows as PDF (A4, portrait). */
export async function exportArchivPdf(items: ArchivEntry[], _mitPreise: boolean): Promise<Blob> {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  const pageHeight = doc.internal.pageSize.height

  const headers = [
    msg('view.inventurArchiv.colDatum'),
    msg('view.inventurArchiv.colTyp'),
    msg('view.inventurArchiv.colMenge'),
    msg('view.inventurArchiv.colArtikel'),
    msg('view.inventurArchiv.colStandort'),
    msg('view.inventurArchiv.colKommission'),
    msg('view.inventurArchiv.colGebuchtVon'),
    msg('view.inventurArchiv.colKommentar'),
    msg('view.inventurArchiv.colStorno'),
  ]

  // Nine columns have to fit into the printable width of an A4 portrait sheet.
  const colWidths = archivColWidths
  const left = archivMarginLeft

  function colX(col: number): number {
    let x = left
    for (let i = 0; i < col; i++) x += colWidths[i]!
    return x
  }

  // Shrink a cell to its column, so nothing spills beyond the page edge.
  function clip(text: string, col: number): string {
    if (!text) return ''
    const max = colWidths[col]! - 2
    let out = text
    while (out.length > 1 && doc.getTextWidth(out) > max) out = out.slice(0, -1)
    return doc.getTextWidth(out) <= max ? out : ''
  }

  let y = 20

  doc.setFontSize(16)
  doc.text(msg('view.inventurArchiv.pdfTitel'), left, y)
  y += 8
  doc.setFontSize(10)
  doc.text(msg('view.inventurArchiv.pdfErstellt', { zeit: new Date().toISOString() }), left, y)
  y += 7

  // Header repeated on every sheet.
  function zeichneKopfzeile(): void {
    doc.setFontSize(8)
    doc.setFont('helvetica', 'bold')
    let maxLines = 1
    headers.forEach((h, i) => {
      const lines = doc.splitTextToSize(h, colWidths[i]! - 2)
      maxLines = Math.max(maxLines, lines.length)
      doc.text(lines, colX(i), y)
    })
    y += maxLines * 3 + 2
    doc.setFont('helvetica', 'normal')
  }

  zeichneKopfzeile()

  for (const item of items) {
    if (y > pageHeight - 25) {
      doc.addPage()
      y = 20
      zeichneKopfzeile()
    }
    const stornoText = item.storno ? (item.storniertDurch ? `S(${item.storniertDurch})` : 'S') : ''
    const cells = [
      item.erstelltAm.slice(0, 10),
      typText(item.typ),
      String(item.menge),
      item.artikelTitel ?? item.artikelId,
      item.standortName ?? item.standortId,
      item.projekt ?? '',
      item.erstelltVon ?? '',
      item.kommentar ?? '',
      stornoText,
    ]
    cells.forEach((cell, i) => doc.text(clip(cell, i), colX(i), y))
    y += 4
  }

  // Footer on every page
  const jetzt = new Date().toISOString()
  const anzahlSeiten = (
    doc.internal as unknown as { getNumberOfPages: () => number }
  ).getNumberOfPages()
  for (let pageNum = 1; pageNum <= anzahlSeiten; pageNum++) {
    doc.setPage(pageNum)
    doc.setFontSize(8)
    doc.text(
      msg('view.inventurArchiv.pdfFusszeile', {
        zeit: jetzt,
        version: `v${version}`,
        seite: pageNum,
        gesamt: anzahlSeiten,
      }),
      left,
      pageHeight - 10,
    )
  }

  return doc.output('blob')
}

/** Download the archive PDF as a file. */
export async function downloadArchivPdf(
  items: ArchivEntry[],
  mitPreise: boolean,
  dateiname?: string,
): Promise<void> {
  const blob = await exportArchivPdf(items, mitPreise)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = dateiname ?? `buchungsarchiv-${new Date().toISOString().slice(0, 10)}.pdf`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
