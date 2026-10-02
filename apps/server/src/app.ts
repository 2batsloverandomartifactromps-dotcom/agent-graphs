import { SPEC_SCHEMA } from '@agent-graphs/core';
import { Hono } from 'hono';

export const VERSION = '0.0.0';

/**
 * Builds the HTTP app. Routes, auth, OpenAPI, SSE, and MCP are added in M2/M3
 * (docs/api.md, docs/architecture.md §3). Keep handlers thin: business logic lives in
 * commands, and the rules live in the @agent-graphs/core engine.
 */
export function createApp(): Hono {
  const app = new Hono();
  app.get('/health', (c) => c.json({ ok: true, version: VERSION, spec: SPEC_SCHEMA }));
  return app;
}
