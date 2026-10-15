// Unit-Tests für die view-layer Buchungsform-Validierung.
// Reine Funktion → keine Vue-Mount-Kosten, deckt die UX-Regeln ab.

import { describe, expect, it } from 'vitest'
import { validiereBuchungsEingabe } from '../buchung-form-validation'

describe('validiereBuchungsEingabe', () => {
  const basis = {
    typ: 'einlagerung' as const,
    artikelId: 'art-1',
    standortId: 'std-1',
    zielStandortId: '',
    menge: 1,
    sollMenge: 0,
  }

  describe('Pflichtfelder', () => {
    it('lehnt fehlenden Artikel ab', () => {
      expect(validiereBuchungsEingabe({ ...basis, artikelId: '' })).toBe('Artikel fehlt')
    })

    it('lehnt fehlenden Standort ab', () => {
      expect(validiereBuchungsEingabe({ ...basis, standortId: '' })).toBe('Standort fehlt')
    })

    it('akzeptiert vollständige Einlagerung', () => {
      expect(validiereBuchungsEingabe({ ...basis, typ: 'einlagerung', menge: 3 })).toBeNull()
    })

    it('akzeptiert vollständige Entnahme', () => {
      expect(validiereBuchungsEingabe({ ...basis, typ: 'entnahme', menge: 2 })).toBeNull()
    })
  })

  describe('Mengen-Validierung (einlagerung/entnahme/umlagerung)', () => {
    it.each([['einlagerung'], ['entnahme'], ['umlagerung']] as const)(
      'lehnt Menge 0 ab (%s)',
      (typ) => {
        expect(validiereBuchungsEingabe({ ...basis, typ, menge: 0 })).toBe('Menge muss > 0 sein')
      },
    )

    it.each([['einlagerung'], ['entnahme'], ['umlagerung']] as const)(
      'lehnt negative Menge ab (%s)',
      (typ) => {
        expect(validiereBuchungsEingabe({ ...basis, typ, menge: -1 })).toBe('Menge muss > 0 sein')
      },
    )

    it('lehnt NaN-Menge ab', () => {
      expect(validiereBuchungsEingabe({ ...basis, typ: 'einlagerung', menge: Number.NaN })).toBe(
        'Menge muss > 0 sein',
      )
    })

    it('lehnt Infinity-Menge ab', () => {
      expect(
        validiereBuchungsEingabe({
          ...basis,
          typ: 'einlagerung',
          menge: Number.POSITIVE_INFINITY,
        }),
      ).toBe('Menge muss > 0 sein')
    })
  })

  describe('Inventur-Soll-Menge', () => {
    it('akzeptiert Soll-Menge 0', () => {
      expect(validiereBuchungsEingabe({ ...basis, typ: 'inventur', sollMenge: 0 })).toBeNull()
    })

    it('akzeptiert Soll-Menge > 0', () => {
      expect(validiereBuchungsEingabe({ ...basis, typ: 'inventur', sollMenge: 42 })).toBeNull()
    })

    it('lehnt negative Soll-Menge ab', () => {
      expect(validiereBuchungsEingabe({ ...basis, typ: 'inventur', sollMenge: -1 })).toBe(
        'Soll-Menge fehlt oder ungültig',
      )
    })

    it('lehnt NaN-Soll-Menge ab', () => {
      expect(
        validiereBuchungsEingabe({
          ...basis,
          typ: 'inventur',
          sollMenge: Number.NaN,
        }),
      ).toBe('Soll-Menge fehlt oder ungültig')
    })

    it('ignoriert die Menge bei Inventur (muss nicht > 0 sein)', () => {
      // 0 ist hier OK, solange sollMenge gültig ist.
      expect(
        validiereBuchungsEingabe({ ...basis, typ: 'inventur', menge: 0, sollMenge: 5 }),
      ).toBeNull()
    })
  })

  describe('Umlagerung-spezifisch', () => {
    it('lehnt fehlenden Zielstandort ab', () => {
      expect(
        validiereBuchungsEingabe({
          ...basis,
          typ: 'umlagerung',
          menge: 1,
          zielStandortId: '',
        }),
      ).toBe('Zielstandort fehlt')
    })

    it('lehnt identischen Quell-/Zielstandort ab', () => {
      expect(
        validiereBuchungsEingabe({
          ...basis,
          typ: 'umlagerung',
          standortId: 'std-1',
          zielStandortId: 'std-1',
          menge: 1,
        }),
      ).toBe('Quell- und Zielstandort sind identisch')
    })

    it('akzeptiert gültige Umlagerung', () => {
      expect(
        validiereBuchungsEingabe({
          ...basis,
          typ: 'umlagerung',
          standortId: 'std-1',
          zielStandortId: 'std-2',
          menge: 5,
        }),
      ).toBeNull()
    })

    it('Mengen-Fehler wird vor Zielstandort-Fehler gemeldet (Reihenfolge ist deterministisch)', () => {
      expect(
        validiereBuchungsEingabe({
          ...basis,
          typ: 'umlagerung',
          menge: 0,
          zielStandortId: '',
        }),
      ).toBe('Menge muss > 0 sein')
    })
  })
})
