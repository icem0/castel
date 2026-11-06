// Regression: clicking "PDF exportieren" in the booking archive generated a PDF
// that was never handed to the user (no download at all), and the nine columns
// were wider than an A4 portrait sheet, so the right-hand columns (Standort …
// Storno) were drawn beyond the page edge.

import { describe, expect, it } from 'vitest'
import {
  archivColWidths,
  archivMarginLeft,
  archivPageWidth,
  downloadArchivPdf,
  exportArchivPdf,
} from '../archiv-pdf'

type Entry = {
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

function makeEntries(anzahl: number): Entry[] {
  const entries: Entry[] = []
  for (let i = 0; i < anzahl; i++) {
    entries.push({
      id: `b-${i}`,
      typ: i % 2 === 0 ? 'eingang' : 'ausgang',
      menge: i,
      erstelltAm: `2026-11-0${(i % 9) + 1}T12:00:00.000Z`,
      kommentar: i % 3 === 0 ? null : 'Kommentar',
      artikelId: `artikel-${i}`,
      standortId: 's-1',
      artikelTitel: 'Akku 18V / 4,0 Ah Bosch',
      standortName: 'Hauptlager',
      erstelltVon: 'Chef',
      projekt: 'P-1234',
      storno: false,
      storniertDurch: null,
    })
  }
  return entries
}

describe('exportArchivPdf — Buchungsarchiv', () => {
  it('stays inside the printable A4 width', () => {
    const used = archivMarginLeft + archivColWidths.reduce((a, b) => a + b, 0)
    expect(used).toBeLessThanOrEqual(archivPageWidth - 10)
  })

  it('returns a PDF blob', async () => {
    const blob = await exportArchivPdf(makeEntries(3), false)
    expect(blob.size).toBeGreaterThan(0)
  })

  it('grows the file when more rows are exported', async () => {
    const few = await exportArchivPdf(makeEntries(3), false)
    const many = await exportArchivPdf(makeEntries(100), false)
    expect(many.size).toBeGreaterThan(few.size * 2)
  })

  it('hands the PDF to the user as a file', async () => {
    const downloads: string[] = []
    const originalAppend = document.body.appendChild.bind(document.body)
    document.body.appendChild = (node) => {
      downloads.push((node as unknown as HTMLElement).getAttribute('download') ?? '')
      return originalAppend(node)
    }
    try {
      await downloadArchivPdf(makeEntries(2), false)
    } finally {
      document.body.appendChild = originalAppend
    }
    expect(downloads).toHaveLength(1)
    expect(downloads[0]).toMatch(/^buchungsarchiv-\d{4}-\d{2}-\d{2}\.pdf$/)
  })
})
