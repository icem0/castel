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
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
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

/**
 * FOTOS_DIR/DATANORM_DIR auf Temp-Verzeichnisse umbiegen — der Restore
 * ersetzt deren Inhalt, das darf nicht im echten Pfad passieren. Die Config
 * wird beim Import gelesen, also MUSS das vor dem Import von backup.js
 * geschehen.
 */
const tempRoot = await mkdtemp(join(tmpdir(), 'castel-backup-cfg-'))
const fotosDir = join(tempRoot, 'fotos')
const datanormDir = join(tempRoot, 'datanorm')
await mkdir(fotosDir, { recursive: true })
await mkdir(datanormDir, { recursive: true })
process.env['FOTOS_DIR'] = fotosDir
process.env['DATANORM_DIR'] = datanormDir

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

  it('nimmt die DATANORM-Kataloge ins ZIP auf (datanorm/ + datanormCount im Manifest)', async () => {
    // Katalog im Ablageverzeichnis anlegen (Lieferanten-/Datumsunterordner).
    await mkdir(join(datanormDir, '2026-10-20', 'lieferant-x'), { recursive: true })
    await writeFile(join(datanormDir, '2026-10-20', 'lieferant-x', 'katalog.bin'), 'DATANORM')

    const payload = Buffer.from('PGDMP-dummy-dump')
    const { writable } = sammleZip()
    const result = await baueBackupZip({
      out: writable,
      pgDump: fakePgDump(payload, 0),
      forceAt: '2026-10-22T14:07:00.000Z',
      dbCounts: { buchungen: 3 },
      tool: 'test',
    })

    // Der Katalog muss im ZIP liegen — sonst zeigen die restaurierten
    // `datanorm_dateien`-Zeilen ins Leere.
    expect(result.manifest.datanormCount).toBe(1)

    // ... und wirklich im Archiv (nicht nur im Manifest).
    const zipPfad = await backupZipAufPlatte(fakePgDump(payload, 0))
    try {
      const listing = await zipListing(zipPfad)
      expect(listing).toContain('datanorm/')
      expect(listing).toContain('dump.pgdump')
      expect(listing).toContain('manifest.json')
    } finally {
      await rm(join(zipPfad, '..'), { recursive: true, force: true }).catch(() => {})
    }
  })
})

/** Baut ein echtes Backup-ZIP auf Platte und liefert den Pfad. */
async function backupZipAufPlatte(pgDump: PgDumpHandle): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'castel-backupzip-'))
  const zipPfad = join(dir, 'castel-backup-test.zip')
  const out = createWriteStream(zipPfad)
  await baueBackupZip({
    out,
    pgDump,
    forceAt: '2026-10-22T14:07:00.000Z',
    dbCounts: { buchungen: 0 },
    tool: 'test',
  })
  return zipPfad
}

/**
 * Inhalt des ZIPs als Text (`unzip -l`). BusyBox-unzip kennt kein `-Z1`,
 * darum wird die Listing-Ausgabe geparst statt die Eintragsnamen zu
 * extrahieren — die Assertionen prüfen auf Substrings.
 */
async function zipListing(pfad: string): Promise<string> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { stdout } = await promisify(execFile)('unzip', ['-l', pfad])
  return stdout
}

describe('restoreAusZip', () => {
  beforeEach(async () => {
    mocks.pgRestore.code = 0
    mocks.pgRestore.stderr = ''
    mocks.pgRestore.calls = []
    // Zielverzeichnisse leeren — der Restore ersetzt ihren Inhalt, und die
    // Tests teilen sich FOTOS_DIR/DATANORM_DIR.
    await rm(fotosDir, { recursive: true, force: true })
    await rm(datanormDir, { recursive: true, force: true })
    await mkdir(fotosDir, { recursive: true })
    await mkdir(datanormDir, { recursive: true })
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

  it('ERSETZT Fotos und DATANORM-Kataloge (kein Merge mit Altbestand)', async () => {
    // Altbestand, der nach dem Restore nicht mehr existieren darf.
    await mkdir(join(fotosDir, 'artikel-alt'), { recursive: true })
    await writeFile(join(fotosDir, 'artikel-alt', 'alt.jpg'), 'ALT')
    await mkdir(join(datanormDir, '2026-01-01', 'alt'), { recursive: true })
    await writeFile(join(datanormDir, '2026-01-01', 'alt', 'katalog.bin'), 'ALT')

    const zip = await baueZip({
      'manifest.json': MANIFEST,
      'dump.pgdump': Buffer.from('PGDMP-testdump'),
      'fotos/artikel-neu/bild.jpg': 'NEU',
      'datanorm/2026-10-20/neu/katalog.bin': 'NEU',
    })

    const result = await restoreAusZip(zip, 'postgres://x/y')

    // Zaehler: je eine Datei im Backup.
    expect(result.fotoDateien).toBe(1)
    expect(result.datanormDateien).toBe(1)

    // Backup-Stand ist da ...
    expect(await readdir(fotosDir)).toEqual(['artikel-neu'])
    expect(await readdir(datanormDir)).toEqual(['2026-10-20'])
    // ... der Altbestand ist weg (Ersetzen statt Mergen). Sonst passten die
    // Dateien nicht mehr zu den restaurierten Tabellenzeilen.
    expect(await readdir(join(fotosDir, 'artikel-neu'))).toEqual(['bild.jpg'])
  })

  it('laesst das Ziel unberuehrt, wenn das Backup kein fotos/-Verzeichnis enthaelt (alte Backups)', async () => {
    await mkdir(join(fotosDir, 'artikel-alt'), { recursive: true })
    await writeFile(join(fotosDir, 'artikel-alt', 'alt.jpg'), 'ALT')

    const zip = await baueZip({
      'manifest.json': MANIFEST,
      'dump.pgdump': Buffer.from('PGDMP-testdump'),
    })
    const result = await restoreAusZip(zip, 'postgres://x/y')

    expect(result.fotoDateien).toBe(0)
    expect(await readdir(fotosDir)).toEqual(['artikel-alt'])
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
