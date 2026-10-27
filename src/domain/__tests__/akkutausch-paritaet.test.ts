// Byte-Identitäts-Test für die Akku-Typ-Validierung.
//
// Die Funktion `pruefeTypen` existiert bewusst identisch auf beiden Seiten:
//   - `src/domain/akkutausch/berechnung.ts` (PWA)
//   - `server/src/domain/akkutausch.ts` (Server)
// Der Server lehnt einen kaputten `akkuTypen`-Wert ab — driftende Regeln
// würden sonst auf einem Client fehlerhafte Größen erlauben, die der andere
// Client wieder verwirft. Analog zu `mindestbestand-paritaet.test.ts`.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const PWA_FILE = join(REPO_ROOT, 'src', 'domain', 'akkutausch', 'berechnung.ts')
const SERVER_FILE = join(REPO_ROOT, 'server', 'src', 'domain', 'akkutausch.ts')

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

describe('Akku-Typ-Validierung ist byte-identisch (PWA ↔ Server)', () => {
  it('Repo-Layout unverändert (beide Dateien müssen existieren)', () => {
    expect(() => readFileSync(PWA_FILE)).not.toThrow()
    expect(() => readFileSync(SERVER_FILE)).not.toThrow()
  })

  it('pruefeTypen: PWA == Server', () => {
    const pwaSrc = readFileSync(PWA_FILE, 'utf8')
    const serverSrc = readFileSync(SERVER_FILE, 'utf8')
    const pwaFn = normalize(extractFunction(pwaSrc, 'pruefeTypen'))
    const serverFn = normalize(extractFunction(serverSrc, 'pruefeTypen'))
    expect(pwaFn).toBe(serverFn)
  })
})
