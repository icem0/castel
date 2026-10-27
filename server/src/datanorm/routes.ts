// DATANORM HTTP routes.
//
// Split by audience:
//   * admin-only  — upload, supplier administration, import history
//   * any signed-in user — catalogue lookup (everybody who maintains an
//     article needs to pull fields from a supplier catalogue)
//
// The lookup endpoint is the one the PWA drawer talks to. It is read-only
// and deliberately NOT part of the sync snapshot: supplier catalogues are
// large (tens of thousands of rows per supplier) and mostly consulted while
// creating a single article, so on-demand fetch beats mirroring everything.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { Readable } from 'node:stream'
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import {
  datanormDateien,
  datanormImporte,
  herstellerArtikel,
  lieferanten,
} from '../db/schema.js'
import { DatanormFehler, importiereDatanorm } from './import-service.js'
import { istFertig, kanalFuer, letzterFortschritt, meldeFortschritt } from './progress.js'
import { raeumeAlteDateien } from './cleanup.js'
import type { DatanormEncoding, DatanormFormat } from './types.js'

const MAX_PAGE = 100
const DEFAULT_PAGE = 20

/** Trimmed, length-capped free-text search term. */
function suchbegriff(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.trim().slice(0, 80)
}

function positiveInt(raw: unknown, fallback: number, max: number): number {
  const n = Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(n) || n < 1) return fallback
  return Math.min(n, max)
}

function istGueltigesEncoding(raw: unknown): DatanormEncoding | undefined {
  return raw === 'utf-8' || raw === 'cp850' || raw === 'windows-1252'
    ? (raw as DatanormEncoding)
    : undefined
}

/** Format override: 'auto' (default), 'v4' or 'v5'. */
function istGueltigesFormat(raw: unknown): DatanormFormat {
  return raw === 'v4' || raw === 'v5' ? raw : 'auto'
}

