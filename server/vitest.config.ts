import { defineConfig } from 'vitest/config'

// Integration suites (CASTEL_TEST_DB=1) share one Postgres database and some
// of them wipe whole tables (e.g. lieferanten) in their setup. Running those
// files in parallel makes them race, so files run sequentially in that mode.
const mitDb = process.env['CASTEL_TEST_DB'] === '1'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/*.test.ts'],
    fileParallelism: !mitDb,
  },
})
