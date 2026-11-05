// The inventory export used to be German-only: every CSV/PDF label was a
// hardcoded string, so an English UI still produced German accounting files.
// The labels now follow the active locale.

import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '../../../i18n'
import type { InventurPosition, InventurStichtag } from '../../../db/types'
import { csvDatei } from '../pdf'

const stichtag: InventurStichtag = {
  id: 'st-1',
  stichtag: '15.11.2026',
  status: 'abgeschlossen',
  festgehaltenVon: 'user-1',
  festgehaltenVonName: 'Chef',
  erstelltAm: '2026-11-15T23:00:00.000Z',
}

const position: InventurPosition = {
  id: 'pos-1',
  stichtageId: 'st-1',
  artikelId: 'a-1',
  standortId: 's-1',
  titel: 'Akku 18V',
  typ: 'inventur',
  verpackungseinheit: 1,
  menge: 7,
  einkaufspreisCent: 1200,
  listenpreisCent: 2000,
  wert: 8400,
  inventurGeprueft: true,
  negativerBestand: false,
  erstelltAm: '2026-11-15T23:00:00.000Z',
}

function zeilen(opts: { mitPreise: boolean }): string[] {
  return csvDatei({ stichtage: [stichtag], positionen: [position], ...opts })
    .replace('\uFEFF', '')
    .split('\n')
}

describe('csvDatei — Lokalität', () => {
  afterEach(() => {
    i18n.global.locale.value = 'de-DE'
  })

  it('nutzt die deutsche Kopfzeile und den deutschen Status', () => {
    i18n.global.locale.value = 'de-DE'
    const [kopf, zeile] = zeilen({ mitPreise: true })
    expect(kopf).toContain('Stichtag')
    expect(kopf).toContain('EP (€)')
    expect(kopf).toContain('GP (€)')
    expect(zeile).toContain('abgeschlossen')
    expect(zeile).toContain('Inventur')
  })

  it('nutzt die englische Kopfzeile und den englischen Status', () => {
    i18n.global.locale.value = 'en-US'
    const [kopf, zeile] = zeilen({ mitPreise: true })
    expect(kopf).toContain('Cut-off date')
    expect(kopf).toContain('EP (€)')
    expect(kopf).toContain('GP (€)')
    expect(zeile).toContain('closed')
    expect(zeile).toContain('Inventory')
  })

  it('lässt Preisspalten ohne Berechtigung weg', () => {
    i18n.global.locale.value = 'en-US'
    const [kopf] = zeilen({ mitPreise: false })
    expect(kopf).not.toContain('EP (€)')
    expect(kopf).not.toContain('GP (€)')
  })
})
