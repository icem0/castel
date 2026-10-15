// Byte-Identitäts-Test für die Pure-Funktionen in `berechneBestand`.
//
// Die Pure-Funktionen in
//   - `src/domain/bestand.ts` (PWA, Dexie-Layer)
//   - `server/src/domain/bestand.ts` (Server, `berechneBestandPure`)
// sind absichtlich byte-identisch (nur die Namen + der SQL-Layer drumherum
// unterscheiden sich). Das verhindert Drift zwischen Client und Server —
// ein klassischer Finetuning-2-Aufhänger.
//
// Wir lesen beide Quelldateien ein, normalisieren (Whitespace + CRLF,
// Funktionsnamen angleichen) und verlangen Gleichheit des Rumpfes.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const PWA_FILE = join(REPO_ROOT, 'src', 'domain', 'bestand.ts')
const SERVER_FILE = join(REPO_ROOT, 'server', 'src', 'domain', 'bestand.ts')

/**
 * Normalisiert eine Quelltext-Zeile für den Vergleich: Whitespace
 * zusammenfassen, CRLF → LF, Kommentare raus. Wir vergleichen die reine
 * Logik, nicht die Formatierung.
 */
function normalize(source: string): string {
  return source
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}();,])\s*/g, '$1')
    .replace(/;\s*}/g, '}')
    .replace(/,(\s*[\])])/g, '$1') // trailing commas in fn signatures
    .trim()
}

/**
 * Extrahiert die Funktionskörper aus einer TypeScript-Datei.
 * Wir suchen nach `export function NAME(` und lesen bis zur schließenden
 * geschweiften Klammer. So holen wir den Byte-für-Byte-Funktionsrumpf.
 */
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

function extractFunctionAt(source: string, start: number): string {
  let i = source.indexOf('{', start)
  if (i < 0) throw new Error(`'{' nicht gefunden ab Position ${start}`)
  let depth = 0
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`Funktion ab Position ${start}: nicht abgeschlossen`)
}

describe('Pure-Funktionen sind byte-identisch (PWA ↔ Server)', () => {
  it('Repo-Layout unverändert (beide Dateien müssen existieren)', () => {
    expect(() => readFileSync(PWA_FILE)).not.toThrow()
    expect(() => readFileSync(SERVER_FILE)).not.toThrow()
  })

  it('berechneBestand: PWA == Server (Pure-Variante)', () => {
    const pwaSrc = readFileSync(PWA_FILE, 'utf8')
    const serverSrc = readFileSync(SERVER_FILE, 'utf8')
    const pwaFn = normalize(extractFunction(pwaSrc, 'berechneBestand'))
    const serverFn = normalize(extractFunction(serverSrc, 'berechneBestandPure'))
    // Funktionsname unterscheidet sich (PWA: bare, Server: Pure-Suffix) —
    // für den Byte-Vergleich normalisieren wir den Namen.
    const serverFnNormalisiert = serverFn.replace('berechneBestandPure', 'berechneBestand')
    expect(pwaFn).toBe(serverFnNormalisiert)
  })

  it('berechneBestandProStandort: PWA == Server (Pure-Variante)', () => {
    const pwaSrc = readFileSync(PWA_FILE, 'utf8')
    const serverSrc = readFileSync(SERVER_FILE, 'utf8')
    const pwaFn = normalize(extractFunction(pwaSrc, 'berechneBestandProStandort'))
    const serverFn = normalize(extractFunction(serverSrc, 'berechneBestandProStandortPure'))
    const serverFnNormalisiert = serverFn.replace(
      'berechneBestandProStandortPure',
      'berechneBestandProStandort',
    )
    expect(pwaFn).toBe(serverFnNormalisiert)
  })

  it('summeAktiveBuchungen: PWA == Server (Pure-Variante)', () => {
    const pwaSrc = readFileSync(PWA_FILE, 'utf8')
    const serverSrc = readFileSync(SERVER_FILE, 'utf8')
    const pwaFn = normalize(extractFunction(pwaSrc, 'summeAktiveBuchungen'))
    const serverFn = normalize(extractFunction(serverSrc, 'summeAktiveBuchungenPure'))
    const serverFnNormalisiert = serverFn.replace(
      'summeAktiveBuchungenPure',
      'summeAktiveBuchungen',
    )
    expect(pwaFn).toBe(serverFnNormalisiert)
  })

  it('BestandBuchung-Interface ist auf beiden Seiten strukturell gleich', () => {
    const pwaSrc = readFileSync(PWA_FILE, 'utf8')
    const serverSrc = readFileSync(SERVER_FILE, 'utf8')
    const pwaIface = normalize(extractInterface(pwaSrc, 'BestandBuchung'))
    const serverIface = normalize(extractInterface(serverSrc, 'BestandBuchung'))
    expect(pwaIface).toBe(serverIface)
  })

  it('Server-SQL-Formel (berechneBestand) summiert nur über standortId = :s', () => {
    // Sicherheitsnetz: Die SQL-Variante darf die Umlagerungs-Doppel-
    // zählung nicht wieder einführen. Wir verlangen, dass der Code
    // `standortZielId` NICHT in der where-Klausel der SQL-Funktion
    // auftaucht — die korrekte Formel filtert ausschließlich über
    // `standortId` (PLAN §4).
    const serverSrc = readFileSync(SERVER_FILE, 'utf8')
    // Wir matchen sowohl Pure als auch SQL: ein `berechneBestandPure`
    // und ein `export async function berechneBestand(`. Wir wollen die
    // SQL-Variante (die zweite).
    const matches = [
      ...serverSrc.matchAll(
        /export\s+(?:async\s+)?function\s+berechneBestand(?:Pure)?\s*\([^)]*\)\s*:\s*[^{]*\{/g,
      ),
    ]
    expect(matches.length).toBe(2)
    const sqlStart = matches[1]!.index!
    const sqlFn = extractFunctionAt(serverSrc, sqlStart)
    expect(sqlFn).not.toMatch(/standortZielId/)
  })
})
