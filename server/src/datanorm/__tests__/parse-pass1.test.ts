import { describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import iconv from 'iconv-lite'
import { erkenneEncoding, dekodiere } from '../encoding.js'
import {
  DatanormFehler,
  erkenneVersion,
  erkenneVersionAusFeldern,
  parseP,
  parseArtikel,
  parseB,
  parseD,
  parseT,
  parseVorsatz,
  sammleDatanorm,
  zerlegeSatz,
} from '../parse-pass1.js'
import {
  normalisiereEan,
  parseDatum,
  parsePreisCent,
  parsePreiseinheit,
  parseZahl,
} from '../layout.js'
import {
  aV4,
  aV5,
  BEISPIEL_V4,
  BEISPIEL_V4_MIT_DELETE,
  BEISPIEL_V5,
  BEISPIEL_V5_UNBEKANNT,
  bV4,
  datei,
  dV4,
  pV4,
  tV4,
  v4Vorsatz,
  v5Vorsatz,
} from './fixtures.js'

describe('encoding', () => {
  it('erkennt UTF-8 ohne Ersetzungszeichen', () => {
    const buf = Buffer.from('A;N;ART-1;00;Schraube M8 Bördel — Größe 8\n', 'utf-8')
    const e = erkenneEncoding(buf)
    expect(e.encoding).toBe('utf-8')
    expect(e.ersetzungen).toBe(0)
    expect(e.unsicher).toBe(false)
  })

  it('fällt auf cp850 zurück, wenn Umlaute als Einzelbytes kommen', () => {
    // 0x81 = ü in CP850, 0x94 = ö. In UTF-8 sind das ungültige Sequenzen.
    const buf = Buffer.concat([
      Buffer.from('A;N;ART-1;00;Schraube M8 B', 'latin1'),
      Buffer.from([0x81, 0x94, 0x9f, 0x0a]),
    ])
    const e = erkenneEncoding(buf)
    expect(e.encoding).toBe('cp850')
    const text = dekodiere(buf, e.encoding)
    expect(text).toContain('ü')
    expect(text).toContain('ö')
  })

  it('strippt einen UTF-8-BOM beim Dekodieren', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('A X\n', 'utf-8')])
    expect(dekodiere(buf, 'utf-8').startsWith('A')).toBe(true)
  })
})

describe('layout helpers', () => {
  it('parsePreisCent liest den Preis als Cent (ohne Faktor 100)', () => {
    // DATANORM preise stehen in Cent: "4700" = 47,00 EUR.
    expect(parsePreisCent('4700')).toBe(4700)
    expect(parsePreisCent('2,49')).toBe(249)
    expect(parsePreisCent('2.495')).toBe(2495)
    expect(parsePreisCent('0')).toBe(0)
    expect(parsePreisCent('-1200')).toBe(-1200)
    expect(parsePreisCent('  ')).toBeNull()
    expect(parsePreisCent('kein Preis')).toBeNull()
  })

  it('parsePreiseinheit übersetzt den v4-Code in den Faktor', () => {
    // v4: 0 = je 1, 1 = je 10, 2 = je 100, 3 = je 1000 Einheiten.
    expect(parsePreiseinheit('0', 4)).toBe(1)
    expect(parsePreiseinheit('1', 4)).toBe(10)
    expect(parsePreiseinheit('2', 4)).toBe(100)
    expect(parsePreiseinheit('3', 4)).toBe(1000)
    // v5: das Feld ist der Faktor selbst.
    expect(parsePreiseinheit('10', 5)).toBe(10)
    expect(parsePreiseinheit('', 4)).toBeNull()
  })

  it('parseZahl liest Dezimalwerte', () => {
    expect(parseZahl('10')).toBe(10)
    expect(parseZahl('1.5')).toBe(1.5)
    expect(parseZahl('')).toBeNull()
  })

  it('parseDatum akzeptiert beide DATANORM-Schreibweisen', () => {
    expect(parseDatum('20240115')).toBe('2024-01-15')
    expect(parseDatum('15.01.2024')).toBe('2024-01-15')
    expect(parseDatum('20241340')).toBeNull() // Monat 13
    expect(parseDatum('unsinn')).toBeNull()
  })

  it('normalisiereEan akzeptiert gültige GTIN-Längen und lehnt Rest ab', () => {
    expect(normalisiereEan('4006381333931')).toBe('4006381333931')
    expect(normalisiereEan('400-638-133393-1')).toBe('4006381333931')
    expect(normalisiereEan('12345')).toBeNull()
    expect(normalisiereEan('ABCDEFGHIJKLM')).toBeNull()
    expect(normalisiereEan('')).toBeNull()
  })
})

