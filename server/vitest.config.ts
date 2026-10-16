import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/*.test.ts'],
  },
})