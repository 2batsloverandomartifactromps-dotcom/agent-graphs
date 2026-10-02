import { DEFAULT_BASE_URL, getHealth } from '@agent-graphs/sdk';
import { Command } from 'commander';
import { CLI_VERSION } from './version';

/**
 * `agraph`: the single binary for serving, MCP bridging, Claude Code hooks, and client
 * commands. The full command set is specified in docs/agent-protocol.md §7.2 and built in
 * M3 (node `cli` in docs/build-graph.yaml).
 */
const program = new Command('agraph')
  .description('Agent Graphs: execution graphs for agent-orchestrated builds')
  .version(CLI_VERSION);

program
  .command('serve')
  .description('Start the Agent Graphs server (API + web UI)')
  .option('--port <port>', 'port to listen on', process.env.PORT ?? '4747')
  .option('--host <host>', 'interface to bind', process.env.HOST ?? '127.0.0.1')
  .action(async (options: { port: string; host: string }) => {
    const { startServer } = await import('@agent-graphs/server');
    startServer({ port: Number(options.port), hostname: options.host });
  });

program
  .command('health')
  .description('Check that an Agent Graphs server is reachable')
  .option('--url <url>', 'server URL', process.env.AGENT_GRAPHS_URL ?? DEFAULT_BASE_URL)
  .action(async (options: { url: string }) => {
    const health = await getHealth({ baseUrl: options.url, token: process.env.AGENT_GRAPHS_TOKEN });
    console.log(JSON.stringify(health));
  });

await program.parseAsync();