describe('satz zerlegen + version', () => {
  it('erkennt bekannte Satzzeichen', () => {
    expect(zerlegeSatz('A;N;ART-1', 1).satzart).toBe('A')
    expect(zerlegeSatz('D;N;ART-1', 1).satzart).toBe('D')
    expect(zerlegeSatz('€nknown', 1).satzart).toBe('unbekannt')
    expect(zerlegeSatz('A;N;ART-1', 7).zeile).toBe(7)
  })

  it('erkennt die Version aus dem v4-Vorsatz (fest breit, "04EUR" am Ende)', () => {
    expect(erkenneVersion(v4Vorsatz())).toBe(4)
  })

  it('erkennt die Version aus dem v5-Vorsatz (Semikolon, Feld 2 = "050")', () => {
    expect(erkenneVersion(v5Vorsatz())).toBe(5)
  })

  it('erkennt die Version aus der Feldzahl des A-Satzes', () => {
    // v4: 13 Felder (+ abschliessendes ';' → 14). v5: 23 (+ 1 → 24).
    expect(erkenneVersionAusFeldern(13)).toBe(4)
    expect(erkenneVersionAusFeldern(14)).toBe(4)
    expect(erkenneVersionAusFeldern(23)).toBe(5)
    expect(erkenneVersionAusFeldern(24)).toBe(5)
  })

  it('liest Währung und Datum aus dem v4-Vorsatz', () => {
    const v = parseVorsatz(v4Vorsatz('Muster GmbH', '150124'), 4, 1)
    expect(v.waehrung).toBe('EUR')
    expect(v.stichtag).toBe('2024-01-15')
    expect(v.lieferantName).toBe('Muster GmbH')
  })

  it('liest Währung und Datum aus dem v5-Vorsatz', () => {
    const v = parseVorsatz(v5Vorsatz('Muster GmbH', '20240115'), 5, 1)
    expect(v.waehrung).toBe('EUR')
    expect(v.stichtag).toBe('2024-01-15')
  })
})

