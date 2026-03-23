/**
 * Vitest config for live integration tests.
 *
 * Usage: npx vitest run --config vitest.live.config.ts
 * Or:    npx vitest run --config vitest.live.config.ts tests/live/httpbin.test.ts
 *
 * These tests hit real HTTP endpoints — do NOT run in CI.
 */
import { defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/live/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
  resolve: {
    alias: {
      '@schrute': path.resolve(__dirname, 'src'),
    },
  },
});
