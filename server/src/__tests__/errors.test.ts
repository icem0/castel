// Tests für die Error-Hierarchie (kein DB-Zugriff nötig).

import { describe, it, expect } from 'vitest'
import {
  BereitsStorniertError,
  DomainError,
  GleicherStandortError,
  InventurNichtErlaubtError,
  NegativerBestandError,
  NotFoundError,
  UnbekannteReferenzError,
  ValidationError,
} from '../domain/errors.js'

describe('Domain-Errors', () => {
  it('DomainError trägt code und message', () => {
    const e = new DomainError('X', 'foo')
    expect(e.code).toBe('X')
    expect(e.message).toBe('foo')
    expect(e.name).toBe('DomainError')
    expect(e).toBeInstanceOf(Error)
  })

  it('NegativerBestandError liefert Kontext', () => {
    const e = new NegativerBestandError('a1', 's1', 3, 5)
    expect(e.code).toBe('NEGATIVE_BESTAND')
    expect(e.artikelId).toBe('a1')
    expect(e.standortId).toBe('s1')
    expect(e.aktuellerBestand).toBe(3)
    expect(e.angeforderteMenge).toBe(5)
    expect(e.message).toMatch(/aktuell 3/)
  })

  it('ValidationError nennt Feld und Grund', () => {
    const e = new ValidationError('menge', 'muss positiv sein')
    expect(e.code).toBe('VALIDATION')
    expect(e.feld).toBe('menge')
    expect(e.grund).toBe('muss positiv sein')
  })

  it('UnbekannteReferenzError unterscheidet Entity', () => {
    expect(new UnbekannteReferenzError('artikel', 'a').entity).toBe('artikel')
    expect(new UnbekannteReferenzError('standort', 's').entity).toBe('standort')
  })

  it('GleicherStandortError', () => {
    const e = new GleicherStandortError()
    expect(e.code).toBe('GLEICHER_STANDORT')
  })

  it('BereitsStorniertError trägt buchungId', () => {
    expect(new BereitsStorniertError('b1').buchungId).toBe('b1')
  })

  it('InventurNichtErlaubtError', () => {
    expect(new InventurNichtErlaubtError('foo').grund).toBe('foo')
  })

  it('NotFoundError', () => {
    const e = new NotFoundError('Artikel', 'x')
    expect(e.code).toBe('NOT_FOUND')
    expect(e.message).toContain('Artikel')
    expect(e.message).toContain('x')
  })
})