describe('einzelne Sätze parsen', () => {
  it('A-Satz v5 liest Preis, EAN und Langtextschlüssel', () => {
    const zeile = aV5({
      artikelnummer: 'ART-1',
      ean: '4006381333931',
      kurztext1: 'Schraube M8',
      mengeneinheit: 'PCE',
      preisKennzeichen: '2',
      preis: '249',
      hauptwarengruppe: 'WG7',
    })
    const a = parseArtikel(zeile, 5, 12)
    expect(a).not.toBeNull()
    expect(a!.matchcode).toBe('ART-1')
    expect(a!.ean).toBe('4006381333931')
    expect(a!.kurztext).toBe('Schraube M8')
    expect(a!.preisNettoCent).toBe(249)
    expect(a!.preisBruttoCent).toBeNull()
    expect(a!.warengruppe).toBe('WG7')
    expect(a!.preiseinheit).toBe(1)
  })

  it('A-Satz v4 liest Artikelnummer, Kurztext und Preis aus den richtigen Feldern', () => {
    const zeile = aV4({
      artikelnummer: 'V4-ART1',
      textkennzeichen: '01',
      kurztext1: 'Kupferrohr 15mm',
      preisKennzeichen: '2',
      preisEinheit: '1',
      mengeneinheit: 'M',
      preis: '1290',
      hauptwarengruppe: 'ROHR',
    })
    const a = parseArtikel(zeile, 4, 3)
    expect(a!.matchcode).toBe('V4-ART1')
    expect(a!.kurztext).toBe('Kupferrohr 15mm')
    expect(a!.mengeneinheit).toBe('M')
    // v4-Preiseinheit 1 = "Preis je 10 Einheiten".
    expect(a!.preiseinheit).toBe(10)
    expect(a!.preisNettoCent).toBe(1290)
    expect(a!.warengruppe).toBe('ROHR')
  })

  it('A-Satz v4 setzt Kurztext 1 und 2 zu einem Titel zusammen', () => {
    const zeile = aV4({
      artikelnummer: '63-1211456-',
      // Textkennzeichen 0 = "Kurztext 1 + Kurztext 2" — beide Felder
      // tragen EINEN Text, der vom Export in der Mitte getrennt wurde.
      textkennzeichen: '01',
      kurztext1: '19"-Rack-Montagesatz Front- und Rücks',
      kurztext2: 'eite, 1 HE',
    })
    const a = parseArtikel(zeile, 4, 1)
    expect(a!.kurztext).toBe('19"-Rack-Montagesatz Front- und Rückseite, 1 HE')
  })

  it('A-Satz ohne Artikelnummer wird verworfen', () => {
    expect(parseArtikel('A;N', 4, 9)).toBeNull()
  })

  it('B-Satz v4 trägt die EAN, Verpackungsmenge und Ersatzartikel', () => {
    const zeile = bV4({
      artikelnummer: 'V4-ART1',
      matchcode: 'MC-1',
      ean: '4001234567890',
      verpackungsmenge: '12',
      ersatz: 'V4-ART2',
    })
    const b = parseB(zeile, 4, 4)
    expect(b!.ean).toBe('4001234567890')
    expect(b!.matchcode2).toBe('MC-1')
    expect(b!.verpackungsmenge).toBe(12)
    expect(b!.ersatzMatchcode).toBe('V4-ART2')
    expect(b!.isDelete).toBe(false)
  })

  it('B-Satz mit "L" ist ein Loeschhinweis', () => {
    const zeile = bV4({ artikelnummer: 'ART-2001', verarbeitung: 'L' })
    expect(parseB(zeile, 5, 5)!.isDelete).toBe(true)
  })

  it('D-Satz liefert je Textblock einen Beschreibungseintrag', () => {
    const zeile = dV4('ART-1', [
      { nr: '1', text: 'Erste Zeile' },
      { nr: '2', text: 'Zweite Zeile' },
    ])
    const dr = parseD(zeile, 4, 8)
    expect(dr).toHaveLength(2)
    expect(dr[0]!.matchcode).toBe('ART-1')
    expect(dr[0]!.laufendeNr).toBe('1')
    expect(dr[0]!.text).toBe('Erste Zeile')
    expect(dr[1]!.text).toBe('Zweite Zeile')
  })

  it('T-Satz merkt sich die Textnummer und die Zeilen', () => {
    const zeile = tV4('T000001', [
      { nr: '1', text: 'Ein langer Text' },
      { nr: '2', text: 'Noch ein Text' },
    ])
    const tr = parseT(zeile, 4, 9)
    expect(tr).toHaveLength(2)
    expect(tr[0]!.textId).toBe('T000001')
    expect(tr[0]!.text).toBe('Ein langer Text')
    expect(tr[1]!.laufendeNr).toBe('2')
  })

  it('P-Satz liefert mehrere Produkt/Preis-Paare pro Zeile', () => {
    const zeile = pV4([
      { artikelnummer: 'A-1', preis: '250' },
      { artikelnummer: 'A-2', preis: '375' },
      { artikelnummer: 'A-3', preis: '100' },
    ])
    const p = parseP(zeile, 4, 11)
    expect(p.aenderungen).toHaveLength(3)
    expect(p.aenderungen.map((a) => a.matchcode)).toEqual(['A-1', 'A-2', 'A-3'])
    expect(p.aenderungen[1]!.preisCent).toBe(375)
    expect(p.aenderungen[1]!.preisKennzeichen).toBe(2)
  })

  it('P-Satz mit leeren Slots liefert nur die belegten Paare', () => {
    const zeile = pV4([{ artikelnummer: 'A-1', preis: '250' }])
    const p = parseP(zeile, 4, 12)
    expect(p.aenderungen).toHaveLength(1)
  })
})

