/** The stdio entry used by `agraph mcp` (what Claude Code spawns from `.mcp.json`). */
import { clientFromEnv } from '@agent-graphs/sdk';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { clientSessionFromEnv, parseActor } from './client-session';
import { createMcpServer, type McpProfile } from './server';

export type StdioOptions = {
  profile?: McpProfile;
  env?: Record<string, string | undefined>;
  cwd?: string;
};

/** Serve MCP over stdin/stdout, configured from AGENT_GRAPHS_* environment variables. */
export async function runStdioServer(options: StdioOptions = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const server = createMcpServer({
    // The session goes to the tool context, not the client: attempt-scoped calls must not send
    // it (they keep the attempt executor's annotation); capability calls add it per call.
    client: clientFromEnv({ ...env, AGENT_GRAPHS_SESSION: undefined }, { client: 'mcp' }),
    profile: options.profile ?? 'all',
    actor: parseActor(env.AGENT_GRAPHS_ACTOR),
    clientSessionId: () => clientSessionFromEnv(env, cwd),
    ...(env.AGENT_GRAPHS_SESSION ? { session: env.AGENT_GRAPHS_SESSION } : {}),
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
