import { describe, expect, it } from 'vitest'
import { loeseAuf } from '../resolve.js'
import { sammleDatanorm } from '../parse-pass1.js'
import {
  aV4,
  aV5,
  BEISPIEL_V4,
  BEISPIEL_V4_MIT_DELETE,
  BEISPIEL_V5,
  datei,
  dV4,
  pV4,
  tV4,
  v4Vorsatz,
  v5Vorsatz,
} from './fixtures.js'

async function sammleUndLoese(zeilen: string[], opts?: { version?: 4 | 5; format?: 'auto' | 'v4' | 'v5' }) {
  const sammel = await sammleDatanorm(datei(zeilen), {
    encoding: 'cp850',
    ...opts,
  })
  return { sammel, aufgeloest: loeseAuf(sammel) }
}

describe('Pass 2 — Cross-References auflösen', () => {
  it('verbindet A + D + T (v4) zu einer Beschreibung', async () => {
    const { aufgeloest } = await sammleUndLoese(BEISPIEL_V4)
    const a = aufgeloest.artikel.find((x) => x.matchcode === '63-1211456-')!
    // D-Block (Dimensionstext) und T-Block (Langtext über den
    // Langtextschlüssel des A-Satzes) landen beide in der Beschreibung.
    expect(a.beschreibung).toBe(
      'Rack-Montagesatz für 19-Zoll-Technik, Front- und Rückseite.\n' +
        'Lieferung lose.\n' +
        'Montagesatz mit 2 HE, Front- und Rückseite.\n' +
        'Inkl. Befestigungsmaterial.',
    )
  })

  it('übernimmt die EAN aus dem v4-B-Satz, da der v4-A-Satz keiner hat', async () => {
    const { aufgeloest } = await sammleUndLoese(BEISPIEL_V4)
    const a = aufgeloest.artikel.find((x) => x.matchcode === '63-1211456-')!
    expect(a.ean).toBe('4012345678905')
    // Die Verpackungsmenge aus dem B-Satz wird zum Inhalt je Einheit.
    expect(a.inhalt).toBe(1)
  })

  it('übernimmt Preis, EAN und Titel aus dem v5-A-Satz', async () => {
    const { aufgeloest } = await sammleUndLoese(BEISPIEL_V5)
    const a = aufgeloest.artikel.find((x) => x.matchcode === 'ART-1002')!
    expect(a.titel).toBe('Radiergummi weich 65x23x35mm')
    expect(a.ean).toBe('4012345678905')
    expect(a.preisNettoCent).toBe(79)
  })

  it('setzt deaktiviert bei einem Loeschhinweis ("L"), behält aber die Daten', async () => {
    const { aufgeloest } = await sammleUndLoese(BEISPIEL_V4_MIT_DELETE)
    const a = aufgeloest.artikel.find((x) => x.matchcode === 'ART-2002')!
    expect(a.deaktiviert).toBe(true)
    expect(a.titel).toBe('Zurückgezogenes Produkt')
  })

  it('füllt fehlende Preise aus P-Sätzen, überschreibt aber keine A-Preise', async () => {
    // ART-A hat einen A-Preis; ART-B hat keinen.
    const zeilen = [
      v5Vorsatz(),
      aV5({ artikelnummer: 'ART-A', kurztext1: 'Mit Preis', preis: '1000' }),
      aV5({ artikelnummer: 'ART-B', kurztext1: 'Ohne Preis' }),
      // P-Satz: ART-A auf 9900 (darf NICHT greifen), ART-B auf 777 (greift).
      pV4([
        { artikelnummer: 'ART-A', preis: '9900' },
        { artikelnummer: 'ART-B', preis: '777' },
      ]),
      'Z',
    ]
    const { aufgeloest } = await sammleUndLoese(zeilen)
    const a = aufgeloest.artikel.find((x) => x.matchcode === 'ART-A')!
    const b = aufgeloest.artikel.find((x) => x.matchcode === 'ART-B')!
    expect(a.preisNettoCent).toBe(1000) // A-Satz gewinnt
    expect(b.preisNettoCent).toBe(777) // P-Satz füllt die Lücke
  })

  it('meldet P-Sätze ohne passenden A-Satz, ohne abzubrechen', async () => {
    const zeilen = [
      v5Vorsatz(),
      aV5({ artikelnummer: 'ART-1', kurztext1: 'Da', preis: '100' }),
      pV4([{ artikelnummer: 'GHOST-9', preis: '500' }]),
      'Z',
    ]
    const { aufgeloest } = await sammleUndLoese(zeilen)
    expect(aufgeloest.artikel).toHaveLength(1)
    expect(aufgeloest.fehler.some((f) => f.code === 'DATANORM_PREIS_OHNE_ARTIKEL')).toBe(true)
  })

  it('sortiert D-Zeilen numerisch nach laufendeNr (10 nach 9, nicht nach 1)', async () => {
    const zeilen = [
      v4Vorsatz(),
      aV4({ artikelnummer: 'ORD', kurztext1: 'Sortiert', preis: '100' }),
      dV4('ORD', [{ nr: '010', text: 'Zehn' }]),
      dV4('ORD', [{ nr: '002', text: 'Zwei' }]),
      dV4('ORD', [{ nr: '009', text: 'Neun' }]),
      'Z',
    ]
    const { aufgeloest } = await sammleUndLoese(zeilen)
    expect(aufgeloest.artikel[0]!.beschreibung).toBe('Zwei\nNeun\nZehn')
  })

  it('fällt auf die Artikelnummer zurück, wenn der A-Satz keinen Kurztext hat', async () => {
    const zeilen = [
      v5Vorsatz(),
      aV5({ artikelnummer: 'NOTEXT', preis: '100' }),
      'Z',
    ]
    const { aufgeloest } = await sammleUndLoese(zeilen)
    expect(aufgeloest.artikel[0]!.titel).toBe('NOTEXT')
  })

  it('ist deterministisch: gleiche Eingabe erzeugt gleiches Ergebnis', async () => {
    const { aufgeloest: a } = await sammleUndLoese(BEISPIEL_V4)
    const { aufgeloest: b } = await sammleUndLoese(BEISPIEL_V4)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('hängt den Langtext über den Langtextschlüssel an (v4)', async () => {
    const zeilen = [
      v4Vorsatz(),
      aV4({
        artikelnummer: 'LT-1',
        kurztext1: 'Mit Langtext',
        langtextschluessel: 'T000042',
      }),
      tV4('T000042', [
        { nr: '1', text: 'Erste Langtextzeile' },
        { nr: '2', text: 'Zweite Langtextzeile' },
      ]),
      'Z',
    ]
    const { aufgeloest } = await sammleUndLoese(zeilen)
    expect(aufgeloest.artikel[0]!.beschreibung).toBe('Erste Langtextzeile\nZweite Langtextzeile')
  })
})
