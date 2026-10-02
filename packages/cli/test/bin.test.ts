import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '@agent-graphs/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MINIMAL, REPO } from './helpers';

const BIN = join(REPO, 'packages/cli/bin/agraph.js');
let server: ReturnType<typeof startServer>;
let url = '';
const dir = mkdtempSync(join(tmpdir(), 'agraph-bin-'));

/** Spawn the bin asynchronously (the server runs in this process, so never block the loop). */
function agraph(
  args: string[],
  input?: string,
  env: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: {
        ...process.env,
        AGENT_GRAPHS_URL: url,
        AGENT_GRAPHS_STATE_DIR: join(dir, 'state'),
        AGENT_GRAPHS_CONFIG: join(dir, 'config.json'),
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(input ?? '');
  });
}

beforeAll(async () => {
  server = startServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: join(dir, 'data'),
    logLevel: 'silent',
  });
  await new Promise<void>((resolve) => {
    if (server.listening) resolve();
    else server.once('listening', () => resolve());
  });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('the agraph binary against a live server', () => {
  it('runs client commands over HTTP', async () => {
    const health = await agraph(['health', '--json']);
    expect(health.code, health.stderr).toBe(0);
    expect(JSON.parse(health.stdout)).toMatchObject({ ok: true, url });
    const spec = join(dir, 'spec.yaml');
    writeFileSync(spec, MINIMAL);
    const created = await agraph(['graph', 'create', '-f', spec, '--start', '--json']);
    expect(created.code, created.stderr).toBe(0);
    expect(JSON.parse(created.stdout).graph.status).toBe('active');
  }, 60_000);

  it('runs hooks from stdin and fails open when the server is unreachable', async () => {
    const input = JSON.stringify({
      session_id: 'cc-bin-1',
      hook_event_name: 'Stop',
      stop_hook_active: false,
    });
    const stop = await agraph(['hook', 'stop'], input);
    expect(stop).toMatchObject({ code: 0, stdout: '' });
    const down = await agraph(['hook', 'stop'], input, { AGENT_GRAPHS_URL: 'http://127.0.0.1:9' });
    expect(down).toMatchObject({ code: 0, stdout: '' });
  }, 60_000);

  it('decides a throttled PostToolUse heartbeat before loading the CLI', async () => {
    mkdirSync(join(dir, 'state', 'hb'), { recursive: true });
    writeFileSync(join(dir, 'state', 'hb', 'cc-fast'), '');
    const input = JSON.stringify({ session_id: 'cc-fast', hook_event_name: 'PostToolUse' });
    const runs = [];
    for (let i = 0; i < 3; i++) runs.push(await agraph(['hook', 'post-tool-use'], input));
    for (const r of runs) expect(r).toMatchObject({ code: 0, stdout: '' });
    // Process spawn included; the hook itself does one stat call (well under 100 ms).
    expect(Math.min(...runs.map((r) => r.ms))).toBeLessThan(1000);
  }, 60_000);
});
