/** Argument parsers for the CLI's compact flag syntax (docs/agent-protocol.md §7.2). */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EVIDENCE_KINDS, type Evidence } from '@agent-graphs/core';
import { parseActor } from '@agent-graphs/mcp';
import { CliUsageError, type Io } from './io';

/** `name=value` pairs → numbers (`test_pass_rate=1 coverage=0.91`). */
export function parseMetrics(pairs: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq).trim();
    const value = Number(pair.slice(eq + 1));
    if (eq <= 0 || !name || pair.slice(eq + 1).trim() === '' || Number.isNaN(value))
      throw new CliUsageError(`Expected name=number, got '${pair}'.`);
    out[name] = value;
  }
  return out;
}

const EVIDENCE_ALIASES: Record<string, Evidence['kind']> = {
  cmd: 'command',
  sha: 'commit',
  link: 'url',
  img: 'image',
};

/**
 * `kind:value` evidence (`commit:3f9a2c1`, `pr:https://…/42`, `file:src/api.ts`,
 * `cmd:pnpm test`). A command may end with `=N` for its exit code (`cmd:pnpm test=0`).
 */
export function parseEvidence(item: string): Evidence {
  const colon = item.indexOf(':');
  const rawKind = colon > 0 ? item.slice(0, colon) : '';
  const kind = (EVIDENCE_ALIASES[rawKind] ?? rawKind) as Evidence['kind'];
  if (!(EVIDENCE_KINDS as readonly string[]).includes(kind)) return { kind: 'text', value: item };
  let value = item.slice(colon + 1);
  if (kind === 'command') {
    const exit = /^(.*\S)\s*=\s*(-?\d+)$/.exec(value);
    if (exit) {
      value = exit[1] as string;
      return { kind, value, meta: { exitCode: Number(exit[2]) } };
    }
  }
  return { kind, value };
}

/** `aim=verdict:rationale` (`handles-errors=met:All handlers use the error envelope`). */
export function parseEval(item: string): {
  aim: string;
  verdict: 'met' | 'unmet' | 'partial';
  rationale?: string;
} {
  const m = /^([a-z0-9][a-z0-9-]*)=(met|unmet|partial)(?::(.*))?$/s.exec(item.trim());
  if (!m) throw new CliUsageError(`Expected aim=met|unmet|partial[:rationale], got '${item}'.`);
  return {
    aim: m[1] as string,
    verdict: m[2] as 'met' | 'unmet' | 'partial',
    ...(m[3] ? { rationale: m[3] } : {}),
  };
}

/** `@file.json`, inline JSON, or plain text. */
export function parseJsonArg(value: string, io: Io): unknown {
  const text = value.startsWith('@')
    ? readFileSync(resolve(io.cwd, value.slice(1)), 'utf8')
    : value;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** `--actor model=…,thinking=…` over `AGENT_GRAPHS_ACTOR`, plus the runtime session id. */
export function actorFrom(
  io: Io,
  flag: string | undefined,
  options: { clientSession?: boolean } = {},
): Record<string, string> {
  const clientSessionId =
    options.clientSession === false ? undefined : io.env.AGENT_GRAPHS_CLIENT_SESSION;
  return {
    kind: 'agent',
    mechanism: 'cli',
    ...parseActor(io.env.AGENT_GRAPHS_ACTOR),
    ...parseActor(flag),
    ...(clientSessionId ? { clientSessionId } : {}),
  };
}

export function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}
