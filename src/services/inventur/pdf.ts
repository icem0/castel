// Inventur-Export: PDF + CSV für die Buchhaltung.
//
// Daten kommen aus dem Sync-Snapshot (`inventurStichtage` + `inventurPositionen`).
// Der Export erfordert die Berechtigung `inventur.export`; Preisspalten
// benötigen zusätzlich `einkaufspreis`.
// Lazy-Import von jsPDF, damit das ~500 KB Bundle nur beim tatsächlichen
// Export geladen wird.

import type { InventurPosition, InventurStichtag } from '../../db/types'
import { getDb } from '../../db/database'

export interface ExportOptions {
  stichtage: InventurStichtag[]
  positionen: InventurPosition[]
  /** Ob Preisspalten (EK/Listenpreis/Wert) mit ausgegeben werden. */
  mitPreise: boolean
}

/** CSV mit Semikolon-Trennzeichen + UTF-8 BOM (Excel-kompatibel). */
export function csvDatei(opts: ExportOptions): string {
  const { stichtage, positionen, mitPreise } = opts
  const stichtagMap = new Map(stichtage.map((s) => [s.id, s]))

  const lines: string[] = []
  const header = [
    'Stichtag',
    'Status',
    'Artikel-ID',
    'Artikel',
    'Typ',
    'Standort-ID',
    'VE',
    'Menge',
    ...(mitPreise ? ['EK-Cent', 'LP-Cent', 'Wert-Cent'] : []),
    'Geprueft',
    'Negativ',
  ]
  lines.push(header.join(';'))

  for (const p of positionen) {
    const st = stichtagMap.get(p.stichtageId)
    const row: string[] = [
      st?.stichtag ?? '',
      st?.status ?? '',
      p.artikelId,
      `"${p.titel.replace(/"/g, '""')}"`,
      p.typ,
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
      `Castel Inventur-Export — ${new Date().toISOString()}`,
      15,
      doc.internal.pageSize.height - 10,
    )
  }

  doc.setFontSize(16)
  doc.text('Inventur-Snapshot', 15, y)
  y += 8
  doc.setFontSize(10)
  doc.text(`Erstellt: ${new Date().toISOString()}`, 15, y)
  y += 6

  for (const stichtag of stichtage) {
    y += 5
    doc.setFontSize(12)
    doc.text(`Stichtag: ${stichtag.stichtag} (${stichtag.status})`, 15, y)
    y += 6

    for (const [standortId, posListe] of nachStandort) {
      const name = await standortName(standortId)
      doc.setFontSize(11)
      doc.text(`Standort: ${name}`, 15, y)
      y += 5

      // Tabellen-Header
      const KopfX = 15
      doc.setFontSize(8)
      doc.setFont('helvetica', 'bold')
      const headerCols: string[] = ['Artikel', 'Typ', 'VE', 'Menge']
      if (mitPreise) headerCols.push('EK-Cent', 'LP-Cent', 'Wert')
      headerCols.push('Geprueft')
      let x = KopfX
      for (const col of headerCols) {
        doc.text(col, x, y)
        x += col === 'Artikel' ? 55 : 20
      }
      y += 4

      doc.setFont('helvetica', 'normal')
      let summeMenge = 0
      let summeWert = 0
      for (const p of posListe) {
        // Stichtag-Filter: nur Positionen dieses Stichtags anzeigen
        if (p.stichtageId !== stichtag.id) continue
        const artikel = `"${p.titel.slice(0, 40)}" (${p.artikelId.slice(0, 8)}…)`
        doc.text(artikel, KopfX, y)
        doc.text(p.typ, KopfX + 50, y)
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
      doc.text('Zwischensumme:', KopfX, y + 2)
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
  doc.text(`Gesamtmenge: ${gesamtMenge}`, 15, y + 5)
  if (mitPreise) doc.text(`Gesamtwert (Cent): ${gesamtWert}`, 15, y + 10)

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
