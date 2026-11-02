// Tests des Rollen-Stacks im Auth-Store.
//
// Der Store beantwortet die Frage "darf der User X?" mit `hat()`.
//   * Die Server-Liste der effektiven Berechtigungen hat Vorrang.
//   * Sessions ohne diese Liste (aeltere Versionen) werden lokal aus der
//     Matrix berechnet.
//   * Der Rollen-Stack ist additiv: user + lagerist stapelt sich.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '../auth'
import { sessionSchreiben } from '../../auth/session'

function sessionSetzen(rollen: Array<'user' | 'lagerist' | 'admin'>, berechtigungen?: string[]) {
  sessionSchreiben({
    userId: 'u1',
    email: 'a@b.de',
    rolle: rollen.includes('admin') ? 'admin' : 'user',
    rollen,
    ...(berechtigungen ? { berechtigungen: berechtigungen as never } : {}),
    anzeigename: 'Test',
    loginAm: '2026-10-29T12:00:00.000Z',
    mustChangePassword: false,
    jwtExpiresAt: '2026-10-30T12:00:00.000Z',
  })
}

describe('Auth-Store — Rollen und Berechtigungen', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    sessionSchreiben(null)
  })

  it('leitet den Rollen-Stack aus der Legacy-Einzelrolle ab', () => {
    sessionSetzen(['admin'])
    setActivePinia(createPinia())
    const auth = useAuthStore()
    expect(auth.rollen).toEqual(['admin'])
    expect(auth.istAdmin).toBe(true)
  })

  it('admin hat alle Berechtigungen', () => {
    sessionSetzen(['admin'])
    setActivePinia(createPinia())
    const auth = useAuthStore()
    expect(auth.hat('artikel.loeschen')).toBe(true)
    expect(auth.hat('standort.loeschen')).toBe(true)
    expect(auth.hat('einkaufspreis')).toBe(true)
    expect(auth.hat('entwicklung')).toBe(true)
  })

  it('user darf keine Stammdaten aendern', () => {
    sessionSetzen(['user'])
    setActivePinia(createPinia())
    const auth = useAuthStore()
    expect(auth.hat('artikel.lesen')).toBe(true)
    expect(auth.hat('buchung.erstellen')).toBe(true)
    expect(auth.hat('artikel.schreiben')).toBe(false)
    expect(auth.hat('standort.schreiben')).toBe(false)
    expect(auth.hat('mindestbestand.schreiben')).toBe(false)
    expect(auth.hat('einkaufspreis')).toBe(false)
  })

  it('lagerist stapelt auf dem user auf', () => {
    sessionSetzen(['user', 'lagerist'])
    setActivePinia(createPinia())
    const auth = useAuthStore()
    expect(auth.rollen).toEqual(['user', 'lagerist'])
    expect(auth.hat('artikel.lesen')).toBe(true)
    expect(auth.hat('artikel.schreiben')).toBe(true)
    expect(auth.hat('artikel.loeschen')).toBe(true)
    expect(auth.hat('standort.schreiben')).toBe(true)
    expect(auth.hat('mindestbestand.schreiben')).toBe(true)
    // aber keine Admin-Sache
    expect(auth.hat('standort.loeschen')).toBe(false)
    expect(auth.hat('einkaufspreis')).toBe(false)
    expect(auth.hat('benutzer.verwalten')).toBe(false)
  })

  it('die Server-Liste der Berechtigungen hat Vorrang vor der lokalen Matrix', () => {
    sessionSetzen(['admin'], ['artikel.lesen'])
    setActivePinia(createPinia())
    const auth = useAuthStore()
    expect(auth.hat('artikel.lesen')).toBe(true)
    expect(auth.hat('artikel.loeschen')).toBe(false)
    expect(auth.hat('standort.loeschen')).toBe(false)
  })

  it('ohne Session hat niemand Rechte', () => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    expect(auth.rollen).toEqual([])
    expect(auth.istAdmin).toBe(false)
    expect(auth.hat('artikel.lesen')).toBe(false)
  })
})
