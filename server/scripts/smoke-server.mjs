#!/usr/bin/env node
// End-to-End-Smoke: Postgres embedded starten, Migrationen, Bootstrap-Admin,
// Server hochfahren, Login testen.
//
// Aufruf:  node scripts/smoke-server.mjs
//
// Setzt voraus: tsc wurde bereits ausgeführt (dist/ existiert).

import { createRequire } from 'node:module'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
const require = createRequire(import.meta.url)
const { default: EmbeddedPostgres } = require('embedded-postgres')
import postgres from 'postgres'
import { spawn } from 'node:child_process'

const DATA_DIR = './var/pg-data'
const PORT = 5433
const USER = 'castel'
const PASSWORD = 'castel-dev'
const DB = 'castel'
const ADMIN_EMAIL = 'admin@example.com'
const ADMIN_PASSWORD = 'admin-dev-1234'

const envVars = {
  DATABASE_URL: `postgres://${USER}:${PASSWORD}@localhost:${PORT}/${DB}`,
  JWT_SECRET: 'dev-secret-please-replace-with-a-real-one-32chars',
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  PORT: '3001',
  HOST: '127.0.0.1',
  LOG_LEVEL: 'info',
  COOKIE_SECURE: 'false',
  COOKIE_DOMAIN: 'localhost',
  CORS_ORIGIN: 'http://localhost:5173',
  FOTOS_DIR: './var/fotos',
  NODE_ENV: 'development',
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function main() {
  // 1. Postgres starten
  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: USER,
    password: PASSWORD,
    port: PORT,
    persistent: true,
  })
  if (!existsSync(`${DATA_DIR}/PG_VERSION`)) {
    console.log('Initialisiere Postgres-Datenverzeichnis …')
    await pg.initialise()
  }
  console.log('Starte Postgres …')
  await pg.start()
  console.log('✓ Postgres läuft auf', PORT)

  // 2. Datenbank + Migrationen
  await pg.createDatabase(DB).catch(() => {})
  const sql = postgres({
    host: 'localhost',
    port: PORT,
    user: USER,
    password: PASSWORD,
    database: DB,
  })
  // Tabellen nur anlegen, wenn sie noch nicht existieren
  const migrationSqlRaw = readFileSync('src/db/migrations/0001_initial.sql', 'utf-8')
  const migrationSql = migrationSqlRaw
    .replace(/CREATE TABLE /g, 'CREATE TABLE IF NOT EXISTS ')
    .replace(/CREATE UNIQUE INDEX /g, 'CREATE UNIQUE INDEX IF NOT EXISTS ')
    .replace(/CREATE INDEX /g, 'CREATE INDEX IF NOT EXISTS ')
  await sql.unsafe(migrationSql)
  console.log('✓ Migrationen ausgeführt (idempotent)')
  await sql.end()

  // 3. Server starten
  console.log('Starte Server …')
  const serverProc = spawn(process.execPath, ['dist/index.js'], {
    env: { ...process.env, ...envVars },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let serverOutput = ''
  serverProc.stdout.on('data', (d) => {
    serverOutput += d.toString()
  })
  serverProc.stderr.on('data', (d) => {
    serverOutput += d.toString()
  })

  // Warten auf "listening"
  for (let i = 0; i < 30; i++) {
    if (serverOutput.includes('listening')) break
    await sleep(200)
  }
  if (!serverOutput.includes('listening')) {
    console.error('Server-Start fehlgeschlagen:')
    console.error(serverOutput)
    await pg.stop()
    process.exit(1)
  }
  console.log('✓ Server läuft auf Port 3001')

  // 4. Health-Endpoint testen
  try {
    const health = await fetch('http://localhost:3001/api/healthz')
    const healthJson = await health.json()
    if (health.status !== 200) throw new Error('healthz nicht 200')
    console.log('✓ /api/healthz:', JSON.stringify(healthJson))
  } catch (e) {
    console.error('✗ /api/healthz:', e.message)
    serverProc.kill()
    await pg.stop()
    process.exit(1)
  }

  // 5. Login mit Bootstrap-Admin testen
  try {
    const loginRes = await fetch('http://localhost:3001/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    })
    const loginJson = await loginRes.json()
    if (loginRes.status !== 200) {
      console.error('✗ Login fehlgeschlagen:', loginRes.status, JSON.stringify(loginJson))
      serverProc.kill()
      await pg.stop()
      process.exit(1)
    }
    console.log('✓ Login erfolgreich:', JSON.stringify({
      userId: loginJson.user?.id,
      rolle: loginJson.user?.rolle,
      mustChangePassword: loginJson.user?.mustChangePassword,
    }))
    console.log('  Token (Anfang):', loginJson.token?.slice(0, 32), '…')

    // 6. /api/auth/me mit Token testen
    const meRes = await fetch('http://localhost:3001/api/auth/me', {
      headers: { Authorization: `Bearer ${loginJson.token}` },
    })
    const meJson = await meRes.json()
    if (meRes.status !== 200) {
      console.error('✗ /me fehlgeschlagen:', meRes.status, JSON.stringify(meJson))
      serverProc.kill()
      await pg.stop()
      process.exit(1)
    }
    console.log('✓ /api/auth/me:', JSON.stringify(meJson))

    console.log('\n✅ Alle End-to-End-Tests bestanden.')
  } catch (e) {
    console.error('✗ Login-Test:', e.message)
    serverProc.kill()
    await pg.stop()
    process.exit(1)
  }

  // Cleanup
  serverProc.kill()
  await sleep(500)
  await pg.stop()
  console.log('✓ Cleanup')
}

main().catch(async (e) => {
  console.error(e)
  process.exit(1)
})