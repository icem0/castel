// Tests der Scan-Heuristik (Kommission aus eingefügtem Auftragstext).
//
// Das Haupt-Beispiel ist eine echte Zweispalten-PDF-Kopie: erst die
// Labels (durch Doppelpunkte teils aneinandergeklatscht), darunter der
// Werte-Block inkl. Leerzeilen als Platzhalter. Erwartet: 908454 wird als
// Arbeitsauftragsnummer erkannt, Kd.-Nummer/Datum/Telefon fallen weg.

import { describe, expect, it } from 'vitest'
import { erkenneKommission, matcheKommission, normalisiereKommission } from '../kommission-scan'

const AUFTRAG_PDF = `Arbeitsauftrag - Nr:Kd.-Nummer:
Beleg-Datum:
Ihre Anfrage vom:
Unser Zeichen:
Telefon Kunde:
Telefon Hausmeister:
Mobiltelefon Kunde:
Seite:

908454
00012775
05.03.2024

cf
+49 (8031) 616970

+49 (160) 93768904`

describe('normalisiereKommission', () => {
  it('ignoriert Groß-/Kleinschreibung, Leerzeichen und Trennzeichen', () => {
    expect(normalisiereKommission('KA-2024/1187')).toBe(normalisiereKommission('ka 2024 1187'))
    expect(normalisiereKommission('Müller & Söhne')).toBe('muellersoehne')
  })
})

describe('erkenneKommission — Zweispalten-PDF (Realbeispiel)', () => {
  it('erkennt die Arbeitsauftragsnummer 908454', () => {
    const ergebnis = erkenneKommission(AUFTRAG_PDF, [])
    expect(ergebnis.beste).not.toBeNull()
    expect(ergebnis.beste?.wert).toBe('908454')
    expect(ergebnis.beste?.art).toBe('arbeitsauftrag')
  })

  it('ignoriert Kd.-Nummer, Datum und Telefonnummern als Kandidaten', () => {
    const ergebnis = erkenneKommission(AUFTRAG_PDF, [])
    const werte = ergebnis.kandidaten.map((k) => k.wert)
    expect(werte).not.toContain('00012775')
    expect(werte).not.toContain('05.03.2024')
    expect(werte).not.toContain('616970')
    expect(werte).not.toContain('93768904')
  })

  it('matcht gegen eine bestehende Kommission (Nummer im Namen)', () => {
    const ergebnis = erkenneKommission(AUFTRAG_PDF, ['Hausmeister Müller', 'AA 908454'])
    expect(ergebnis.treffer).toBe('AA 908454')
  })
})

describe('erkenneKommission — Einzelzeilen-Format', () => {
  it('erkennt Auftrag inline', () => {
    const ergebnis = erkenneKommission('Auftrags-Nr.: 8745\nSonstiger Text', [])
    expect(ergebnis.beste?.wert).toBe('8745')
    expect(ergebnis.beste?.art).toBe('arbeitsauftrag')
  })

  it('erkennt Serviceauftrag vor Arbeitsauftrag (Priorität)', () => {
    const text = `Serviceauftrag: 55-0199
Arbeitsauftrag: 908454`
    const ergebnis = erkenneKommission(text, [])
    expect(ergebnis.beste?.wert).toBe('55-0199')
    expect(ergebnis.beste?.art).toBe('serviceauftrag')
  })

  it('erkennt Kommissionsnummer mit höchster Priorität', () => {
    const text = `Arbeitsauftrag: 908454
Kommission: KA-2024-1187`
    const ergebnis = erkenneKommission(text, [])
    expect(ergebnis.beste?.wert).toBe('KA-2024-1187')
    expect(ergebnis.beste?.art).toBe('kommission')
  })

  it('priorisiert Kommission > Service > Arbeit in der Kandidatenliste', () => {
    const text = `Arbeitsauftrag: 1111
Serviceauftrag: 2222
Kommission: 3333`
    const ergebnis = erkenneKommission(text, [])
    expect(ergebnis.kandidaten.map((k) => k.wert)).toEqual(['3333', '2222', '1111'])
  })
})

describe('erkenneKommission — Fallbacks und Ausschlüsse', () => {
  it('liefert unbekannte Zahlen als Fallback, wenn kein Label trifft', () => {
    const ergebnis = erkenneKommission('908454', [])
    expect(ergebnis.beste?.wert).toBe('908454')
    expect(ergebnis.beste?.art).toBe('unbekannt')
  })

  it('verwirft kurze Zahlen (Seiten/Positionsnummern) im Fallback', () => {
    const ergebnis = erkenneKommission('Seite:\n1\n2\n3', [])
    expect(ergebnis.kandidaten).toHaveLength(0)
    expect(ergebnis.beste).toBeNull()
  })

  it('findet nichts in reinem Fließtext', () => {
    const ergebnis = erkenneKommission('Bitte bis morgen liefern lassen.', [])
    expect(ergebnis.kandidaten).toHaveLength(0)
  })

  it('Berücksichtigt Umlaute in Labels', () => {
    const ergebnis = erkenneKommission('Störungsmeldung: 774411', [])
    expect(ergebnis.beste?.wert).toBe('774411')
    expect(ergebnis.beste?.art).toBe('serviceauftrag')
  })
})

describe('matcheKommission', () => {
  it('findet exakten Treffer (normalisiert)', () => {
    expect(matcheKommission('908454', ['Hausmeister', '908 454'])).toBe('908 454')
  })

  it('findet Teiltreffer, wenn die Nummer im Namen steckt', () => {
    expect(matcheKommission('908454', ['AA-908454 Müller'])).toBe('AA-908454 Müller')
  })

  it('kein Teiltreffer bei sehr kurzen Nummern (< 4 Ziffern)', () => {
    expect(matcheKommission('11', ['Hausverwaltung 11']) ?? null).toBeNull()
  })

  it('liefert null ohne Treffer', () => {
    expect(matcheKommission('908454', ['Projekt Müller'])).toBeNull()
  })
})