describe('Pass 1 — sammleDatanorm', () => {
  it('liest einen v4-Katalog vollständig und findet die EAN im B-Satz', async () => {
    const s = await sammleDatanorm(datei(BEISPIEL_V4), { encoding: 'cp850' })
    expect(s.version).toBe(4)
    expect(s.artikel.size).toBe(2)

    const a = s.artikel.get('63-1211456-')!
    expect(a.kurztext).toBe('19"-Rack-Montagesatz Front- und Rückseite, 1 HE')
    expect(a.preisNettoCent).toBe(4700)
    expect(a.mengeneinheit).toBe('STK')
    // Der A-Satz in v4 hat kein EAN-Feld; der B-Satz trägt es.
    expect(a.ean).toBeNull()
    expect(s.bRecords.get('63-1211456-')!.ean).toBe('4012345678905')

    // Cross-Reference: D-Block liegt hinter dem A-Satz, wird aber gefunden.
    expect(s.descriptions.get('63-1211456-')).toHaveLength(2)
    // T-Block unter der Langtextnummer, die der A-Satz referenziert.
    expect(s.texte.get('T000001')).toHaveLength(2)

    expect(s.vorsatz).not.toBeNull()
    expect(s.vorsatz!.waehrung).toBe('EUR')
    expect(s.fehler).toHaveLength(0)
  })

  it('liest einen v5-Katalog vollständig', async () => {
    const s = await sammleDatanorm(datei(BEISPIEL_V5), { encoding: 'cp850' })
    expect(s.version).toBe(5)
    expect(s.artikel.size).toBe(2)

    const a1 = s.artikel.get('ART-1001')!
    expect(a1.kurztext).toBe('Bleistift HB')
    expect(a1.ean).toBe('4006381333931')
    expect(a1.preisNettoCent).toBe(249)

    const a2 = s.artikel.get('ART-1002')!
    expect(a2.kurztext).toBe('Radiergummi weich 65x23x35mm')

    expect(s.vorsatz!.waehrung).toBe('EUR')
    expect(s.vorsatz!.stichtag).toBe('2024-01-15')
    expect(s.fehler).toHaveLength(0)
  })

  it('erkennt die EAN-Übernahme aus dem v4-B-Satz als eigenes Signal', async () => {
    const s = await sammleDatanorm(datei(BEISPIEL_V4), { encoding: 'cp850' })
    const b = s.bRecords.get('63-1211456-')!
    expect(b.ean).toBe('4012345678905')
    expect(b.isDelete).toBe(false)
  })

  it('liest einen Loeschhinweis ("L") im A-Satz', async () => {
    const s = await sammleDatanorm(datei(BEISPIEL_V4_MIT_DELETE), { encoding: 'cp850' })
    expect(s.artikel.get('ART-2002')!.isDelete).toBe(true)
    expect(s.artikel.get('ART-2001')!.isDelete).toBe(false)
  })

  it('ist tolerant bei unbekannten Satzzeichen', async () => {
    const s = await sammleDatanorm(datei(BEISPIEL_V5_UNBEKANNT), { encoding: 'cp850' })
    expect(s.artikel.size).toBe(1)
    const unbekanntFehler = s.fehler.filter((f) => f.code === 'DATANORM_SATZ_UNBEKANNT')
    expect(unbekanntFehler).toHaveLength(2)
    expect(unbekanntFehler[0]!.kontext).toContain('irgendwas')
  })

  it('bricht bei leerer Datei ohne A-Sätze ab', async () => {
    const s = datei([v5Vorsatz(), 'Z'])
    await expect(sammleDatanorm(s, { encoding: 'cp850' })).rejects.toThrow(DatanormFehler)
  })

  it('bricht bei Strict-Mode beim ersten Fehler ab', async () => {
    await expect(
      sammleDatanorm(datei(BEISPIEL_V5_UNBEKANNT), { encoding: 'cp850', strict: true }),
    ).rejects.toThrow(/Satzzeichen/)
  })

  it('respect maxBytes', async () => {
    await expect(
      sammleDatanorm(datei(BEISPIEL_V5), { encoding: 'cp850', maxBytes: 10 }),
    ).rejects.toThrow(DatanormFehler)
  })

  it('zählt Duplikate als Fehler und behält den ersten Datensatz', async () => {
    const zeilen = [
      v5Vorsatz(),
      aV5({ artikelnummer: 'DUP', kurztext1: 'Erste Fassung', preis: '100' }),
      aV5({ artikelnummer: 'DUP', kurztext1: 'Zweite Fassung', preis: '200' }),
      'Z',
    ]
    const s = await sammleDatanorm(datei(zeilen), { encoding: 'cp850' })
    expect(s.artikel.size).toBe(1)
    expect(s.artikel.get('DUP')!.kurztext).toBe('Erste Fassung')
    expect(s.fehler.some((f) => f.code === 'DATANORM_A_DOPPELT')).toBe(true)
  })

  it('erzwingt das Format, wenn der Admin es festlegt', async () => {
    // Ohne Vorsatz und ohne erkennbare Version: der Admin erzwingt v4.
    const zeilen = [
      aV4({ artikelnummer: 'X-1', kurztext1: 'Test', preis: '100' }),
      'Z',
    ]
    const s = await sammleDatanorm(datei(zeilen), { encoding: 'cp850', format: 'v4' })
    expect(s.version).toBe(4)
    expect(s.artikel.get('X-1')!.kurztext).toBe('Test')
  })
})

