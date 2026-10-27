// Server-Bootstrap: Fastify mit allen Plugins und Routes.

import Fastify from 'fastify'
import fastifyCors from '@fastify/cors'
import fastifyHelmet from '@fastify/helmet'
import fastifyCookie from '@fastify/cookie'
import fastifyMultipart from '@fastify/multipart'
import fastifySwagger from '@fastify/swagger'
import fastifySwaggerUi from '@fastify/swagger-ui'
import { config } from './config/config.js'
import { registerJwt } from './auth/jwt.js'
import { registerAuthDecorators } from './auth/middleware.js'
import { registerRateLimit } from './auth/rate-limit.js'
import { authRoutes } from './auth/routes.js'
import { setupRoutes } from './auth/setup-routes.js'
import { apiKeyRoutes } from './auth/api-key-routes.js'
import { registerApiAuthDecorators } from './auth/api-key-auth.js'
import { apiV1Routes } from './api/v1/routes.js'
import { buildOpenApiSpec } from './api/docs.js'
import { mcpRoutes } from './mcp/routes.js'
import { syncRoutes } from './sync/routes.js'
import { fotoRoutes, fotoStaticRoutes } from './fotos/routes.js'
import { userRoutes } from './users/routes.js'
import { adminRoutes } from './admin/routes.js'
import { backupRoutes } from './admin/backup-routes.js'
import { starteBackupCron, stoppeBackupCron } from './admin/backup-cron.js'
import { pgDumpMajor, serverVersionMajor } from './admin/backup.js'

import { datanormRoutes } from './datanorm/routes.js'
import { pruefeDatanormAblage } from './datanorm/import-service.js'
import { starteDatanormCron, stoppeDatanormCron } from './datanorm/cleanup-cron.js'
import { closeDb } from './db/client.js'
import { buildNotificationGateway } from './services/notification-gateway.js'

