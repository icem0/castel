// Inventur-Export: PDF + CSV für die Buchhaltung.
//
// Daten kommen aus dem Sync-Snapshot (`inventurStichtage` + `inventurPositionen`).
// Der Export erfordert die Berechtigung `inventur.export`; Preisspalten
// benötigen zusätzlich `einkaufspreis`.
// Lazy-Import von jsPDF, damit das ~500 KB Bundle nur beim tatsächlichen
// Export geladen wird.

import type { InventurPosition, InventurStichtag } from '../../db/types'
import { getDb } from '../../db/database'
import { i18n } from '../../i18n'

export interface ExportOptions {
  stichtage: InventurStichtag[]
  positionen: InventurPosition[]
  /** Ob Preisspalten (EK/Listenpreis/Wert) mit ausgegeben werden. */
  mitPreise: boolean
}

/**
 * Export labels follow the active UI language. The service runs outside a
 * component, so it goes through `i18n.global` (same pattern as
 * `src/auth/messages.ts`).
 */
function msg(key: string, named?: Record<string, unknown>): string {
  return named === undefined ? i18n.global.t(key) : i18n.global.t(key, named)
}

function statusText(status: InventurStichtag['status']): string {
  return msg(`view.inventur.status.${status}`)
}

const BEKANNTE_TYPEN = new Set([
  'einlagerung',
  'entnahme',
  'umlagerung',
  'inventur',
  'kommission',
  'storno',
])

/** Unknown slugs stay as-is instead of leaking an i18n key into the file. */
function typText(typ: string): string {
  return BEKANNTE_TYPEN.has(typ) ? msg(`view.buchung.form.typen.${typ}`) : typ
}

/** CSV with semicolon separators + UTF-8 BOM (Excel-compatible). */
export function csvDatei(opts: ExportOptions): string {
  const { stichtage, positionen, mitPreise } = opts
  const stichtagMap = new Map(stichtage.map((s) => [s.id, s]))

  const lines: string[] = []
  const header = [
    msg('view.inventur.exportSpalten.stichtag'),
    msg('view.inventur.exportSpalten.status'),
    msg('view.inventur.exportSpalten.artikelId'),
    msg('view.inventur.exportSpalten.artikel'),
    msg('view.inventur.exportSpalten.typ'),
    msg('view.inventur.exportSpalten.standortId'),
    msg('view.inventur.exportSpalten.ve'),
    msg('view.inventur.exportSpalten.menge'),
    ...(mitPreise
      ? [
          msg('view.inventur.exportSpalten.ekCent'),
          msg('view.inventur.exportSpalten.lpCent'),
          msg('view.inventur.exportSpalten.wertCent'),
        ]
      : []),
    msg('view.inventur.exportSpalten.geprueft'),
    msg('view.inventur.exportSpalten.negativ'),
  ]
  lines.push(header.join(';'))

  for (const p of positionen) {
    const st = stichtagMap.get(p.stichtageId)
    const row: string[] = [
      st?.stichtag ?? '',
      st ? statusText(st.status) : '',
      p.artikelId,
      `"${p.titel.replace(/"/g, '""')}"`,
      typText(p.typ),
      p.standortId,
      String(p.verpackungseinheit),
      String(p.menge),
    ]
    if (mitPreise) {
      row.push(String(p.einkaufspreisCent ?? ''), String(p.listenpreisCent ?? ''), String(p.wert))
    }
    row.push(String(p.inventurGeprueft), String(p.negativerBestand))
    lines.push(row.join(';'))
  }

  return '\uFEFF' + lines.join('\n')
}

