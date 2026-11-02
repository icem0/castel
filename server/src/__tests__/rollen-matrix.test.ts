// Tests der Rollen-Matrix (server/src/domain/rollen.ts).
//
// Die Matrix ist die einzige Quelle der Wahrheit fuer Rollen und Rechte.
// Diese Tests sichern die Semantik ab, auf die sich der Sync-Resolver und
// die PWA verlassen.

import { describe, expect, it } from 'vitest'
import {
  BERECHTIGUNG_INFO,
  PERMISSIONS,
  ROLLEN,
  ROLLEN_BEREECHTIGUNGEN,
  ROLLEN_INFO,
  berechtigungenFuer,
  hatBerechtigung,
  istAdmin,
  legacyRolle,
  normalisiereRollen,
} from '../domain/rollen.js'

describe('normalisiereRollen', () => {
  it('ergaenzt die Basisrolle user', () => {
    expect(normalisiereRollen([])).toEqual(['user'])
    expect(normalisiereRollen(['lagerist'])).toEqual(['user', 'lagerist'])
  })

  it('macht admin exklusiv', () => {
    expect(normalisiereRollen(['admin', 'lagerist'])).toEqual(['admin'])
    expect(normalisiereRollen(['user', 'admin'])).toEqual(['admin'])
  })

  it('verwirft unbekannte Rollen', () => {
    expect(normalisiereRollen(['user', 'gibtsnicht'])).toEqual(['user'])
  })

  it('akzeptiert den Legacy-Einzelwert', () => {
    expect(normalisiereRollen('admin')).toEqual(['admin'])
    expect(normalisiereRollen('user')).toEqual(['user'])
  })

  it('dedupliziert', () => {
    expect(normalisiereRollen(['user', 'lagerist', 'lagerist'])).toEqual(['user', 'lagerist'])
  })

  it('liefert bei Unsinn immer mindestens user', () => {
    expect(normalisiereRollen(undefined)).toEqual(['user'])
    expect(normalisiereRollen(null)).toEqual(['user'])
    expect(normalisiereRollen(42)).toEqual(['user'])
  })
})

describe('hatBerechtigung', () => {
  it('admin hat alles', () => {
    for (const p of PERMISSIONS) {
      expect(hatBerechtigung(['admin'], p)).toBe(true)
    }
  })

  it('admin wird auch mit weiteren Rollen erkannt', () => {
    expect(hatBerechtigung(['user', 'lagerist', 'admin'], 'standort.loeschen')).toBe(true)
  })

  it('user darf nur Basisrechte', () => {
    expect(hatBerechtigung(['user'], 'artikel.lesen')).toBe(true)
    expect(hatBerechtigung(['user'], 'buchung.erstellen')).toBe(true)
    expect(hatBerechtigung(['user'], 'artikel.schreiben')).toBe(false)
    expect(hatBerechtigung(['user'], 'standort.loeschen')).toBe(false)
    expect(hatBerechtigung(['user'], 'einkaufspreis')).toBe(false)
  })

  it('lagerist stapelt auf dem user auf', () => {
    expect(hatBerechtigung(['user', 'lagerist'], 'artikel.schreiben')).toBe(true)
    expect(hatBerechtigung(['user', 'lagerist'], 'artikel.loeschen')).toBe(true)
    expect(hatBerechtigung(['user', 'lagerist'], 'standort.schreiben')).toBe(true)
    expect(hatBerechtigung(['user', 'lagerist'], 'mindestbestand.schreiben')).toBe(true)
    // aber keine Admin-Sache
    expect(hatBerechtigung(['user', 'lagerist'], 'einkaufspreis')).toBe(false)
    expect(hatBerechtigung(['user', 'lagerist'], 'standort.loeschen')).toBe(false)
    expect(hatBerechtigung(['user', 'lagerist'], 'benutzer.verwalten')).toBe(false)
  })

  it('ohne Rollen hat niemand Rechte', () => {
    expect(hatBerechtigung([], 'artikel.lesen')).toBe(false)
    expect(hatBerechtigung(undefined, 'artikel.lesen')).toBe(false)
  })
})

describe('Matrix-Konsistenz', () => {
  it('jede Rolle hat Beschreibung und Rechte', () => {
    for (const rolle of ROLLEN) {
      expect(ROLLEN_INFO[rolle].titel.length).toBeGreaterThan(0)
      expect(ROLLEN_INFO[rolle].beschreibung.length).toBeGreaterThan(0)
      expect(ROLLEN_INFO[rolle].rechte.length).toBeGreaterThan(0)
    }
  })

  it('jede Berechtigung hat Beschreibung', () => {
    for (const p of PERMISSIONS) {
      expect(BERECHTIGUNG_INFO[p].titel.length).toBeGreaterThan(0)
      expect(BERECHTIGUNG_INFO[p].beschreibung.length).toBeGreaterThan(0)
    }
  })

  it('die Matrix enthaelt nur bekannte Berechtigungen', () => {
    for (const rolle of ROLLEN) {
      for (const p of ROLLEN_BEREECHTIGUNGEN[rolle]) {
        expect(PERMISSIONS).toContain(p)
      }
    }
  })

  it('admin deckt alle Berechtigungen ab', () => {
    expect([...ROLLEN_BEREECHTIGUNGEN.admin].sort()).toEqual([...PERMISSIONS].sort())
  })

  it('berechtigungenFuer vereinigt die Rollen', () => {
    const vereinigt = berechtigungenFuer(['user', 'lagerist'])
    expect(vereinigt).toContain('artikel.lesen')
    expect(vereinigt).toContain('artikel.schreiben')
    expect(vereinigt).not.toContain('einkaufspreis')
  })

  it('legacyRolle leitet admin/user ab', () => {
    expect(legacyRolle(['admin'])).toBe('admin')
    expect(legacyRolle(['user', 'lagerist'])).toBe('user')
  })

  it('istAdmin erkennt die Admin-Rolle', () => {
    expect(istAdmin(['admin'])).toBe(true)
    expect(istAdmin(['user', 'lagerist'])).toBe(false)
    expect(istAdmin([])).toBe(false)
  })
})