describe('Realitätscheck: CP850-Bytes und Streaming', () => {
  it('liest echte CP850-Bytes mit Umlauten und erfindet keine Ersatzzeichen', async () => {
    // Der Text enthält echte Umlaute, die als CP850-Bytes kodiert werden.
    // Genau diese Bytes scheitern an einem UTF-8-Decode (0x81/0x94/0x9f
    // sind keine gültigen UTF-8-Startbytes) — genau so sehen echte
    // Lieferanten-Dateien aus.
    const zeilen = [
      v4Vorsatz(),
      aV4({ artikelnummer: 'UML-1', kurztext1: 'Kupferschraube M8 Größe', preis: '123' }),
      aV4({ artikelnummer: 'UML-2', kurztext1: 'Wandhaken Schraube Fuß', preis: '456' }),
      'Z',
    ]
    const text = zeilen.join('\r\n') + '\r\n'
    const mitBytes = iconv.encode(text, 'cp850')

    const erkannt = erkenneEncoding(mitBytes)
    expect(erkannt.encoding).toBe('cp850')

    const s = await sammleDatanorm(mitBytes)
    expect(s.encoding).toBe('cp850')
    expect(s.artikel.size).toBe(2)
    expect(s.artikel.get('UML-1')!.kurztext).toContain('ö')
    expect(s.artikel.get('UML-1')!.kurztext).not.toContain('�')
    expect(s.artikel.get('UML-2')!.kurztext).toContain('ß')
  })

  it('verarbeitet einen Chunk-Strom identisch zum Buffer', async () => {
    const buf = datei(BEISPIEL_V4)
    const ausBuffer = await sammleDatanorm(buf, { encoding: 'cp850' })

    // In kleine Chunks zerlegen, damit readline mehrere Zeilenumbrüche
    // und Umlaut-Grenzfälle über Chunk-Grenzen hinweg sieht.
    async function* chunkStrom(): AsyncGenerator<Buffer> {
      for (let i = 0; i < buf.length; i += 7) {
        yield buf.subarray(i, Math.min(i + 7, buf.length))
      }
    }
    const ausStrom = await sammleDatanorm(Readable.from(chunkStrom()), {
      encoding: 'cp850',
    })

    expect(ausStrom.artikel.size).toBe(ausBuffer.artikel.size)
    expect(ausStrom.artikel.get('63-1211456-')!.kurztext).toBe(
      ausBuffer.artikel.get('63-1211456-')!.kurztext,
    )
    expect(ausStrom.descriptions.get('63-1211456-')).toHaveLength(2)
  })
})
