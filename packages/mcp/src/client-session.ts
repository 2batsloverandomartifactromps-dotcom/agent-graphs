/**
 * Mapping between an agent runtime's own session id (for example a Claude Code `session_id`)
 * and the processes that need it. Claude Code gives the id to hooks (stdin JSON) but not to MCP
 * servers, so the `SessionStart` hook records it here and the stdio MCP server reads it back
 * when a tool call carries no explicit `clientSessionId` (docs/agent-protocol.md §8).
 *
 * The record is keyed by working directory: the most recent session started in a directory
 * wins. Explicit ids (tool arguments, `AGENT_GRAPHS_CLIENT_SESSION`) always take precedence.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Records older than this are ignored (a stale session is worse than none). */
const MAX_AGE_MS = 24 * 3600_000;

/** Where hooks and the MCP server keep small state files (throttles, session records). */
export function stateDir(env: Record<string, string | undefined> = process.env): string {
  return env.AGENT_GRAPHS_STATE_DIR ?? join(tmpdir(), 'agent-graphs');
}

function recordPath(cwd: string, env: Record<string, string | undefined>): string {
  const key = createHash('sha1').update(resolve(cwd)).digest('hex').slice(0, 16);
  return join(stateDir(env), 'sessions', `${key}.json`);
}

export type ClientSessionRecord = { sessionId: string; cwd: string; at: number; source?: string };

export function writeClientSession(
  cwd: string,
  sessionId: string,
  options: { env?: Record<string, string | undefined>; now?: number; source?: string } = {},
): void {
  const env = options.env ?? process.env;
  const path = recordPath(cwd, env);
  mkdirSync(join(stateDir(env), 'sessions'), { recursive: true });
  const record: ClientSessionRecord = {
    sessionId,
    cwd: resolve(cwd),
    at: options.now ?? Date.now(),
    ...(options.source ? { source: options.source } : {}),
  };
  writeFileSync(path, JSON.stringify(record));
}

export function readClientSession(
  cwd: string,
  options: { env?: Record<string, string | undefined>; now?: number } = {},
): string | undefined {
  const env = options.env ?? process.env;
  try {
    const record = JSON.parse(readFileSync(recordPath(cwd, env), 'utf8')) as ClientSessionRecord;
    if ((options.now ?? Date.now()) - record.at > MAX_AGE_MS) return undefined;
    return typeof record.sessionId === 'string' ? record.sessionId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the runtime session id for a stdio MCP server: `AGENT_GRAPHS_CLIENT_SESSION`, then
 * the record the `SessionStart` hook wrote for `CLAUDE_PROJECT_DIR` or the current directory.
 */
export function clientSessionFromEnv(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): string | undefined {
  return (
    env.AGENT_GRAPHS_CLIENT_SESSION ||
    (env.CLAUDE_PROJECT_DIR ? readClientSession(env.CLAUDE_PROJECT_DIR, { env }) : undefined) ||
    readClientSession(cwd, { env })
  );
}

/**
 * Parse `AGENT_GRAPHS_ACTOR` (`model=claude-opus-5-5,thinking=high,mechanism=claude-code`) into
 * a partial execution annotation.
 */
export function parseActor(value: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (value ?? '').split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (key && val) out[key] = val;
  }
  return out;
}
