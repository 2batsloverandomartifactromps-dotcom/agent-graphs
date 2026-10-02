/**
 * `agraph claude install`: wire a repository for Claude Code (docs/agent-protocol.md §8). Writes
 * or merges `.mcp.json`, the hook entries in `.claude/settings.json`, and the agent-graphs skill.
 * Idempotent, and it never touches unrelated settings: only entries it recognizes as its own
 * (an `agraph`/`agent-graphs` command running `hook …`, the `agent-graphs` MCP server) change.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliUsageError } from './io';

export const BIN_PATH = fileURLToPath(new URL('../bin/agraph.js', import.meta.url));
export const SKILL_SOURCE = fileURLToPath(
  new URL('../../../integrations/claude-code/skills/agent-graphs/SKILL.md', import.meta.url),
);

export type InstallOptions = {
  dir: string;
  url: string;
  /** The command that runs agraph, e.g. `node "/repo/packages/cli/bin/agraph.js"` or `npx -y agent-graphs`. */
  command?: string;
  profile?: string;
  actor?: string;
  mcp?: boolean;
  hooks?: boolean;
  skill?: boolean;
};

export type InstallReport = Array<{ path: string; action: 'created' | 'updated' | 'unchanged' }>;

type Json = Record<string, unknown>;

/** Expanded by Claude Code from the environment when it starts the MCP server. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: a Claude Code env reference, not a template
export const TOKEN_REFERENCE = '${AGENT_GRAPHS_TOKEN:-}';
type HookEntry = { type: string; command: string; timeout?: number };
type HookGroup = { matcher?: string; hooks: HookEntry[] };

const OUR_HOOK =
  /(agraph|agent-graphs)\S*["']?\s+hook\s+(session-start|post-tool-use|heartbeat|stop|subagent-stop|pre-compact)\b/;

function quote(path: string): string {
  return /[\s"']/.test(path) ? `"${path}"` : path;
}

/** The command prefix for hooks, and the `.mcp.json` command/args for the MCP server. */
export function launcher(command?: string): {
  prefix: string;
  mcp: { command: string; args: string[] };
} {
  if (!command)
    return { prefix: `node ${quote(BIN_PATH)}`, mcp: { command: 'node', args: [BIN_PATH] } };
  const parts =
    command.match(/"[^"]*"|'[^']*'|\S+/g)?.map((p) => p.replace(/^["']|["']$/g, '')) ?? [];
  if (!parts.length) throw new CliUsageError('--command is empty.');
  return { prefix: command, mcp: { command: parts[0] as string, args: parts.slice(1) } };
}

export function hookConfig(prefix: string): Record<string, HookGroup[]> {
  const entry = (args: string, timeout: number): HookEntry => ({
    type: 'command',
    command: `${prefix} hook ${args}`,
    timeout,
  });
  return {
    SessionStart: [{ hooks: [entry('session-start', 15)] }],
    PostToolUse: [{ matcher: '*', hooks: [entry('post-tool-use', 5)] }],
    Stop: [{ hooks: [entry('stop', 15)] }],
    SubagentStop: [{ hooks: [entry('stop --subagent', 15)] }],
    PreCompact: [{ hooks: [entry('pre-compact', 10)] }],
  };
}

function readJson(path: string): Json | undefined {
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, 'utf8');
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('not an object');
    return parsed as Json;
  } catch (error) {
    throw new CliUsageError(
      `${path} is not valid JSON (${(error as Error).message}); fix it first, nothing was changed.`,
    );
  }
}

function write(path: string, content: string, report: InstallReport): void {
  const before = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  if (before === content) {
    report.push({ path, action: 'unchanged' });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  report.push({ path, action: before === undefined ? 'created' : 'updated' });
}

/** Merge our hook groups into existing settings, replacing only our previous entries. */
export function mergeHooks(settings: Json, ours: Record<string, HookGroup[]>): Json {
  const hooks = { ...((settings.hooks as Record<string, HookGroup[]> | undefined) ?? {}) };
  for (const [event, groups] of Object.entries(ours)) {
    const kept: HookGroup[] = [];
    for (const group of hooks[event] ?? []) {
      const entries = (group.hooks ?? []).filter((h) => !OUR_HOOK.test(h.command ?? ''));
      if (entries.length) kept.push({ ...group, hooks: entries });
    }
    hooks[event] = [...kept, ...groups];
  }
  return { ...settings, hooks };
}

export function installClaude(options: InstallOptions): InstallReport {
  const dir = resolve(options.dir);
  if (!existsSync(dir)) throw new CliUsageError(`Directory ${dir} does not exist.`);
  const report: InstallReport = [];
  const { prefix, mcp } = launcher(options.command);

  if (options.mcp !== false) {
    const path = join(dir, '.mcp.json');
    const existing = readJson(path) ?? {};
    const servers = { ...((existing.mcpServers as Json | undefined) ?? {}) };
    servers['agent-graphs'] = {
      command: mcp.command,
      args: [
        ...mcp.args,
        'mcp',
        ...(options.profile && options.profile !== 'all' ? ['--profile', options.profile] : []),
      ],
      env: {
        AGENT_GRAPHS_URL: options.url,
        AGENT_GRAPHS_TOKEN: TOKEN_REFERENCE,
        AGENT_GRAPHS_ACTOR: options.actor ?? 'mechanism=claude-code,provider=anthropic',
      },
    };
    write(path, `${JSON.stringify({ ...existing, mcpServers: servers }, null, 2)}\n`, report);
  }

  if (options.hooks !== false) {
    const path = join(dir, '.claude', 'settings.json');
    const existing = readJson(path) ?? {};
    const merged = mergeHooks(existing, hookConfig(prefix));
    const env = { ...((existing.env as Json | undefined) ?? {}), AGENT_GRAPHS_URL: options.url };
    write(path, `${JSON.stringify({ ...merged, env }, null, 2)}\n`, report);
  }

  if (options.skill !== false) {
    if (!existsSync(SKILL_SOURCE))
      throw new CliUsageError(`Skill source not found at ${SKILL_SOURCE}.`);
    write(
      join(dir, '.claude', 'skills', 'agent-graphs', 'SKILL.md'),
      readFileSync(SKILL_SOURCE, 'utf8'),
      report,
    );
  }
  return report;
}
