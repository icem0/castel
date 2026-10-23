// Byte-Identitäts-Test für die Pure-Funktionen in `mindestbestand`.
//
// Die Pure-Funktionen in
//   - `src/domain/mindestbestand.ts` (PWA)
//   - `server/src/domain/mindestbestand.ts` (Server)
// sind absichtlich byte-identisch. Das verhindert Drift zwischen
// Client und Server — analog zu `bestand-paritaet.test.ts` für die
// Bestandsformel.
//
// Wir lesen beide Quelldateien ein, normalisieren Whitespace/CRLF
// und verlangen Gleichheit des Rumpfes.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const PWA_FILE = join(REPO_ROOT, 'src', 'domain', 'mindestbestand.ts')
const SERVER_FILE = join(REPO_ROOT, 'server', 'src', 'domain', 'mindestbestand.ts')

function normalize(source: string): string {
  return source
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}();,])\s*/g, '$1')
    .replace(/;\s*}/g, '}')
    .replace(/,(\s*[\])])/g, '$1')
    .trim()
}

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`export function ${name}(`)
  if (start < 0) throw new Error(`Funktion ${name} nicht gefunden`)
  let i = source.indexOf('{', start)
  if (i < 0) throw new Error(`Funktion ${name}: '{' nicht gefunden`)
  let depth = 0
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`Funktion ${name}: nicht abgeschlossen`)
}

function extractInterface(source: string, name: string): string {
  const start = source.indexOf(`export interface ${name}`)
  if (start < 0) throw new Error(`Interface ${name} nicht gefunden`)
  let i = source.indexOf('{', start)
  if (i < 0) throw new Error(`Interface ${name}: '{' nicht gefunden`)
  let depth = 0
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`Interface ${name}: nicht abgeschlossen`)
}

describe('Mindestbestand-Pure-Funktionen sind byte-identisch (PWA ↔ Server)', () => {
  it('Repo-Layout unverändert (beide Dateien müssen existieren)', () => {
    expect(() => readFileSync(PWA_FILE)).not.toThrow()
    expect(() => readFileSync(SERVER_FILE)).not.toThrow()
  })

  it('sollteWarnungAusloesen: PWA == Server', () => {
    const pwaSrc = readFileSync(PWA_FILE, 'utf8')
    const serverSrc = readFileSync(SERVER_FILE, 'utf8')
    const pwaFn = normalize(extractFunction(pwaSrc, 'sollteWarnungAusloesen'))
    const serverFn = normalize(extractFunction(serverSrc, 'sollteWarnungAusloesen'))
    expect(pwaFn).toBe(serverFn)
  })

  it('berechneDefizit: PWA == Server', () => {
    const pwaSrc = readFileSync(PWA_FILE, 'utf8')
    const serverSrc = readFileSync(SERVER_FILE, 'utf8')
    const pwaFn = normalize(extractFunction(pwaSrc, 'berechneDefizit'))
    const serverFn = normalize(extractFunction(serverSrc, 'berechneDefizit'))
    expect(pwaFn).toBe(serverFn)
  })

  it('berechneDefizitAktuell: PWA == Server', () => {
    const pwaSrc = readFileSync(PWA_FILE, 'utf8')
    const serverSrc = readFileSync(SERVER_FILE, 'utf8')
    const pwaFn = normalize(extractFunction(pwaSrc, 'berechneDefizitAktuell'))
    const serverFn = normalize(extractFunction(serverSrc, 'berechneDefizitAktuell'))
    expect(pwaFn).toBe(serverFn)
  })

  it('MindestbestandArtikel-Interface ist auf beiden Seiten strukturell gleich', () => {
    const pwaSrc = readFileSync(PWA_FILE, 'utf8')
    const serverSrc = readFileSync(SERVER_FILE, 'utf8')
    const pwaIface = normalize(extractInterface(pwaSrc, 'MindestbestandArtikel'))
    const serverIface = normalize(extractInterface(serverSrc, 'MindestbestandArtikel'))
    expect(pwaIface).toBe(serverIface)
  })
})

describe('sollteWarnungAusloesen — Verhalten (PWA-Import)', () => {
  it('null-Mindestbestand: nie auslösen', async () => {
    const { sollteWarnungAusloesen } = await import('../mindestbestand')
    expect(sollteWarnungAusloesen(null, 0)).toBe(false)
    expect(sollteWarnungAusloesen(null, -10)).toBe(false)
  })

  it('Bestand >= Mindestbestand: nicht auslösen', async () => {
    const { sollteWarnungAusloesen } = await import('../mindestbestand')
    expect(sollteWarnungAusloesen(5, 5)).toBe(false)
    expect(sollteWarnungAusloesen(5, 6)).toBe(false)
  })

  it('Bestand < Mindestbestand: auslösen', async () => {
    const { sollteWarnungAusloesen } = await import('../mindestbestand')
    expect(sollteWarnungAusloesen(5, 4)).toBe(true)
    expect(sollteWarnungAusloesen(5, 0)).toBe(true)
    expect(sollteWarnungAusloesen(5, -3)).toBe(true)
  })
})
