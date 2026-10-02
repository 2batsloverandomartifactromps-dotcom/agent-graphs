import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '@agent-graphs/server';
import type { Io } from '../src/io';
import { runCli } from '../src/program';

export const REPO = resolve(import.meta.dirname, '../../..');
export const MINIMAL = readFileSync(join(REPO, 'examples/graphs/minimal.yaml'), 'utf8');

export type Harness = ReturnType<typeof harness>;

/** An in-memory server, a fake clock, and an in-process CLI whose fetch is `app.request`. */
export function harness(options: { now?: number } = {}) {
  const clock = { now: options.now ?? Date.UTC(2026, 9, 2, 12) };
  const app = createApp({ now: () => clock.now });
  const dir = mkdtempSync(join(tmpdir(), 'agraph-test-'));
  const calls: Array<{ method: string; path: string }> = [];
  const fetchApp = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ method: init?.method ?? 'GET', path: url.pathname });
    return app.request(`${url.pathname}${url.search}`, init);
  }) as typeof fetch;
  const baseEnv: Record<string, string | undefined> = {
    AGENT_GRAPHS_URL: 'http://test.local',
    AGENT_GRAPHS_CONFIG: join(dir, 'config.json'),
    AGENT_GRAPHS_STATE_DIR: join(dir, 'state'),
    HOME: dir,
  };
  async function run(
    argv: string[],
    opts: { env?: Record<string, string | undefined>; stdin?: string; fetch?: typeof fetch } = {},
  ) {
    let stdout = '';
    let stderr = '';
    const io: Io = {
      out: (t) => {
        stdout += t.endsWith('\n') ? t : `${t}\n`;
      },
      err: (t) => {
        stderr += t.endsWith('\n') ? t : `${t}\n`;
      },
      env: { ...baseEnv, ...opts.env },
      cwd: dir,
      readStdin: async () => opts.stdin ?? '',
      fetch: opts.fetch ?? fetchApp,
      now: () => clock.now,
    };
    const code = await runCli(argv, io);
    return {
      code,
      stdout,
      stderr,
      // biome-ignore lint/suspicious/noExplicitAny: parsed CLI JSON is loosely typed in tests
      json: () => JSON.parse(stdout) as any,
    };
  }
  function file(name: string, content: string): string {
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  }
  return { app, clock, dir, run, file, calls, fetch: fetchApp, env: baseEnv };
}
