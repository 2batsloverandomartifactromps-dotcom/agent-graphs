/**
 * Streamable HTTP for the MCP server (mounted by the server at `/mcp`). Each MCP session gets
 * its own McpServer and tool context, so sessions learned from claims and attachments persist
 * across that client's requests. Built on the MCP SDK's web-standard transport, so it works
 * with any `Request → Response` host (Hono, Node, workers).
 */
import { AgentGraphsClient } from '@agent-graphs/sdk';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer, isMcpProfile, type McpProfile } from './server';

export type McpHttpOptions = {
  /**
   * The API client for a new MCP session, built from its initialize request. Defaults to an
   * sdk client over `fetch` that forwards the request's bearer token.
   */
  clientFor?: (request: Request) => AgentGraphsClient;
  /** For the default client: how to reach the API (for example a Hono `app.request`). */
  fetch?: typeof fetch;
  /** For the default client: the API origin (default `http://in-process.local`). */
  baseUrl?: string;
  /** Profile when the URL has no `?profile=` (default `all`). */
  profile?: McpProfile;
  /** Oldest sessions are closed beyond this many (default 500). */
  maxSessions?: number;
};

type Entry = {
  transport: WebStandardStreamableHTTPServerTransport;
  close: () => Promise<void>;
};

function jsonRpcError(status: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** An sdk client that forwards the MCP request's bearer token to the API. */
export function forwardingClient(
  request: Request,
  options: { fetch?: typeof fetch; baseUrl?: string } = {},
): AgentGraphsClient {
  const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  return new AgentGraphsClient({
    baseUrl: options.baseUrl ?? 'http://in-process.local',
    ...(bearer ? { token: bearer } : {}),
    client: 'mcp',
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

export function createMcpHttpHandler(options: McpHttpOptions) {
  const clientFor = options.clientFor ?? ((request: Request) => forwardingClient(request, options));
  const sessions = new Map<string, Entry>();
  const max = options.maxSessions ?? 500;

  async function evict(): Promise<void> {
    while (sessions.size > max) {
      const [oldest, entry] = sessions.entries().next().value as [string, Entry];
      sessions.delete(oldest);
      await entry.close().catch(() => {});
    }
  }

  async function handle(request: Request): Promise<Response> {
    const sessionId = request.headers.get('mcp-session-id');
    if (sessionId) {
      const entry = sessions.get(sessionId);
      if (!entry) return jsonRpcError(404, -32001, 'Session not found; initialize a new session.');
      return entry.transport.handleRequest(request);
    }
    if (request.method !== 'POST')
      return jsonRpcError(400, -32000, 'Missing mcp-session-id header; initialize first.');
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonRpcError(400, -32700, 'Parse error: the body is not JSON.');
    }
    const messages = Array.isArray(body) ? body : [body];
    if (!messages.some((m) => isInitializeRequest(m)))
      return jsonRpcError(400, -32000, 'No session: send an initialize request first.');
    const requested = new URL(request.url).searchParams.get('profile');
    const profile = isMcpProfile(requested) ? requested : (options.profile ?? 'all');
    const server = createMcpServer({ client: clientFor(request), profile });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, close: () => server.close() });
        void evict();
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
      },
    });
    await server.connect(transport);
    return transport.handleRequest(request, { parsedBody: body });
  }

  return {
    handle,
    /** Active MCP sessions (for tests and diagnostics). */
    get size() {
      return sessions.size;
    },
    async close(): Promise<void> {
      const entries = [...sessions.values()];
      sessions.clear();
      await Promise.all(entries.map((e) => e.close().catch(() => {})));
    },
  };
}
