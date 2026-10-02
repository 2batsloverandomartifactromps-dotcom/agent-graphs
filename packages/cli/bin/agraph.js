#!/usr/bin/env node
// Development entry: runs the TypeScript sources through tsx. Releases (M5) point `bin` at a
// tsdown bundle instead.
//
// Fast path: a throttled PostToolUse heartbeat (`agraph hook post-tool-use`) must finish in well
// under 100 ms, so it is decided here in plain JS before tsx and the command modules load. The
// throttle stamp layout matches packages/cli/src/hooks.ts.
import { readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [command, event] = process.argv.slice(2);
if (
  command === 'hook' &&
  (event === 'post-tool-use' || event === 'heartbeat') &&
  !process.stdin.isTTY
) {
  let input = '';
  try {
    input = readFileSync(0, 'utf8');
  } catch {
    input = '';
  }
  globalThis.__AGRAPH_STDIN__ = input;
  try {
    const sessionId = JSON.parse(input).session_id;
    if (typeof sessionId !== 'string' || !sessionId) process.exit(0);
    const dir = process.env.AGENT_GRAPHS_STATE_DIR ?? join(tmpdir(), 'agent-graphs');
    const file = join(dir, 'hb', sessionId.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120));
    const seconds = Number(process.env.AGENT_GRAPHS_HEARTBEAT_THROTTLE ?? 60);
    const window = (Number.isFinite(seconds) && seconds >= 0 ? seconds : 60) * 1000;
    if (Date.now() - statSync(file).mtimeMs < window) process.exit(0);
  } catch {
    // no stamp yet, or unparsable input: fall through to the full hook
  }
}

const { register } = await import('tsx/esm/api');
register();
await import('../src/bin.ts');
