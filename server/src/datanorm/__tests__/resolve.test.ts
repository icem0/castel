import { describe, expect, it } from 'vitest'
import { loeseAuf } from '../resolve.js'
import { sammleDatanorm } from '../parse-pass1.js'
import { BEISPIEL_V5, BEISPIEL_V4, BEISPIEL_V5_MIT_DELETE, datei, d, t, aV5 } from './fixtures.js'

async function sammleUndLoese(zeilen: string[], opts?: { version?: 4 | 5 }) {
  const sammel = await sammleDatanorm(datei(zeilen), {
    encoding: 'cp850',
    ...opts,
  })
  return { sammel, aufgeloest: loeseAuf(sammel) }
}

describe('Pass 2 — Cross-References auflösen', () => {
  it('verbindet A + D + T zu einer Beschreibung', async () => {
    const { aufgeloest } = await sammleUndLoese(BEISPIEL_V5, { version: 5 })
    const a1 = aufgeloest.artikel.find((a) => a.matchcode === 'ART-1001')!
    // Zwei D-Zeilen, nach laufendeNr sortiert.
    expect(a1.beschreibung).toBe(
      'Bleistift, Härtegrad HB, hexagonal\nLieferung in Kartons à 12 Stück',
    )

    const a2 = aufgeloest.artikel.find((a) => a.matchcode === 'ART-1002')!
    // v5-Style: T mit direktem Matchcode wird als Beschreibung benutzt.
    expect(a2.beschreibung).toBe('Radiergummi, weich, 65x23x35mm')
  })

  it('übernimmt die EAN aus dem v4-B-Satz, da der v4-A-Satz keiner hat', async () => {
    const { aufgeloest } = await sammleUndLoese(BEISPIEL_V4)
    const a = aufgeloest.artikel[0]!
    expect(a.matchcode).toBe('V4-ART1')
    expect(a.ean).toBe('4001234567890')
    expect(a.beschreibung).toBe('Kupferrohr, DIN EN 1057')
  })

  it('setzt deaktiviert bei v5-Delete-Marker, behält aber die Daten', async () => {
    const { aufgeloest } = await sammleUndLoese(BEISPIEL_V5_MIT_DELETE, { version: 5 })
    const a = aufgeloest.artikel[0]!
    expect(a.deaktiviert).toBe(true)
    expect(a.titel).toBe('Altes Produkt')
    expect(a.preisNettoCent).toBe(500)
  })

  it('füllt fehlende Preise aus P-Sätzen, überschreibt aber keine A-Preise', async () => {
    // ART-A hat einen A-Preis; ART-B hat keinen.
    const zeilen = [
      'V;5.0;20240115;EUR;X;X GmbH',
      aV5({ matchcode: 'ART-A', kurztext: 'Mit Preis', preisNetto: '10.00' }),
      aV5({ matchcode: 'ART-B', kurztext: 'Ohne Preis' }),
      // P-Satz: ART-A auf 99.00 (darf NICHT greifen), ART-B auf 7.77 (greift).
      'P' +
        'ART-A'.padEnd(14, ' ') + '99.00'.padEnd(9, ' ') + ' '.repeat(2) +
        'ART-B'.padEnd(14, ' ') + '7.77'.padEnd(9, ' ') + ' '.repeat(2) +
        ''.padEnd(25, ' '),
      'Z',
    ]
    const { aufgeloest } = await sammleUndLoese(zeilen, { version: 5 })
    const a = aufgeloest.artikel.find((x) => x.matchcode === 'ART-A')!
    const b = aufgeloest.artikel.find((x) => x.matchcode === 'ART-B')!
    expect(a.preisNettoCent).toBe(1000) // A-Satz gewinnt
    expect(b.preisNettoCent).toBe(777) // P-Satz füllt die Lücke
  })

  it('meldet P-Sätze ohne passenden A-Satz, ohne abzubrechen', async () => {
    const zeilen = [
      'V;5.0;20240115;EUR;X;X GmbH',
      aV5({ matchcode: 'ART-1', kurztext: 'Da', preisNetto: '1.00' }),
      // P für einen unbekannten Matchcode.
      'P' + 'GHOST-9'.padEnd(14, ' ') + '5.00'.padEnd(9, ' ') + '  ' + ''.padEnd(25, ' ') + ''.padEnd(25, ' '),
      'Z',
    ]
    const { aufgeloest } = await sammleUndLoese(zeilen, { version: 5 })
    expect(aufgeloest.artikel).toHaveLength(1)
    expect(aufgeloest.fehler.some((f) => f.code === 'DATANORM_PREIS_OHNE_ARTIKEL')).toBe(true)
  })

  it('sortiert D-Zeilen numerisch nach laufendeNr (10 nach 9, nicht nach 1)', async () => {
    const zeilen = [
      'V;5.0;20240115;EUR;X;X GmbH',
      aV5({ matchcode: 'ORD', kurztext: 'Sortiert', preisNetto: '1.00' }),
      d('ORD', '010', 'Zehn'),
      d('ORD', '002', 'Zwei'),
      d('ORD', '009', 'Neun'),
      'Z',
    ]
    const { aufgeloest } = await sammleUndLoese(zeilen, { version: 5 })
    expect(aufgeloest.artikel[0]!.beschreibung).toBe('Zwei\nNeun\nZehn')
  })

  it('fällt auf den Matchcode zurück, wenn der A-Satz keinen Kurztext hat', async () => {
    const zeilen = [
      'V;5.0;20240115;EUR;X;X GmbH',
      aV5({ matchcode: 'NOTEXT', kurztext: '', preisNetto: '1.00' }),
      'Z',
    ]
    const { aufgeloest } = await sammleUndLoese(zeilen, { version: 5 })
    expect(aufgeloest.artikel[0]!.titel).toBe('NOTEXT')
  })

  it('ist deterministisch: gleiche Eingabe erzeugt gleiches Ergebnis', async () => {
    const { aufgeloest: a } = await sammleUndLoese(BEISPIEL_V5, { version: 5 })
    const { aufgeloest: b } = await sammleUndLoese(BEISPIEL_V5, { version: 5 })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('kombiniert D- und T-Block für dasselbe Artikel', async () => {
    const zeilen = [
      'V;5.0;20240115;EUR;X;X GmbH',
      aV5({ matchcode: 'BEIDES', kurztext: 'Mix', preisNetto: '1.00' }),
      d('BEIDES', '001', 'Teil eins aus D'),
      t('TID-1', '001', 'BEIDES', 'Teil zwei aus T'),
      'Z',
    ]
    const { aufgeloest } = await sammleUndLoese(zeilen, { version: 5 })
    expect(aufgeloest.artikel[0]!.beschreibung).toBe('Teil eins aus D\nTeil zwei aus T')
  })
})