// Drift-Test: die Berechtigungs-IDs in src/domain/rollen.ts (Client) müssen
// mit server/src/domain/rollen.ts (Server, Quelle der Wahrheit) identisch sein.
//
// Die Server-Datei wird als Text gelesen (kein TS-Import), damit der
// PWA-Build nicht vom Server-Paket abhängt. Geprüft werden die flachen
// ID-Listen (ROLLEN, PERMISSIONS); die Matrix-Zuordnung ist ein internes
// Detail der Server-Datei (Variablen statt inline-Arrays) und wird nicht
// per Text verglichen.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PERMISSIONS, ROLLEN } from '../rollen'

const SERVER_PATH = join(__dirname, '../../../server/src/domain/rollen.ts')
const SERVER_SOURCE = readFileSync(SERVER_PATH, 'utf8')

/** Extrahiert den Inhalt eines `export const X = [...] as const`-Blocks und
 *  filtert Kommentarzeilen heraus. */
function extractArray(source: string, declaration: string): string[] {
  const match = source.match(
    new RegExp(declaration + '\\s*=\\s*\\[([^\\]]*)\\]'),
  )
  if (!match) throw new Error(`Konnte ${declaration} in ${SERVER_PATH} nicht finden`)
  // Alle String-Literale im Block extrahieren (Kommentare werden so ignoriert).
  return [...match[1]!.matchAll(/['"]([^'"]*)['"]/g)].map((m) => m[1]!)
}

describe('Rollen-Matrix: Client vs. Server (Drift)', () => {
  it('die Rollen-Listen stimmen überein', () => {
    const serverRollen = extractArray(SERVER_SOURCE, 'export const ROLLEN')
    expect(serverRollen).toEqual([...ROLLEN])
  })

  it('die Berechtigungs-Listen stimmen überein', () => {
    const serverPermissions = extractArray(SERVER_SOURCE, 'export const PERMISSIONS')
    expect(serverPermissions).toEqual([...PERMISSIONS])
  })
})
