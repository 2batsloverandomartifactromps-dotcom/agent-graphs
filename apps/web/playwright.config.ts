/**
 * E2E: starts the API (`agraph serve`, temporary DATA_DIR) and the Vite dev server (proxying to
 * it), then drives the UI with the pre-installed Chromium. Never run `playwright install`.
 *   pnpm -F @agent-graphs/web test:e2e
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defineConfig } from '@playwright/test';

const API_PORT = Number(process.env.E2E_API_PORT ?? 4787);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5187);
const api = `http://127.0.0.1:${API_PORT}`;
const root = resolve(import.meta.dirname, '../..');
const dataDir = process.env.E2E_DATA_DIR ?? mkdtempSync(join(tmpdir(), 'agent-graphs-e2e-'));
process.env.E2E_API_URL = api;

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  outputDir: './test-results',
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    viewport: { width: 1440, height: 900 },
    launchOptions: { executablePath: process.env.E2E_CHROMIUM ?? '/opt/pw-browsers/chromium' },
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: `node packages/cli/bin/agraph.js serve --port ${API_PORT}`,
      cwd: root,
      url: `${api}/health`,
      env: { DATA_DIR: dataDir, LOG_LEVEL: 'warn', LEASE_SWEEP_INTERVAL: '30s' },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `pnpm exec vite --port ${WEB_PORT} --strictPort --host 127.0.0.1`,
      cwd: import.meta.dirname,
      url: `http://127.0.0.1:${WEB_PORT}/`,
      env: { AGENT_GRAPHS_URL: api },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