/** CSV als Datei herunterladen (Client-seitig). */
export function downloadCsv(opts: ExportOptions, dateiname?: string): void {
  const csv = csvDatei(opts)
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = dateiname ?? `inventur-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/** PDF erzeugen (jsPDF, lazy import). A4, gruppiert nach Standort. */
export async function exportInventurPdf(opts: ExportOptions): Promise<Blob> {
  const { stichtage, positionen, mitPreise } = opts
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })

  const standortCache = new Map<string, string>()

  async function standortName(standortId: string): Promise<string> {
    if (standortCache.has(standortId)) return standortCache.get(standortId)!
    const row = await getDb().standorte.where('id').equals(standortId).first()
    const name = row?.name ?? standortId
    standortCache.set(standortId, name)
    return name
  }

  // Positionen nach Standort gruppieren
  const nachStandort = new Map<string, InventurPosition[]>()
  for (const p of positionen) {
    const liste = nachStandort.get(p.standortId) ?? []
    liste.push(p)
    nachStandort.set(p.standortId, liste)
  }

  let y = 20
  const seitenFuss = () => {
    doc.setFontSize(8)
    doc.text(
      msg('view.inventur.exportPdfTexte.fusszeile', { zeit: new Date().toISOString() }),
      15,
      doc.internal.pageSize.height - 10,
    )
  }

  doc.setFontSize(16)
  doc.text(msg('view.inventur.exportPdfTexte.titel'), 15, y)
  y += 8
  doc.setFontSize(10)
  doc.text(msg('view.inventur.exportPdfTexte.erstellt', { zeit: new Date().toISOString() }), 15, y)
  y += 6

  for (const stichtag of stichtage) {
    y += 5
    doc.setFontSize(12)
    doc.text(
      msg('view.inventur.exportPdfTexte.stichtag', {
        wert: stichtag.stichtag,
        status: statusText(stichtag.status),
      }),
      15,
      y,
    )
    y += 6

    for (const [standortId, posListe] of nachStandort) {
      const name = await standortName(standortId)
      doc.setFontSize(11)
      doc.text(msg('view.inventur.exportPdfTexte.standort', { name }), 15, y)
      y += 5

      // Tabellen-Header
      const KopfX = 15
      doc.setFontSize(8)
      doc.setFont('helvetica', 'bold')
      const headerCols: string[] = [
        msg('view.inventur.exportSpalten.artikel'),
        msg('view.inventur.exportSpalten.typ'),
        msg('view.inventur.exportSpalten.ve'),
        msg('view.inventur.exportSpalten.menge'),
      ]
      if (mitPreise) {
        headerCols.push(
          msg('view.inventur.exportSpalten.ekCent'),
          msg('view.inventur.exportSpalten.lpCent'),
          msg('view.inventur.exportSpalten.wert'),
        )
      }
      headerCols.push(msg('view.inventur.exportSpalten.geprueft'))
      let x = KopfX
      // Column widths follow the position, not the German label.
      headerCols.forEach((col, i) => {
        doc.text(col, x, y)
        x += i === 0 ? 55 : 20
      })
      y += 4

      doc.setFont('helvetica', 'normal')
      let summeMenge = 0
      let summeWert = 0
      for (const p of posListe) {
        // Stichtag-Filter: nur Positionen dieses Stichtags anzeigen
        if (p.stichtageId !== stichtag.id) continue
        const artikel = `"${p.titel.slice(0, 40)}" (${p.artikelId.slice(0, 8)}…)`
        doc.text(artikel, KopfX, y)
        doc.text(typText(p.typ), KopfX + 50, y)
        doc.text(String(p.verpackungseinheit), KopfX + 70, y)
        doc.text(String(p.menge), KopfX + 85, y)
        if (mitPreise) {
          doc.text(String(p.einkaufspreisCent ?? ''), KopfX + 105, y)
          doc.text(String(p.listenpreisCent ?? ''), KopfX + 125, y)
          doc.text(String(p.wert), KopfX + 145, y)
        }
        doc.text(String(p.inventurGeprueft), KopfX + (mitPreise ? 165 : 145), y)
        summeMenge += p.menge
        summeWert += p.wert
        y += 4
        if (y > 260) {
          doc.addPage()
          y = 20
          seitenFuss()
        }
      }

      // Zwischensumme Standort
      doc.setFont('helvetica', 'bold')
      doc.text(msg('view.inventur.exportPdfTexte.zwischensumme'), KopfX, y + 2)
      doc.text(String(summeMenge), KopfX + 85, y + 2)
      if (mitPreise) doc.text(String(summeWert), KopfX + 145, y + 2)
      doc.setFont('helvetica', 'normal')
      y += 8

      if (y > 250) {
        doc.addPage()
        y = 20
        seitenFuss()
      }
    }
  }

  // Gesamtsumme
  doc.setFontSize(11)
  doc.setFont('helvetica', 'bold')
  const gesamtMenge = positionen.reduce((s, p) => s + p.menge, 0)
  const gesamtWert = positionen.reduce((s, p) => s + p.wert, 0)
  doc.text(msg('view.inventur.exportPdfTexte.gesamtmenge', { menge: gesamtMenge }), 15, y + 5)
  if (mitPreise)
    doc.text(msg('view.inventur.exportPdfTexte.gesamtwert', { wert: gesamtWert }), 15, y + 10)

  seitenFuss()

  return doc.output('blob')
}

/** PDF als Datei herunterladen. */
export async function downloadPdf(opts: ExportOptions, dateiname?: string): Promise<void> {
  const blob = await exportInventurPdf(opts)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = dateiname ?? `inventur-${new Date().toISOString().slice(0, 10)}.pdf`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
