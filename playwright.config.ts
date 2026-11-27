// Playwright config for the end-to-end suite (PLAN.md step 23).
//
// Starts the real stack, without Docker:
//   * API   — server/ via tsx against a dedicated Postgres database whose name
//             must end in "_e2e" (it is wiped on every run, see
//             server/scripts/e2e-reset-db.mjs)
//   * PWA   — the production build served by `vite preview`, with /api proxied
//             to the API (same origin, like nginx in production)
//
// Local run (Postgres 16 on localhost with a castel_e2e database):
//   npm run test:e2e
// Override the database with E2E_DATABASE_URL, skip the PWA rebuild with
// E2E_SKIP_BUILD=1 when dist/ is current.

import { defineConfig, devices } from '@playwright/test'

const API_PORT = Number(process.env.E2E_API_PORT ?? 3100)
const PWA_PORT = Number(process.env.E2E_PWA_PORT ?? 4173)
const PWA_URL = `http://127.0.0.1:${PWA_PORT}`
const API_URL = `http://127.0.0.1:${API_PORT}`
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? 'postgres://castel:castel@127.0.0.1:5432/castel_e2e'
const E2E_TMP = process.env.E2E_TMP_DIR ?? '/tmp/castel-e2e'

const buildStep = process.env.E2E_SKIP_BUILD === '1' ? '' : 'npm run build && '

export default defineConfig({
  testDir: './e2e',
  // The specs share one server and one database and change shared articles;
  // they run one after another.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  // No retries: the specs mutate shared stock, a retry would start from a
  // different baseline and fail for the wrong reason.
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: PWA_URL,
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
    trace: process.env.CI ? 'retain-on-failure' : 'off',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'seed', testMatch: /seed\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['seed'],
    },
  ],
  webServer: [
    {
      name: 'api',
      cwd: './server',
      command:
        'node scripts/e2e-reset-db.mjs && node --import tsx src/db/migrate.ts && node --import tsx src/index.ts',
      url: `${API_URL}/api/healthz`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        DATABASE_URL,
        // Test-only secret, never used outside this throwaway database.
        JWT_SECRET: 'e2e-only-jwt-secret-not-for-production-use',
        PORT: String(API_PORT),
        HOST: '127.0.0.1',
        LOG_LEVEL: 'warn',
        CORS_ORIGIN: PWA_URL,
        COOKIE_DOMAIN: '127.0.0.1',
        // Every spec logs in two browser contexts; the production limit of
        // 5 logins per minute would throttle the suite.
        RATE_LIMIT_LOGIN_MAX: '1000',
        FOTOS_DIR: `${E2E_TMP}/fotos`,
        BACKUP_DIR: `${E2E_TMP}/backups`,
        DATANORM_DIR: `${E2E_TMP}/datanorm`,
        MCP_ENABLED: 'false',
      },
    },
    {
      name: 'pwa',
      command: `${buildStep}npx vite preview --host 127.0.0.1 --port ${PWA_PORT} --strictPort`,
      url: PWA_URL,
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: 'ignore',
      env: { CASTEL_API_PROXY: API_URL },
    },
  ],
})
