import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: { alias: { '@core': path.resolve(import.meta.dirname, 'src/core') } },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
})
