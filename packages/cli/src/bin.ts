/**
 * `agraph`: the single binary for serving, MCP bridging, Claude Code hooks, and client
 * commands (docs/agent-protocol.md §7.2).
 */
import { processIo } from './io';
import { runCli } from './program';

const LONG_RUNNING = new Set(['serve', 'mcp', 'simulate']);
const argv = process.argv.slice(2);
const io = processIo();
const preread = (globalThis as { __AGRAPH_STDIN__?: string }).__AGRAPH_STDIN__;
if (preread !== undefined) io.readStdin = async () => preread;

const code = await runCli(argv, io);
const command = argv.find((a) => !a.startsWith('-'));
if (!command || !LONG_RUNNING.has(command)) {
  // Flush stdout (pipes are async) and exit promptly, so hooks never linger on open sockets.
  await new Promise<void>((resolve) => process.stdout.write('', () => resolve()));
  process.exit(code);
}
process.exitCode = code;
