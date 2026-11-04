// Locale guards for the whole app — the inventory screen taught us these:
//
// * `view.inventur.hilfeGespeichert` used the named placeholder
//   `{übersprungen}`. vue-i18n's message compiler only accepts ASCII
//   identifiers, so compiling the message threw and the UI rendered the raw
//   key instead of the text.
// * A key existed only in de-DE, so the English UI silently showed German.
// * `&amp;` in a message is not HTML-rendered by `{{ t(...) }}` — users saw the
//   entity literally.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import de from '../de-DE'
import en from '../en-US'

type Messages = Record<string, unknown>

function flatten(obj: Messages, prefix = ''): Map<string, string> {
  const out = new Map<string, string>()
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object') {
      for (const [k, v] of flatten(value as Messages, path)) out.set(k, v)
    } else if (typeof value === 'string') {
      out.set(path, value)
    }
  }
  return out
}

const deMap = flatten(de as Messages)
const enMap = flatten(en as Messages)

// jsdom turns `import.meta.url` into an http URL, so resolve the source tree
// from the vitest working directory (the project root).
const SRC_DIR = resolve(process.cwd(), 'src')

function srcFiles(dir = SRC_DIR, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) srcFiles(path, acc)
    else if (
      /\.(ts|vue)$/.test(path) &&
      !path.includes('__tests__') &&
      !path.endsWith('.test.ts') &&
      !path.endsWith('.d.ts') &&
      !path.includes(`${sep}locales${sep}`)
    )
      acc.push(path)
  }
  return acc
}

describe('Locale de-DE / en-US', () => {
  it('beide Locales decken exakt dieselben Schlüssel ab', () => {
    const nurDe = [...deMap.keys()].filter((k) => !enMap.has(k))
    const nurEn = [...enMap.keys()].filter((k) => !deMap.has(k))
    expect({ nurDe, nurEn }).toEqual({ nurDe: [], nurEn: [] })
  })

  it('Platzhalter-Namen sind ASCII-Bezeichner (vue-i18n kompiliert sonst nicht)', () => {
    const kaputt: string[] = []
    for (const [locale, map] of [
      ['de-DE', deMap],
      ['en-US', enMap],
    ] as const) {
      for (const [key, text] of map) {
        for (const match of text.matchAll(/\{([^{}]*)\}/g)) {
          const name = match[1] ?? ''
          if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
            kaputt.push(`${locale} ${key} -> {${name}}`)
          }
        }
      }
    }
    expect(kaputt).toEqual([])
  })

  it('Nachrichten enthalten keine HTML-Entities ({{ t() }} rendert sie wörtlich)', () => {
    const entities = [...deMap, ...enMap]
      .filter(([, text]) => /&(amp|lt|gt|quot|#\d+);/.test(text))
      .map(([key, text]) => `${key}: ${text}`)
    expect(entities).toEqual([])
  })

  it('jede im Quelltext genutzte t()-Rohrschlüssel existiert in beiden Locales', () => {
    const files = srcFiles()
    expect(files.length).toBeGreaterThan(50)
    const fehlend: string[] = []
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) {
        const key = match[1] ?? ''
        if (!deMap.has(key)) fehlend.push(`de-DE ${key} (${file})`)
        if (!enMap.has(key)) fehlend.push(`en-US ${key} (${file})`)
      }
    }
    expect(fehlend).toEqual([])
  })
})
