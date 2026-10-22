// Tests fuer den Backup-/Restore-Pfad.
//
// Kern der Regression: Ein fehlgeschlagener pg_dump (typisch: Client- und
// Server-Version passen nicht zusammen) liefert einen 0-Byte-Dump. Frueher
// wurde daraus ein ZIP mit "Erfolg" gemeldet — der Restore brach dann mit
// "pg_restore: error: input file is too short" ab und wurde trotzdem als
// Erfolg quittiert.
//
// Getestet wird deshalb:
//   - baueBackupZip lehnt ab, wenn pg_dump fehlschlaegt oder 0 Bytes liefert.
//   - restoreAusZip lehnt leere/beschaedigte Dumps ab, BEVOR pg_restore laeuft.
//   - restoreAusZip wertet den pg_restore-Exit-Code aus (jeder != 0 = Fehler).
//   - listeBackups erkennt ZIPs mit leerem Dump (dumpOk: false).

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import archiver from 'archiver'

const mocks = vi.hoisted(() => ({
  pgRestore: {
    code: 0 as number | null,
    stderr: '',
    calls: [] as string[][],
  },
}))

// pg_restore wird gemockt (im CI-Container gibt es evtl. kein pg_restore,
// und ein echter Restore wuerde die DB anfassen). 'unzip' laeuft echt —
// damit testen wir die ZIP-Erzeugung und das Entpacken realistisch.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (cmd: string, args: string[], opts?: unknown) => {
      if (cmd !== 'pg_restore') return actual.spawn(cmd, args, opts as never)
      mocks.pgRestore.calls.push(args)
      const child = new EventEmitter() as EventEmitter & {
        stdout: Readable
        stderr: Readable
      }
      const stdout = new Readable({ read() {} })
      const stderr = new Readable({ read() {} })
      child.stdout = stdout
      child.stderr = stderr
      setTimeout(() => {
        stdout.push(null)
        stderr.push(Buffer.from(mocks.pgRestore.stderr))
        stderr.push(null)
        setImmediate(() => child.emit('close', mocks.pgRestore.code))
      }, 0)
      return child
    },
  }
})

const { baueBackupZip, dumpGroesseImZip, listeBackups, restoreAusZip } = await import(
  '../backup.js'
)
type PgDumpHandle = import('../backup.js').PgDumpHandle

const MANIFEST = JSON.stringify({
  schema: 'castel-backup-1',
  createdAt: '2026-10-22T14:07:04.258Z',
  forceAt: '2026-10-22T14:07:00.000Z',
  serverTime: '2026-10-22T14:07:04.258Z',
  dbCounts: { buchungen: 3 },
  fotoCount: 0,
  tool: 'test',
})

/** Fake-PgDump-Handle mit frei einstellbarem Exit-Code und Payload. */
function fakePgDump(data: Buffer, code: number | null, stderr = ''): PgDumpHandle {
  const stream = new Readable({
    read() {
      this.push(data)
      this.push(null)
    },
  })
  return {
    stream,
    exit: Promise.resolve({ code, signal: null, stderr }),
    bytes: () => data.length,
  }
}

/** Sammelt die ZIP-Bytes in einem Buffer. */
function sammleZip(): { writable: Writable; bytes: () => number } {
  const chunks: Buffer[] = []
  const writable = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk))
      cb()
    },
  })
  return { writable, bytes: () => chunks.reduce((n, c) => n + c.length, 0) }
}

/** Baut ein ZIP mit den angegebenen Eintraegen und liefert den Pfad. */
async function baueZip(dateien: Record<string, string | Buffer>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'castel-testzip-'))
  const zipPfad = join(dir, 'castel-backup-test.zip')
  const out = createWriteStream(zipPfad)
  const archive = archiver('zip')
  const fertig = new Promise<void>((resolve, reject) => {
    out.on('close', resolve)
    out.on('error', reject)
    archive.on('error', reject)
  })
  archive.pipe(out)
  for (const [name, inhalt] of Object.entries(dateien)) {
    archive.append(inhalt, { name })
  }
  await archive.finalize()
  await fertig
  return zipPfad
}

describe('baueBackupZip', () => {
  it('baut ein ZIP, wenn pg_dump Daten liefert', async () => {
    const payload = Buffer.from('PGDMP-dummy-dump')
    const { writable, bytes } = sammleZip()
    const result = await baueBackupZip({
      out: writable,
      pgDump: fakePgDump(payload, 0),
      forceAt: '2026-10-22T14:07:00.000Z',
      dbCounts: { buchungen: 3 },
      tool: 'test',
    })
    expect(result.dumpBytes).toBe(payload.length)
    expect(result.bytes).toBeGreaterThan(0)
    expect(bytes()).toBeGreaterThan(0)
    expect(result.manifest.schema).toBe('castel-backup-1')
  })

  it('lehnt ab, wenn pg_dump mit Fehler endet (Versionskonflikt o. ae.)', async () => {
    const { writable } = sammleZip()
    await expect(
      baueBackupZip({
        out: writable,
        pgDump: fakePgDump(
          Buffer.alloc(0),
          1,
          'pg_dump: error: server version: 16.4; pg_dump version: 15.13',
        ),
        forceAt: '2026-10-22T14:07:00.000Z',
        dbCounts: { buchungen: 3 },
        tool: 'test',
      }),
    ).rejects.toThrow(/pg_dump fehlgeschlagen \(exit 1\)/)
  })

  it('lehnt ab, wenn pg_dump 0 Bytes liefert (leerer Dump)', async () => {
    const { writable } = sammleZip()
    await expect(
      baueBackupZip({
        out: writable,
        pgDump: fakePgDump(Buffer.alloc(0), 0),
        forceAt: '2026-10-22T14:07:00.000Z',
        dbCounts: { buchungen: 3 },
        tool: 'test',
      }),
    ).rejects.toThrow(/0 Bytes/)
  })
})

