import { defineConfig } from 'vitest/config';

/**
 * Unit tests for the web app's pure logic (layout, status mapping, formatting, cache patching).
 * The Playwright suite in e2e/ runs separately (`pnpm -F @agent-graphs/web test:e2e`).
 */
export default defineConfig({
  test: {
    name: 'web',
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
  },
});
