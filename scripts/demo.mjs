#!/usr/bin/env node
// `pnpm demo`: a fresh server (temporary data directory) plus simulated agents driving
// examples/graphs/notes-app.yaml, so the UI has something alive to show.
//   pnpm demo [-- --port 4747 --speed 60 --ui --spec examples/graphs/nested-loops.yaml]
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const bin = join(root, 'packages/cli/bin/agraph.js');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const port = flag('port', '4747');
const speed = flag('speed', '60');
const spec = flag('spec', 'examples/graphs/notes-app.yaml');
const url = `http://127.0.0.1:${port}`;
const data = mkdtempSync(join(tmpdir(), 'agent-graphs-demo-'));
const children = [];

function run(command, commandArgs, options = {}) {
  const child = spawn(command, commandArgs, { cwd: root, stdio: 'inherit', ...options });
  children.push(child);
  return child;
}

function stop() {
  for (const c of children) c.kill('SIGTERM');
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

run(process.execPath, [bin, 'serve', '--port', port, '--data', data], {
  env: { ...process.env, LOG_LEVEL: 'warn' },
});
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${url}/health`)).ok) break;
  } catch {
    // not up yet
  }
  await new Promise((r) => setTimeout(r, 200));
}
console.log(`Agent Graphs demo server: ${url} (data: ${data})`);
if (args.includes('--ui')) {
  run('pnpm', ['--filter', '@agent-graphs/web', 'dev']);
  console.log('Web UI: http://localhost:5173');
}
const sim = run(process.execPath, [bin, 'simulate', spec, '--url', url, '--speed', speed]);
sim.on('exit', (code) => {
  console.log(
    `Simulation finished (exit ${code}). The server keeps running; press Ctrl-C to stop.`,
  );
});