describe('restoreAusZip', () => {
  beforeEach(() => {
    mocks.pgRestore.code = 0
    mocks.pgRestore.stderr = ''
    mocks.pgRestore.calls = []
  })

  it('lehnt ein Backup ohne dump.pgdump ab', async () => {
    const zip = await baueZip({ 'manifest.json': MANIFEST })
    await expect(restoreAusZip(zip, 'postgres://x/y')).rejects.toThrow(
      /dump\.pgdump fehlt im Backup/,
    )
  })

  it('lehnt einen leeren Dump ab (0 Bytes)', async () => {
    const zip = await baueZip({
      'manifest.json': MANIFEST,
      'dump.pgdump': Buffer.alloc(0),
    })
    await expect(restoreAusZip(zip, 'postgres://x/y')).rejects.toThrow(/leer \(0 Bytes\)/)
    // pg_restore darf bei einem leeren Dump nie laufen.
    expect(mocks.pgRestore.calls).toHaveLength(0)
  })

  it('lehnt einen Dump ohne PGDMP-Header ab', async () => {
    const zip = await baueZip({
      'manifest.json': MANIFEST,
      'dump.pgdump': Buffer.from('kein pgdump'),
    })
    await expect(restoreAusZip(zip, 'postgres://x/y')).rejects.toThrow(/PGDMP-Header/)
    expect(mocks.pgRestore.calls).toHaveLength(0)
  })

  it('lehnt ein Backup ohne manifest.json ab', async () => {
    const zip = await baueZip({ 'dump.pgdump': Buffer.from('PGDMP-test') })
    await expect(restoreAusZip(zip, 'postgres://x/y')).rejects.toThrow(/manifest\.json fehlt/)
  })

  it('lehnt ein unbekanntes Backup-Schema ab', async () => {
    const zip = await baueZip({
      'manifest.json': JSON.stringify({ schema: 'castel-backup-99' }),
      'dump.pgdump': Buffer.from('PGDMP-test'),
    })
    await expect(restoreAusZip(zip, 'postgres://x/y')).rejects.toThrow(
      /Unbekanntes Backup-Schema/,
    )
  })

  it('meldet einen fehlgeschlagenen pg_restore als Fehler (Exit 1)', async () => {
    mocks.pgRestore.code = 1
    mocks.pgRestore.stderr = 'pg_restore: error: input file is too short (read 0, expected 5)'
    const zip = await baueZip({
      'manifest.json': MANIFEST,
      'dump.pgdump': Buffer.from('PGDMP-testdump'),
    })
    await expect(restoreAusZip(zip, 'postgres://x/y')).rejects.toThrow(
      /pg_restore fehlgeschlagen \(exit 1\)/,
    )
    await expect(restoreAusZip(zip, 'postgres://x/y')).rejects.toThrow(/input file is too short/)
  })

  it('meldet einen erfolgreichen Restore mit Dump-Groesse', async () => {
    const zip = await baueZip({
      'manifest.json': MANIFEST,
      'dump.pgdump': Buffer.from('PGDMP-testdump'),
    })
    const result = await restoreAusZip(zip, 'postgres://x/y')
    expect(result.dumpBytes).toBe(Buffer.byteLength('PGDMP-testdump'))
    expect(mocks.pgRestore.calls).toHaveLength(1)
  })
})

describe('Backup-Liste', () => {
  it('erkennt ZIPs mit leerem Dump (dumpOk: false)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'castel-testlist-'))
    try {
      const kaputt = await baueZip({
        'manifest.json': MANIFEST,
        'dump.pgdump': Buffer.alloc(0),
      })
      const ok = await baueZip({
        'manifest.json': MANIFEST,
        'dump.pgdump': Buffer.from('PGDMP-testdump'),
      })
      // Dateinamen muessen dem Muster castel-backup-*.zip entsprechen.
      const { rename } = await import('node:fs/promises')
      await rename(kaputt, join(dir, 'castel-backup-2026-10-22T14-07-04-258Z.zip'))
      await rename(ok, join(dir, 'castel-backup-2026-10-22T15-07-04-258Z.zip'))

      const files = await listeBackups(dir, { inspect: true })
      expect(files).toHaveLength(2)
      const mitLeeremDump = files.find((f) => f.name.includes('14-07-04'))
      const mitDump = files.find((f) => f.name.includes('15-07-04'))
      expect(mitLeeremDump?.dumpOk).toBe(false)
      expect(mitLeeremDump?.dumpBytes).toBe(0)
      expect(mitDump?.dumpOk).toBe(true)
      expect(mitDump?.dumpBytes).toBe(Buffer.byteLength('PGDMP-testdump'))
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('liefert die Dump-Groesse eines ZIPs', async () => {
    const zip = await baueZip({
      'manifest.json': MANIFEST,
      'dump.pgdump': Buffer.from('PGDMP-testdump'),
    })
    expect(await dumpGroesseImZip(zip)).toBe(Buffer.byteLength('PGDMP-testdump'))
  })
})
