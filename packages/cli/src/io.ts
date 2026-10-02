/**
 * Process boundaries for the CLI (stdout, stderr, env, stdin, fetch), injectable so commands
 * and hooks run in-process in tests.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  AgentGraphsClient,
  AgentGraphsError,
  type ClientOptions,
  DEFAULT_BASE_URL,
} from '@agent-graphs/sdk';

export type Io = {
  out: (text: string) => void;
  err: (text: string) => void;
  env: Record<string, string | undefined>;
  cwd: string;
  readStdin: () => Promise<string>;
  /** Overrides the network (tests route requests to an in-memory server). */
  fetch?: typeof fetch;
  now?: () => number;
};

export function processIo(): Io {
  return {
    out: (t) => process.stdout.write(t.endsWith('\n') ? t : `${t}\n`),
    err: (t) => process.stderr.write(t.endsWith('\n') ? t : `${t}\n`),
    env: process.env,
    cwd: process.cwd(),
    readStdin: () => readAll(process.stdin),
  };
}

export async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  if ((stream as { isTTY?: boolean }).isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

// ─── Saved login (`agraph login`) ────────────────────────────────────────────
export type SavedConfig = { url?: string; token?: string };

export function configPath(env: Record<string, string | undefined>): string {
  if (env.AGENT_GRAPHS_CONFIG) return env.AGENT_GRAPHS_CONFIG;
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config');
  return join(base, 'agent-graphs', 'config.json');
}

export function readConfig(env: Record<string, string | undefined>): SavedConfig {
  try {
    return JSON.parse(readFileSync(configPath(env), 'utf8')) as SavedConfig;
  } catch {
    return {};
  }
}

export function writeConfig(env: Record<string, string | undefined>, config: SavedConfig): string {
  const path = configPath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return path;
}

export type GlobalOptions = {
  url?: string;
  token?: string;
  session?: string;
  json?: boolean;
  actor?: string;
};

/** The sdk client for a command: flags, then AGENT_GRAPHS_* env, then the saved login. */
export function clientFor(
  io: Io,
  opts: GlobalOptions,
  extra: Partial<ClientOptions> = {},
): AgentGraphsClient {
  const saved = readConfig(io.env);
  const token = opts.token ?? io.env.AGENT_GRAPHS_TOKEN ?? saved.token;
  const session = opts.session ?? io.env.AGENT_GRAPHS_SESSION;
  return new AgentGraphsClient({
    baseUrl: opts.url ?? io.env.AGENT_GRAPHS_URL ?? saved.url ?? DEFAULT_BASE_URL,
    client: 'cli',
    ...(token ? { token } : {}),
    ...(session ? { session } : {}),
    ...(io.fetch ? { fetch: io.fetch } : {}),
    ...extra,
  });
}

/** Thrown for usage mistakes (missing arguments); printed without a stack, exit code 2. */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

export function describeError(error: unknown): { text: string; json: unknown; code: number } {
  if (error instanceof AgentGraphsError) {
    return {
      text: error.describe(),
      json: {
        error: {
          status: error.status,
          code: error.code,
          message: error.message,
          ...(error.hint ? { hint: error.hint } : {}),
          ...(error.details !== undefined ? { details: error.details } : {}),
        },
      },
      code: 1,
    };
  }
  if (error instanceof CliUsageError)
    return {
      text: `error: ${error.message}`,
      json: { error: { code: 'USAGE', message: error.message } },
      code: 2,
    };
  const message = error instanceof Error ? error.message : String(error);
  return { text: `error: ${message}`, json: { error: { code: 'ERROR', message } }, code: 1 };
}
