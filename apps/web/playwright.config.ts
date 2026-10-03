/**
 * E2E: builds the web app into a temporary folder and starts `agraph serve` with a temporary
 * DATA_DIR. The server serves the build at `/` (same origin as the API and SSE, no proxy), and the
 * suite drives it with the pre-installed Chromium. Never run `playwright install`.
 *   pnpm -F @agent-graphs/web test:e2e
 * Set E2E_WEB=dev to run against the Vite dev server (proxying to the API) instead.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defineConfig } from '@playwright/test';

const API_PORT = Number(process.env.E2E_API_PORT ?? 4787);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5187);
const dev = process.env.E2E_WEB === 'dev';
const api = `http://127.0.0.1:${API_PORT}`;
const root = resolve(import.meta.dirname, '../..');
// Playwright loads this config in the runner and in each worker; reuse the first temp folder.
const tmp = process.env.E2E_TMP ?? mkdtempSync(join(tmpdir(), 'agent-graphs-e2e-'));
process.env.E2E_TMP = tmp;
const dataDir = process.env.E2E_DATA_DIR ?? join(tmp, 'data');
const webDir = join(tmp, 'web');
process.env.E2E_API_URL = api;

const serveApi = `node packages/cli/bin/agraph.js serve --port ${API_PORT}`;
const apiEnv = { DATA_DIR: dataDir, LOG_LEVEL: 'warn', LEASE_SWEEP_INTERVAL: '30s' };

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
    baseURL: dev ? `http://127.0.0.1:${WEB_PORT}` : api,
    viewport: { width: 1440, height: 900 },
    launchOptions: { executablePath: process.env.E2E_CHROMIUM ?? '/opt/pw-browsers/chromium' },
    trace: 'retain-on-failure',
  },
  webServer: dev
    ? [
        {
          command: serveApi,
          cwd: root,
          url: `${api}/health`,
          env: apiEnv,
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
      ]
    : [
        {
          command: `pnpm -F @agent-graphs/web exec vite build --outDir ${webDir} --emptyOutDir --logLevel warn && ${serveApi}`,
          cwd: root,
          url: `${api}/`,
          env: { ...apiEnv, WEB_DIR: webDir },
          reuseExistingServer: false,
          timeout: 120_000,
        },
      ],
});
