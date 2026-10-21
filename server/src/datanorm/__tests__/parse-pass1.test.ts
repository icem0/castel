import { describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import iconv from 'iconv-lite'
import { erkenneEncoding, dekodiere } from '../encoding.js'
import {
  DatanormFehler,
  erkenneVersion,
  parseP,
  parseArtikel,
  parseB,
  parseD,
  parseT,
  sammleDatanorm,
  zerlegeSatz,
} from '../parse-pass1.js'
import { normalisiereEan, parseDatum, parsePreisCent, parseZahl } from '../layout.js'
import {
  aV5,
  BEISPIEL_V5,
  BEISPIEL_V4,
  BEISPIEL_V5_MIT_DELETE,
  BEISPIEL_V5_UNBEKANNT,
  datei,
  d,
  pEintraege,
  t,
} from './fixtures.js'

describe('encoding', () => {
  it('erkennt UTF-8 ohne Ersetzungszeichen', () => {
    const buf = Buffer.from('A ART-1 Schraube M8 Bördel — Größe 8\n', 'utf-8')
    const e = erkenneEncoding(buf)
    expect(e.encoding).toBe('utf-8')
    expect(e.ersetzungen).toBe(0)
    expect(e.unsicher).toBe(false)
  })

  it('fällt auf cp850 zurück, wenn Umlaute als Einzelbytes kommen', () => {
    // 0x81 = ü in CP850, 0x94 = ö. In UTF-8 sind das ungültige Sequenzen.
    const buf = Buffer.concat([
      Buffer.from('A ART-1 Schraube M8 B', 'latin1'),
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
  it('parsePreisCent rundet statt zu schneiden', () => {
    expect(parsePreisCent('2.495')).toBe(250)
    expect(parsePreisCent('2,49')).toBe(249)
    expect(parsePreisCent('0')).toBe(0)
    expect(parsePreisCent('  ')).toBeNull()
    expect(parsePreisCent('kein Preis')).toBeNull()
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
    expect(zerlegeSatz('ATEST', 1).satzart).toBe('A')
    expect(zerlegeSatz('DTEST', 1).satzart).toBe('D')
    expect(zerlegeSatz('€nknown', 1).satzart).toBe('unbekannt')
    expect(zerlegeSatz('ATEST', 7).zeile).toBe(7)
  })

  it('erkennt die Version aus dem Vorsatz', () => {
    expect(erkenneVersion('V;5.0;20240115;EUR')).toBe(5)
    expect(erkenneVersion('V4.0 20240115 EUR')).toBe(4)
    expect(erkenneVersion('ATEST')).toBeNull()
  })
})

describe('einzelne Sätze parsen', () => {
  it('A-Satz v5 mit Preisen und Stichtag', () => {
    const zeile = aV5({
      matchcode: 'ART-1',
      ean: '4006381333931',
      kurztext: 'Schraube M8',
      mengeneinheit: 'STK',
      warengruppe: 'WG-7',
      preisNetto: '2.49',
      preisBrutto: '2.99',
      gueltigAb: '20240115',
    })
    const a = parseArtikel(zeile.slice(1), 5, 12)
    expect(a).not.toBeNull()
    expect(a!.matchcode).toBe('ART-1')
    expect(a!.ean).toBe('4006381333931')
    expect(a!.kurztext).toBe('Schraube M8')
    expect(a!.preisNettoCent).toBe(249)
    expect(a!.preisBruttoCent).toBe(299)
    expect(a!.gueltigAb).toBe('2024-01-15')
    expect(a!.warengruppe).toBe('WG-7')
  })

  it('A-Satz v4 interpretiert die Mengeneinheit als Faktor', () => {
    // Layout v4: matchcode(14) kurztext(40) mengeneinheit(5) preiseinheit(2)
    //             preisNetto(10) preisBrutto(10) warengruppe(8)
    const zeile =
      'A' +
      'V4-ART1'.padEnd(14, ' ') +
      'Kupferrohr 15mm'.padEnd(40, ' ') +
      'M'.padEnd(5, ' ') +
      '10'.padEnd(2, ' ') +
      '12,90'.padEnd(10, ' ') +
      '15,48'.padEnd(10, ' ') +
      'ROHR'.padEnd(8, ' ')
    const a = parseArtikel(zeile.slice(1), 4, 3)
    expect(a!.matchcode).toBe('V4-ART1')
    expect(a!.mengeneinheit).toBe('M')
    expect(a!.preiseinheit).toBe(10)
    expect(a!.inhalt).toBe(10)
    expect(a!.preisNettoCent).toBe(1290)
  })

  it('A-Satz ohne Matchcode wird verworfen', () => {
    expect(parseArtikel(' '.repeat(60), 5, 9)).toBeNull()
  })

  it('B-Satz v4 trägt die EAN, v5 ist Delete-Marker', () => {
    const zeile4 = 'B' + 'V4-ART1'.padEnd(14, ' ') + '4001234567890'
    const b4 = parseB(zeile4.slice(1), 4, 4)
    expect(b4!.ean).toBe('4001234567890')
    expect(b4!.isDelete).toBe(false)

    const zeile5 = 'B' + 'ART-2001'.padEnd(20, ' ') + 'D         '
    const b5 = parseB(zeile5.slice(1), 5, 5)
    expect(b5!.matchcode).toBe('ART-2001')
    expect(b5!.isDelete).toBe(true)
  })

  it('D-Satz führt zwei Textspalten zusammen', () => {
    const zeile = 'D' + 'ART-1'.padEnd(14, ' ') + '001' + 'Erste Hälfte'.padEnd(40, ' ') + 'zweite Hälfte'.padEnd(40, ' ')
    const dr = parseD(zeile.slice(1), 8)
    expect(dr!.matchcode).toBe('ART-1')
    expect(dr!.laufendeNr).toBe('001')
    expect(dr!.text).toBe('Erste Hälfte zweite Hälfte')
  })

  it('T-Satz merkt sich Text-ID und optionalen Matchcode', () => {
    const zeile = t('TEXT-77', '001', 'ART-2', 'Ein langer Text')
    const tr = parseT(zeile.slice(1), 9)
    expect(tr!.textId).toBe('TEXT-77')
    expect(tr!.matchcode).toBe('ART-2')
  })

  it('P-Satz liefert mehrere Produkt/Preis-Paare pro Zeile', () => {
    const zeile = pEintraege([
      { matchcode: 'A-1', preis: '2.50' },
      { matchcode: 'A-2', preis: '3.75' },
      { matchcode: 'A-3', preis: '1.00' },
    ])
    const p = parseP(zeile.slice(1), 5, 11)
    expect(p.aenderungen).toHaveLength(3)
    expect(p.aenderungen.map((a) => a.matchcode)).toEqual(['A-1', 'A-2', 'A-3'])
    expect(p.aenderungen[1]!.preisCent).toBe(375)
  })

  it('P-Satz mit leeren Slots liefert nur die belegten Paare', () => {
    const zeile = pEintraege([{ matchcode: 'A-1', preis: '2.50' }])
    const p = parseP(zeile.slice(1), 5, 12)
    expect(p.aenderungen).toHaveLength(1)
  })
})

describe('Pass 1 — sammleDatanorm', () => {
  it('liest einen v5-Katalog vollständig', async () => {
    const s = await sammleDatanorm(datei(BEISPIEL_V5), { encoding: 'cp850', version: 5 })
    expect(s.version).toBe(5)
    expect(s.artikel.size).toBe(2)

    const a1 = s.artikel.get('ART-1001')!
    expect(a1.kurztext).toBe('Bleistift HB')
    expect(a1.preisNettoCent).toBe(249)

    // Cross-Reference: D-Block liegt hinter dem A-Satz, wird aber gefunden.
    const dblock = s.descriptions.get('ART-1001')
    expect(dblock).toBeDefined()
    expect(dblock).toHaveLength(2)

    // T-Block mit eigener ID und direktem Matchcode.
    expect(s.texte.get('TEXT-77')).toHaveLength(1)
    expect(s.texteNachMatchcode.get('ART-1002')).toHaveLength(1)

    // P-Sätze sind pro Matchcode indiziert.
    expect(s.preise.get('ART-1001')).toHaveLength(1)
    expect(s.preise.get('ART-1001')![0]!.aenderungen[0]!.preisCent).toBe(259)
    expect(s.preise.get('ART-1002')![0]!.aenderungen[0]!.preisCent).toBe(85)

    expect(s.vorsatz).not.toBeNull()
    expect(s.vorsatz!.waehrung).toBe('EUR')
    expect(s.vorsatz!.stichtag).toBe('2024-01-15')
    expect(s.fehler).toHaveLength(0)
  })

  it('liest einen v4-Katalog und nimmt die EAN aus dem B-Satz', async () => {
    const s = await sammleDatanorm(datei(BEISPIEL_V4), { encoding: 'cp850' })
    expect(s.version).toBe(4)
    expect(s.artikel.size).toBe(1)
    const a = s.artikel.get('V4-ART1')!
    expect(a.kurztext).toBe('Kupferrohr 15mm')
    expect(a.preiseinheit).toBe(1)
    // Der A-Satz in v4 hat kein EAN-Feld; der B-Satz trägt es.
    expect(a.ean).toBeNull()
    expect(s.bRecords.get('V4-ART1')!.ean).toBe('4001234567890')
  })

  it('erkennt die EAN-Übernahme aus dem v4-B-Satz als eigenes Signal', async () => {
    const s = await sammleDatanorm(datei(BEISPIEL_V4), { encoding: 'cp850' })
    const b = s.bRecords.get('V4-ART1')!
    expect(b.ean).toBe('4001234567890')
    expect(b.isDelete).toBe(false)
  })

  it('liest einen v5-Delete-Marker', async () => {
    const s = await sammleDatanorm(datei(BEISPIEL_V5_MIT_DELETE), { encoding: 'cp850', version: 5 })
    const b = s.bRecords.get('ART-2001')!
    expect(b.isDelete).toBe(true)
    // Der Artikel selbst bleibt im Bestand, wird nur als deaktiviert markiert.
    expect(s.artikel.has('ART-2001')).toBe(true)
  })

  it('ist tolerant bei unbekannten Satzzeichen', async () => {
    const s = await sammleDatanorm(datei(BEISPIEL_V5_UNBEKANNT), { encoding: 'cp850', version: 5 })
    expect(s.artikel.size).toBe(1)
    const unbekanntFehler = s.fehler.filter((f) => f.code === 'DATANORM_SATZ_UNBEKANNT')
    expect(unbekanntFehler).toHaveLength(2)
    expect(unbekanntFehler[0]!.kontext).toContain('irgendwas')
  })

  it('bricht bei leerer Datei ohne A-Sätze ab', async () => {
    const s = datei(['V;5.0;20240115;EUR;X;X GmbH', 'Z'])
    await expect(sammleDatanorm(s, { encoding: 'cp850', version: 5 })).rejects.toThrow(DatanormFehler)
  })

  it('bricht bei Strict-Mode beim ersten Fehler ab', async () => {
    await expect(
      sammleDatanorm(datei(BEISPIEL_V5_UNBEKANNT), { encoding: 'cp850', version: 5, strict: true }),
    ).rejects.toThrow(/Satzzeichen/)
  })

  it('respect maxBytes', async () => {
    await expect(
      sammleDatanorm(datei(BEISPIEL_V5), { encoding: 'cp850', version: 5, maxBytes: 10 }),
    ).rejects.toThrow(DatanormFehler)
  })

  it('zählt Duplikate als Fehler und behält den ersten Datensatz', async () => {
    const zeilen = [
      'V;5.0;20240115;EUR;X;X GmbH',
      aV5({ matchcode: 'DUP', kurztext: 'Erste Fassung', preisNetto: '1.00' }),
      aV5({ matchcode: 'DUP', kurztext: 'Zweite Fassung', preisNetto: '2.00' }),
      'Z',
    ]
    const s = await sammleDatanorm(datei(zeilen), { encoding: 'cp850', version: 5 })
    expect(s.artikel.size).toBe(1)
    expect(s.artikel.get('DUP')!.kurztext).toBe('Erste Fassung')
    expect(s.fehler.some((f) => f.code === 'DATANORM_A_DOPPELT')).toBe(true)
  })
})

describe('Realitätscheck: CP850-Bytes und Streaming', () => {
  it('liest echte CP850-Bytes mit Umlauten und erfindet keine Ersatzzeichen', async () => {
    // Der Text enthält echte Umlaute, die als CP850-Bytes kodiert werden.
    // Genau diese Bytes scheitern an einem UTF-8-Decode (0x81/0x94/0x9f
    // sind keine gültigen UTF-8-Startbytes) — genau so sehen echte
    // Lieferanten-Dateien aus.
    const zeilen = [
      'V;5.0;20240115;EUR;MUELLER;Mueller GmbH',
      aV5({ matchcode: 'UML-1', kurztext: 'Kupferschraube M8 Größe', preisNetto: '1.23' }),
      aV5({ matchcode: 'UML-2', kurztext: 'Wandhaken Schraube Fuß', preisNetto: '4.56' }),
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
    const buf = datei(BEISPIEL_V5)
    const ausBuffer = await sammleDatanorm(buf, { encoding: 'cp850', version: 5 })

    // In kleine Chunks zerlegen, damit readline mehrere Zeilenumbrüche
    // und Umlaut-Grenzfälle über Chunk-Grenzen hinweg sieht.
    async function* chunkStrom(): AsyncGenerator<Buffer> {
      for (let i = 0; i < buf.length; i += 7) {
        yield buf.subarray(i, Math.min(i + 7, buf.length))
      }
    }
    const ausStrom = await sammleDatanorm(Readable.from(chunkStrom()), {
      encoding: 'cp850',
      version: 5,
    })

    expect(ausStrom.artikel.size).toBe(ausBuffer.artikel.size)
    expect(ausStrom.artikel.get('ART-1001')!.kurztext).toBe(
      ausBuffer.artikel.get('ART-1001')!.kurztext,
    )
    expect(ausStrom.descriptions.get('ART-1001')).toHaveLength(2)
    expect(ausStrom.preise.size).toBe(ausBuffer.preise.size)
  })
})