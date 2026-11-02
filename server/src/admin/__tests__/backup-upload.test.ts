// Tests fuer das Ablegen des Backup-Uploads.
//
// Regression: Der Upload wurde nach /tmp geschrieben und anschliessend per
// `rename` in das Backup-Volume verschoben. Im Container liegen /tmp
// (tmpfs) und /var/lib/castel/backups (Volume) auf VERSCHIEDENEN
// Dateisystemen — `rename` scheitert dort mit
// "EXDEV: cross-device link not permitted" und der Upload bricht mit
// HTTP 500 ab.
//
// Fix: der Upload landet direkt im Backup-Ordner (kein Dateisystem-
//wechsel) und `verschiebeDatei` faellt auf copy+unlink zurueck, falls
// `rename` doch scheitert.

import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mocks = vi.hoisted(() => ({ exdev: false }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (mocks.exdev) {
        throw Object.assign(new Error('EXDEV: cross-device link not permitted'), {
          code: 'EXDEV',
        })
      }
      return await actual.rename(from, to)
    },
  }
})

const { istExdev, verschiebeDatei } = await import('../backup.js')

describe('verschiebeDatei', () => {
  it('verschiebt die Datei im normalen Fall', async () => {
    mocks.exdev = false
    const dir = await mkdtemp(join(tmpdir(), 'castel-move-'))
    try {
      const quelle = join(dir, 'quelle.zip')
      const ziel = join(dir, 'ziel.zip')
      await writeFile(quelle, 'INHALT')

      await verschiebeDatei(quelle, ziel)

      expect(await readFile(ziel, 'utf8')).toBe('INHALT')
      await expect(readFile(quelle, 'utf8')).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('kopiert statt zu verschieben, wenn rename an einer Dateisystem-Grenze scheitert (EXDEV)', async () => {
    mocks.exdev = true
    const dir = await mkdtemp(join(tmpdir(), 'castel-move-'))
    try {
      const quelle = join(dir, 'quelle.zip')
      const ziel = join(dir, 'ziel.zip')
      await writeFile(quelle, 'INHALT')

      await verschiebeDatei(quelle, ziel)

      // Ziel existiert mit demselben Inhalt ...
      expect(await readFile(ziel, 'utf8')).toBe('INHALT')
      // ... und die Quelle ist weg (kein Duplikat im Backup-Ordner).
      await expect(readFile(quelle, 'utf8')).rejects.toThrow()
    } finally {
      mocks.exdev = false
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('erkennt den EXDEV-Fehler', () => {
    expect(istExdev(Object.assign(new Error('x'), { code: 'EXDEV' }))).toBe(true)
    expect(istExdev(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(false)
    expect(istExdev(new Error('x'))).toBe(false)
    expect(istExdev(null)).toBe(false)
  })
})
