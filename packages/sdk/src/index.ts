/**
 * @agent-graphs/sdk: a typed fetch client for every endpoint in docs/api.md plus an SSE helper.
 * It runs in Node and browsers and is shared by the CLI, MCP server, simulator, and web app.
 * Built in milestone M3 (node `sdk` in docs/build-graph.yaml).
 */

export type ClientOptions = {
  /** Server origin, e.g. http://localhost:4747 (the `AGENT_GRAPHS_URL` env var). */
  baseUrl: string;
  /** Bearer token (`AGENT_GRAPHS_TOKEN`). Optional in `AUTH_MODE=local`. */
  token?: string;
  fetch?: typeof fetch;
};

export const DEFAULT_BASE_URL = 'http://localhost:4747';

/** Minimal health probe, used by the CLI and tests until the full client lands. */
export async function getHealth(options: ClientOptions): Promise<{ ok: boolean; version: string }> {
  const doFetch = options.fetch ?? fetch;
  const response = await doFetch(new URL('/health', options.baseUrl), {
    headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
  });
  if (!response.ok) throw new Error(`Health check failed: HTTP ${response.status}`);
  return (await response.json()) as { ok: boolean; version: string };
}