async function main() {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      transport:
        process.env['NODE_ENV'] === 'production'
          ? undefined
          : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
    },
    bodyLimit: 4 * 1024 * 1024, // 4 MB für Push-Payloads
  })

  // Plugins
  await app.register(fastifyHelmet, { contentSecurityPolicy: false })
  await app.register(fastifyCors, {
    origin: config.CORS_ORIGIN,
    credentials: true,
  })
  await app.register(fastifyCookie)
  await registerRateLimit(app)
  await registerJwt(app)
  registerAuthDecorators(app)
  registerApiAuthDecorators(app)

  // OpenAPI/Swagger-UI (public, keine Daten).
  if (config.API_DOCS_ENABLED) {
    await app.register(fastifySwagger, {
      mode: 'static',
      specification: { document: buildOpenApiSpec() as never },
    })
    await app.register(fastifySwaggerUi, {
      routePrefix: '/api/docs',
      uiConfig: { docExpansion: 'list', deepLinking: true },
    })
  }

  // Health-Endpoint (zuerst, kein Auth)
  app.get('/api/healthz', async () => ({
    status: 'ok',
    service: 'castel-server',
    time: new Date().toISOString(),
  }))

  // Login-Rate-Limit (nur für Login-Route)
  await app.register(async (instance) => {
    await authRoutes(instance)
  })

  // Setup-Endpoints (kein Auth, kein Rate-Limit — das hier ist die einmalige
  // Erstanmeldung, die muss zuverlässig funktionieren).
  await app.register(async (instance) => {
    await setupRoutes(instance)
  })

  // Restliche Routes (mit requireAuth als preHandler)
  const notificationGateway = buildNotificationGateway({
    mailEnabled: config.MAIL_ENABLED,
    smtp: {
      host: config.MAIL_SMTP_HOST,
      port: config.MAIL_SMTP_PORT,
      user: config.MAIL_SMTP_USER,
      pass: config.MAIL_SMTP_PASS,
      from: config.MAIL_FROM,
      dailyDigestHour: config.MAIL_DAILY_DIGEST_HOUR,
    },
    logger: app.log,
  })
  app.log.info(
    { gateway: notificationGateway.name, mailEnabled: config.MAIL_ENABLED },
    'Notification-Gateway initialisiert',
  )

  // Agenten-API (API-Key, eigene Scopes) und MCP (Streamable HTTP).
  // Bewusst VOR den JWT-Bloecken: diese Routen bringen ihre Auth selbst mit.
  await apiV1Routes(app, notificationGateway)
  await mcpRoutes(app, notificationGateway)

  // /fotos/* statische Auslieferung — OHNE Auth. <img src> schickt
  // keinen Authorization-Header, also muss der Handler vor dem
  // requireAuth-Hook registriert sein, sonst gibt's 401 auf jedem
  // Bild-Request.
  await fotoStaticRoutes(app)

  await app.register(async (instance) => {
    instance.addHook('preHandler', instance.requireAuth)
    await syncRoutes(instance, notificationGateway)
    await apiKeyRoutes(instance)
    await userRoutes(instance)
    await fotoRoutes(instance)
    await adminRoutes(instance)
    await backupRoutes(instance)
  })

  // DATANORM-Routes mit eigenem Multipart-Limit (64 MB für Katalog-Uploads,
  // getrennt von den 512 kB der Foto-Uploads in fotoRoutes).
  await app.register(async (instance) => {
    instance.addHook('preHandler', instance.requireAuth)
    await instance.register(fastifyMultipart, {
      limits: {
        fileSize: config.DATANORM_MAX_FILE_BYTES,
        files: 1,
        fields: 10,
      },
    })
    await datanormRoutes(instance)
  })

  // Globaler Error-Handler: einheitliches Format
  app.setErrorHandler((err: unknown, _req, reply) => {
    const e = err as { code?: string; message?: string; statusCode?: number }
    app.log.error(e)
    const code = e.code ?? 'INTERNAL'
    if (
      code === 'FST_JWT_AUTHORIZATION_TOKEN_EXPIRED' ||
      code === 'FST_JWT_NO_AUTHORIZATION_IN_HEADER'
    ) {
      return reply.code(401).send({ code: 'UNAUTHORIZED', message: e.message ?? 'Unauthorized' })
    }
    if (code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.code(413).send({ code: 'PAYLOAD_TOO_LARGE', message: 'Datei zu groß' })
    }
    return reply.code(e.statusCode ?? 500).send({
      code,
      message: e.message ?? 'Interner Server-Fehler',
    })
  })

  // Cleanup
  const shutdown = async (signal: string) => {
    app.log.info(`Signal ${signal} empfangen, fahre herunter …`)
    stoppeBackupCron()
    stoppeDatanormCron()
    await app.close()
    await closeDb()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  try {
    await app.listen({ port: config.PORT, host: config.HOST })
    app.log.info(`castel-server listening on ${config.HOST}:${config.PORT}`)
    // Backup-Voraussetzungen pruefen: ohne pg_dump (postgresql-client)
    // kann kein Backup erstellt werden. Das melden wir sofort beim
    // Start, statt erst wenn der Admin auf "Backup" klickt.
    const clientMajor = pgDumpMajor()
    const serverMajor = await serverVersionMajor()
    if (clientMajor === null) {
      app.log.error(
        'pg_dump nicht gefunden — Backups sind NICHT moeglich! ' +
          "Es fehlt das Paket 'postgresql-client' im Image (siehe server/Dockerfile).",
      )
    } else if (serverMajor !== null && clientMajor < serverMajor) {
      app.log.error(
        `pg_dump ${clientMajor} kann Postgres ${serverMajor} nicht dumpen — ` +
          'jedes Backup waere leer und unbrauchbar! Die Client-Version im Image ' +
          'muss zur Server-Version passen (ARG PG_MAJOR in server/Dockerfile).',
      )
    } else {
      app.log.info(
        { pgDumpMajor: clientMajor, serverMajor },
        'pg_dump gefunden — Backups sind moeglich',
      )
    }
    starteBackupCron(app.log)
    starteDatanormCron(app.log)
    await pruefeDatanormAblage(app.log)
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

main()