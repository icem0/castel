import { describe, expect, it } from 'vitest'
import { bestellZiel, istBestelltFuerEreignis } from '../bestellung'

describe('bestellZiel', () => {
  it('baut eine mailto-URL mit Betreff und Text', () => {
    const ziel = bestellZiel(
      { bestellEmail: 'order@example.com', bestellWebseite: 'https://example.com' },
      { betreff: 'Bestellung: Schraube', text: 'Bitte liefern' },
    )
    expect(ziel?.mailto).toBe(true)
    expect(ziel?.href).toBe(
      'mailto:order@example.com?subject=Bestellung%3A%20Schraube&body=Bitte%20liefern',
    )
  })

  it('nutzt die Webseite, wenn keine E-Mail hinterlegt ist', () => {
    const ziel = bestellZiel(
      { bestellEmail: null, bestellWebseite: 'https://shop.example.com' },
      { betreff: 'x', text: 'y' },
    )
    expect(ziel).toEqual({ href: 'https://shop.example.com', mailto: false })
  })

  it('ergaenzt ein fehlendes https://-Schema', () => {
    const ziel = bestellZiel(
      { bestellEmail: null, bestellWebseite: 'shop.example.com' },
      { betreff: 'x', text: 'y' },
    )
    expect(ziel?.href).toBe('https://shop.example.com')
  })

  it('gibt null zurueck, wenn kein Kontakt existiert', () => {
    expect(
      bestellZiel({ bestellEmail: null, bestellWebseite: null }, { betreff: 'x', text: 'y' }),
    ).toBeNull()
    expect(bestellZiel(null, { betreff: 'x', text: 'y' })).toBeNull()
  })
})

describe('istBestelltFuerEreignis', () => {
  const ereignis = '2026-10-15T10:00:00.000Z'

  it('ist false ohne Bestellung', () => {
    expect(istBestelltFuerEreignis({ bestellstatus: 'offen', bestelltAm: null }, ereignis)).toBe(
      false,
    )
  })

  it('ist true, wenn nach dem Alarm bestellt wurde', () => {
    expect(
      istBestelltFuerEreignis(
        { bestellstatus: 'bestellt', bestelltAm: '2026-10-15T10:05:00.000Z' },
        ereignis,
      ),
    ).toBe(true)
  })

  it('ist false, wenn die Bestellung vor dem Alarm lag', () => {
    expect(
      istBestelltFuerEreignis(
        { bestellstatus: 'bestellt', bestelltAm: '2026-10-14T10:00:00.000Z' },
        ereignis,
      ),
    ).toBe(false)
  })
})
