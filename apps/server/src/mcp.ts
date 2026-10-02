/**
 * MCP over Streamable HTTP at `/mcp` (docs/agent-protocol.md §7.1). The MCP tools call the
 * REST API in-process: each MCP session gets an sdk client whose `fetch` is `app.request` and
 * which forwards the caller's bearer token, so auth and permissions apply exactly as over HTTP.
 */
import { createMcpHttpHandler } from '@agent-graphs/mcp';
import type { Context, Hono } from 'hono';
import type { Env } from './auth';
import type { AppContext } from './context';

export function mcpHandler(app: Hono<Env> & { ctx: AppContext }) {
  const handler = createMcpHttpHandler({
    fetch: ((input: string | URL | Request, init?: RequestInit) =>
      app.request(String(input), init)) as typeof fetch,
  });
  return async (c: Context<Env>): Promise<Response> => {
    if (app.ctx.config.authMode === 'token' && !c.req.header('authorization')) {
      return c.json(
        {
          error: {
            code: 'UNAUTHENTICATED',
            message: 'A bearer token is required (AUTH_MODE=token).',
            hint: 'Send Authorization: Bearer <token>; create one with `agraph token create`.',
          },
        },
        401,
      );
    }
    return handler.handle(c.req.raw);
  };
}
