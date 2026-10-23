import { describe, expect, it } from 'vitest'
import { sollMobilenScannerStarten } from '../layout'

describe('sollMobilenScannerStarten', () => {
  it('leitet den ersten mobilen Dashboard-Einstieg auf den Scanner um', () => {
    expect(
      sollMobilenScannerStarten({
        angemeldet: true,
        bereitsGestartet: false,
        mobil: true,
        routeName: 'dashboard',
      }),
    ).toBe(true)
  })

  it('leitet nur einmal um — spätere Dashboard-Taps bleiben normal', () => {
    expect(
      sollMobilenScannerStarten({
        angemeldet: true,
        bereitsGestartet: true,
        mobil: true,
        routeName: 'dashboard',
      }),
    ).toBe(false)
  })

  it('lässt Desktop-Nutzer unangetastet', () => {
    expect(
      sollMobilenScannerStarten({
        angemeldet: true,
        bereitsGestartet: false,
        mobil: false,
        routeName: 'dashboard',
      }),
    ).toBe(false)
  })

  it('leitet Deep-Links nicht um', () => {
    expect(
      sollMobilenScannerStarten({
        angemeldet: true,
        bereitsGestartet: false,
        mobil: true,
        routeName: 'artikel-detail',
      }),
    ).toBe(false)
  })

  it('leitet ohne Anmeldung nicht um', () => {
    expect(
      sollMobilenScannerStarten({
        angemeldet: false,
        bereitsGestartet: false,
        mobil: true,
        routeName: 'dashboard',
      }),
    ).toBe(false)
  })
})