export async function datanormRoutes(app: FastifyInstance): Promise<void> {
  // ---------- GET /api/lieferanten ----------
  // Supplier list for the picker's first step. Returns active suppliers by
  // default; admins can include inactive ones (they may need to re-upload a
  // catalogue for a supplier nobody confirmed yet).
  app.get('/api/lieferanten', { preHandler: app.requireAuth }, async (req, reply) => {
    const db = getDb()
    const alle = (req.query as { alle?: string }).alle === 'true'
    const nurAktive = (req.query as { aktiv?: string }).aktiv !== 'false'
    const istAdmin = req.authUser?.rolle === 'admin'
    // Only admins ever see inactive suppliers.
    const filterAktiv = alle && istAdmin ? undefined : nurAktive ? eq(lieferanten.aktiv, true) : undefined

    const rows = await db
      .select({
        id: lieferanten.id,
        name: lieferanten.name,
        matchcode: lieferanten.matchcode,
        aktiv: lieferanten.aktiv,
        ort: lieferanten.ort,
        format: lieferanten.format,
        geaendertAm: lieferanten.geaendertAm,
      })
      .from(lieferanten)
      .where(filterAktiv)
      .orderBy(lieferanten.name)

    return reply.send(rows)
  })

  // ---------- POST /api/lieferanten ----------
  // Manual creation. The import screen needs a supplier before the first
  // file exists — the DATANORM header carries the name, but the admin should
  // be able to set it deliberately (and correct a typo afterwards).
  app.post<{ Body: { name?: string; matchcode?: string; ort?: string; strasse?: string; plz?: string; email?: string; telefon?: string; aktiv?: boolean } }>(
    '/api/lieferanten',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      const name = (req.body?.name ?? '').trim()
      if (name === '' || name.length > 120) {
        return reply
          .code(400)
          .send({ code: 'VALIDATION', message: 'Name ist erforderlich (max. 120 Zeichen)' })
      }
      const matchcode = (req.body?.matchcode ?? '').trim().toUpperCase() || null
      const db = getDb()

      if (matchcode) {
        const vorhanden = await db
          .select({ id: lieferanten.id, name: lieferanten.name })
          .from(lieferanten)
          .where(eq(sql`LOWER(${lieferanten.matchcode})`, matchcode.toLowerCase()))
          .limit(1)
        if (vorhanden.length > 0) {
          return reply.code(409).send({
            code: 'LIEFERANT_DOPPELT',
            message: `Matchcode "${matchcode}" ist bereits vergeben (${vorhanden[0]!.name}).`,
          })
        }
      }

      const id = crypto.randomUUID()
      await db.insert(lieferanten).values({
        id,
        name,
        matchcode,
        strasse: req.body?.strasse?.trim() || null,
        plz: req.body?.plz?.trim() || null,
        ort: req.body?.ort?.trim() || null,
        email: req.body?.email?.trim() || null,
        telefon: req.body?.telefon?.trim() || null,
        // New suppliers are usable right away: the admin created them on
        // purpose. DATANORM-discovered ones start inactive (see import).
        aktiv: req.body?.aktiv ?? true,
      })
      return reply.code(201).send({ id, name, matchcode })
    },
  )

  // ---------- PATCH /api/lieferanten/:id ----------
  app.patch<{
    Params: { id: string }
    Body: { name?: string; aktiv?: boolean; matchcode?: string; ort?: string; format?: string }
  }>('/api/lieferanten/:id', { preHandler: app.requireAdmin }, async (req, reply) => {
    const db = getDb()
    const sets: Record<string, unknown> = { geaendertAm: new Date() }
    if (typeof req.body?.name === 'string' && req.body.name.trim() !== '') {
      sets['name'] = req.body.name.trim()
    }
    if (typeof req.body?.aktiv === 'boolean') sets['aktiv'] = req.body.aktiv
    if (typeof req.body?.matchcode === 'string') {
      sets['matchcode'] = req.body.matchcode.trim().toUpperCase() || null
    }
    if (typeof req.body?.ort === 'string') sets['ort'] = req.body.ort.trim() || null
    if (req.body?.format === 'auto' || req.body?.format === 'v4' || req.body?.format === 'v5') {
      sets['format'] = req.body.format
    }

    const rows = await db
      .update(lieferanten)
      .set(sets)
      .where(eq(lieferanten.id, req.params.id))
      .returning({ id: lieferanten.id })
    if (rows.length === 0) {
      return reply.code(404).send({ code: 'NOT_FOUND', message: 'Lieferant unbekannt' })
    }
    return reply.send({ ok: true })
  })

  // ---------- GET /api/datanorm/artikel ----------
  // Catalogue lookup for the PWA drawer.
  //
  // `lieferantId` is REQUIRED: the picker is two-step on purpose (choose
  // supplier, then search inside it). Searching across all suppliers at once
  // produces confusing hits — the same EAN can legitimately exist in several
  // supplier catalogues with different prices.
  //
  // EAN-first: a bare 8/12/13/14-digit number is matched against the EAN
  // column (with the matchcode as a fallback, since some suppliers key their
  // articles by EAN). Anything else is a substring search over matchcode and
  // title.
  app.get('/api/datanorm/artikel', { preHandler: app.requireAuth }, async (req, reply) => {
    const q = req.query as {
      lieferantId?: string
      q?: string
      ean?: string
      matchcode?: string
      limit?: string
      page?: string
      inklDeaktivierte?: string
    }
    const lieferantId = (q.lieferantId ?? '').trim()
    if (lieferantId === '') {
      return reply.code(400).send({
        code: 'VALIDATION',
        message: 'lieferantId ist erforderlich — bitte zuerst den Lieferanten wählen',
      })
    }

    const begriff = suchbegriff(q.q)
    const ean = suchbegriff(q.ean)
    const matchcode = suchbegriff(q.matchcode)
    const limit = positiveInt(q.limit, DEFAULT_PAGE, MAX_PAGE)
    const page = positiveInt(q.page, 1, 10000)
    const mitDeaktivierten = q.inklDeaktivierte === 'true'

    const bedingungen = [eq(herstellerArtikel.lieferantId, lieferantId)]
    if (!mitDeaktivierten) bedingungen.push(eq(herstellerArtikel.deaktiviert, false))

    let suchstrategie: 'ean' | 'matchcode' | 'titel' | 'alle' = 'alle'
    const digits = /^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$/

    if (ean !== '') {
      suchstrategie = 'ean'
      bedingungen.push(or(eq(herstellerArtikel.ean, ean), eq(herstellerArtikel.matchcode, ean))!)
    } else if (matchcode !== '') {
      suchstrategie = 'matchcode'
      bedingungen.push(or(eq(herstellerArtikel.matchcode, matchcode), ilike(herstellerArtikel.matchcode, `%${matchcode}%`))!)
    } else if (begriff !== '') {
      if (digits.test(begriff)) {
        // EAN-typed search term: match EAN first, then matchcode, then title
        // so a mis-typed digit still finds something.
        suchstrategie = 'ean'
        bedingungen.push(
          or(
            eq(herstellerArtikel.ean, begriff),
            eq(herstellerArtikel.matchcode, begriff),
            ilike(herstellerArtikel.titel, `%${begriff}%`),
          )!,
        )
      } else {
        suchstrategie = 'titel'
        bedingungen.push(
          or(
            ilike(herstellerArtikel.matchcode, `%${begriff}%`),
            ilike(herstellerArtikel.titel, `%${begriff}%`),
            ilike(herstellerArtikel.beschreibung, `%${begriff}%`),
          )!,
        )
      }
    }

    const where = and(...bedingungen)
    const db = getDb()

    const treffer = await db
      .select({
        id: herstellerArtikel.id,
        matchcode: herstellerArtikel.matchcode,
        matchcode2: herstellerArtikel.matchcode2,
        ean: herstellerArtikel.ean,
        titel: herstellerArtikel.titel,
        beschreibung: herstellerArtikel.beschreibung,
        mengeneinheit: herstellerArtikel.mengeneinheit,
        preiseinheit: herstellerArtikel.preiseinheit,
        inhalt: herstellerArtikel.inhalt,
        warengruppe: herstellerArtikel.warengruppe,
        preisNettoCent: herstellerArtikel.preisNettoCent,
        preisBruttoCent: herstellerArtikel.preisBruttoCent,
        gueltigAb: herstellerArtikel.gueltigAb,
        ersatzMatchcode: herstellerArtikel.ersatzMatchcode,
        deaktiviert: herstellerArtikel.deaktiviert,
        deaktiviertAm: herstellerArtikel.deaktiviertAm,
        geaendertAm: herstellerArtikel.geaendertAm,
      })
      .from(herstellerArtikel)
      .where(where)
      .orderBy(herstellerArtikel.titel)
      .limit(limit)
      .offset((page - 1) * limit)

    const countRows = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(herstellerArtikel)
      .where(where)

    const total = countRows[0]?.c ?? 0
    const lieferant = await db
      .select({ id: lieferanten.id, name: lieferanten.name })
      .from(lieferanten)
      .where(eq(lieferanten.id, lieferantId))
      .limit(1)

    return reply.send({
      lieferant: lieferant[0] ?? null,
      suchstrategie,
      treffer,
      page,
      pageSize: limit,
      total,
      hasMore: page * limit < total,
    })
  })

  // ---------- GET /api/datanorm/artikel/:id ----------
  app.get<{ Params: { id: string } }>(
    '/api/datanorm/artikel/:id',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const db = getDb()
      const rows = await db
        .select()
        .from(herstellerArtikel)
        .where(eq(herstellerArtikel.id, req.params.id))
        .limit(1)
      if (rows.length === 0) {
        return reply.code(404).send({ code: 'NOT_FOUND', message: 'Katalogeintrag unbekannt' })
      }
      const l = await db
        .select({ id: lieferanten.id, name: lieferanten.name, matchcode: lieferanten.matchcode })
        .from(lieferanten)
        .where(eq(lieferanten.id, rows[0]!.lieferantId))
        .limit(1)
      return reply.send({ ...rows[0], lieferant: l[0] ?? null })
    },
  )

  // ---------- POST /api/datanorm/upload ----------
  // Multipart: `datei` (binary) + `lieferantId` (field). Optional
  // `encoding` override for files the detector was unsure about.
  //
  // The import runs inline (not queued) so the admin gets a real result
  // instead of a job handle. Progress is available via the SSE endpoint.
  //
  // Multipart ordering matters: Busboy will not advance to the next part
  // until the current file stream is drained. We therefore read each part
  // to completion inside the loop. That means the file is buffered here —
  // acceptable because importiereDatanorm() itself streams the bytes from
  // this buffer (hash + disk write + parse) without a second copy, and the
  // hard DATANORM_MAX_FILE_BYTES cap bounds the memory.
  app.post(
    '/api/datanorm/upload',
    { preHandler: app.requireAdmin },
    async (req: FastifyRequest, reply: FastifyReply) => {
      let lieferantId = ''
      let encodingRaw = ''
      let formatRaw = ''
      let dateiname = ''
      let dateiBytes: Buffer | null = null

      try {
        const daten = req.parts()
        for await (const part of daten) {
          if (part.type === 'file') {
            dateiname = part.filename ?? 'datanorm'
            const stueck: Buffer[] = []
            for await (const chunk of part.file) {
              stueck.push(chunk as Buffer)
            }
            dateiBytes = Buffer.concat(stueck)
          } else if (part.fieldname === 'lieferantId') {
            lieferantId = String(part.value ?? '').trim()
          } else if (part.fieldname === 'encoding') {
            encodingRaw = String(part.value ?? '').trim()
          } else if (part.fieldname === 'format') {
            formatRaw = String(part.value ?? '').trim()
          }
        }

        if (dateiBytes === null) {
          return reply.code(400).send({ code: 'NO_FILE', message: 'keine Datei hochgeladen' })
        }
        if (lieferantId === '') {
          return reply.code(400).send({ code: 'VALIDATION', message: 'lieferantId fehlt' })
        }

        const ergebnis = await importiereDatanorm({
          lieferantId,
          originalDateiname: dateiname,
          stream: Readable.from(dateiBytes),
          benutzerId: req.authUser?.sub ?? null,
          encoding: istGueltigesEncoding(encodingRaw),
          format: istGueltigesFormat(formatRaw),
          log: req.log,
          onFortschritt: meldeFortschritt,
        })
        return reply.send(ergebnis)
      } catch (err) {
        if (err instanceof DatanormFehler) {
          const statusCode =
            err.code === 'DATANORM_ZU_GROSS'
              ? 413
              : err.code === 'DATANORM_LIEFERANT_UNBEKANNT'
                ? 404
                : err.code === 'DATANORM_KEINE_ARTIKEL' ||
                    err.code === 'DATANORM_VERSION_UNBEKANNT'
                  ? 422
                  : 400
          return reply.code(statusCode).send({ code: err.code, message: err.message })
        }
        const meldung = err instanceof Error ? err.message : String(err)
        req.log.error({ err, meldung }, '[datanorm] Upload fehlgeschlagen')
        return reply.code(500).send({ code: 'INTERNAL', message: 'Import fehlgeschlagen' })
      }
    },
  )

  // ---------- GET /api/datanorm/import/:id/progress ----------
  // Server-sent events. Sends the last known tick immediately (so a late or
  // reconnecting subscriber is not blank), then streams until the import
  // finishes.
  app.get<{ Params: { id: string } }>(
    '/api/datanorm/import/:id/progress',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      const importId = req.params.id
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // nginx buffers proxied responses by default, which would defeat
        // streaming entirely.
        'X-Accel-Buffering': 'no',
      })

      const schreibe = (event: string, data: unknown) => {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      }

      const letzte = letzterFortschritt(importId)
      if (letzte) schreibe('fortschritt', letzte)

      if (istFertig(importId)) {
        schreibe('abschluss', { status: 'fertig' })
        reply.raw.end()
        return reply
      }

      const kanal = kanalFuer(importId)
      const onFortschritt = (f: unknown) => schreibe('fortschritt', f)
      const onAbschluss = (d: unknown) => {
        schreibe('abschluss', d)
        aufraeumen()
        reply.raw.end()
      }
      const aufraeumen = () => {
        kanal.off('fortschritt', onFortschritt)
        kanal.off('abschluss', onAbschluss)
      }

      kanal.on('fortschritt', onFortschritt)
      kanal.on('abschluss', onAbschluss)

      // Comment frames keep proxies from closing an idle connection.
      const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15000)
      heartbeat.unref?.()

      req.raw.on('close', () => {
        clearInterval(heartbeat)
        aufraeumen()
      })

      return reply
    },
  )

  // ---------- GET /api/datanorm/importe ----------
  app.get('/api/datanorm/importe', { preHandler: app.requireAdmin }, async (req, reply) => {
    const db = getDb()
    const q = req.query as { lieferantId?: string; limit?: string; page?: string }
    const limit = positiveInt(q.limit, DEFAULT_PAGE, MAX_PAGE)
    const page = positiveInt(q.page, 1, 10000)

    const where =
      q.lieferantId !== undefined && q.lieferantId !== ''
        ? eq(datanormImporte.lieferantId, q.lieferantId)
        : undefined

    const rows = await db
      .select({
        id: datanormImporte.id,
        lieferantId: datanormImporte.lieferantId,
        originalDateiname: datanormImporte.originalDateiname,
        status: datanormImporte.status,
        encoding: datanormImporte.encoding,
        versionErkannt: datanormImporte.versionErkannt,
        artikelAnzahl: datanormImporte.artikelAnzahl,
        artikelNeu: datanormImporte.artikelNeu,
        artikelAktualisiert: datanormImporte.artikelAktualisiert,
        artikelDeaktiviert: datanormImporte.artikelDeaktiviert,
        fehlerAnzahl: datanormImporte.fehlerAnzahl,
        gestartetAm: datanormImporte.gestartetAm,
        beendetAm: datanormImporte.beendetAm,
        benutzerId: datanormImporte.benutzerId,
      })
      .from(datanormImporte)
      .where(where)
      .orderBy(desc(datanormImporte.gestartetAm))
      .limit(limit)
      .offset((page - 1) * limit)

    const countRows = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(datanormImporte)
      .where(where)

    return reply.send({
      treffer: rows,
      total: countRows[0]?.c ?? 0,
      page,
      pageSize: limit,
    })
  })

  // ---------- GET /api/datanorm/importe/:id ----------
  app.get<{ Params: { id: string } }>(
    '/api/datanorm/importe/:id',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      const db = getDb()
      const rows = await db
        .select()
        .from(datanormImporte)
        .where(eq(datanormImporte.id, req.params.id))
        .limit(1)
      if (rows.length === 0) {
        return reply.code(404).send({ code: 'NOT_FOUND', message: 'Import unbekannt' })
      }
      const datei = rows[0]!.dateiId
        ? await db
            .select({
              pfad: datanormDateien.pfad,
              originalName: datanormDateien.originalName,
              byteGroesse: datanormDateien.byteGroesse,
            })
            .from(datanormDateien)
            .where(eq(datanormDateien.id, rows[0]!.dateiId!))
            .limit(1)
        : []
      return reply.send({ ...rows[0], datei: datei[0] ?? null })
    },
  )

  // ---------- POST /api/datanorm/cleanup ----------
  // Manual retention run. The nightly cron (see cleanup-cron.ts) does this
  // automatically; the endpoint exists so an admin can reclaim space now.
  app.post('/api/datanorm/cleanup', { preHandler: app.requireAdmin }, async (req, reply) => {
    const ergebnis = await raeumeAlteDateien(req.log)
    return reply.send(ergebnis)
  })
}