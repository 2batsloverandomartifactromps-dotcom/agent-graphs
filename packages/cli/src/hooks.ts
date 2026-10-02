/**
 * Claude Code hooks (docs/agent-protocol.md §8.2). Each hook reads the hook JSON from stdin and
 * prints the Claude Code hook output JSON on stdout. Hooks never break the agent's session:
 * when the server is unreachable or anything fails they exit 0 quietly (fail open). Only
 * `stop` under the `block` policy ever blocks.
 *
 * The Claude `session_id` maps to an Agent Graphs session through `clientSessionId`.
 */
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { stateDir, writeClientSession } from '@agent-graphs/mcp';
import { type AgentGraphsClient, AgentGraphsError, type Directive } from '@agent-graphs/sdk';

export const HOOK_EVENTS = [
  'session-start',
  'post-tool-use',
  'heartbeat',
  'stop',
  'subagent-stop',
  'pre-compact',
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export type HookInput = {
  session_id?: string;
  hook_event_name?: string;
  cwd?: string;
  source?: string;
  stop_hook_active?: boolean;
  trigger?: string;
  tool_name?: string;
  agent_id?: string;
  agent_type?: string;
};

export type HookResult = { code: number; stdout?: string };

export type HookDeps = {
  client: AgentGraphsClient;
  env: Record<string, string | undefined>;
  cwd: string;
  now: number;
  subagent?: boolean;
};

const DEFAULT_THROTTLE_SEC = 60;
const BRIEFING_BUDGET = 4000;
const SITREP_BUDGET = 2500;

export function parseHookInput(stdin: string): HookInput {
  try {
    const parsed = JSON.parse(stdin) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as HookInput) : {};
  } catch {
    return {};
  }
}

function output(json: unknown): HookResult {
  return { code: 0, stdout: JSON.stringify(json) };
}

function context(event: 'SessionStart' | 'PostToolUse', text: string): HookResult {
  return output({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
}

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);
}

/** Path of the PostToolUse throttle stamp for a Claude session. */
export function throttleFile(env: Record<string, string | undefined>, sessionId: string): string {
  return join(stateDir(env), 'hb', safeId(sessionId));
}

export function throttleSeconds(env: Record<string, string | undefined>): number {
  const n = Number(env.AGENT_GRAPHS_HEARTBEAT_THROTTLE ?? DEFAULT_THROTTLE_SEC);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_THROTTLE_SEC;
}

/** True when a heartbeat was sent for this session within the throttle window. */
export function throttled(env: Record<string, string | undefined>, sessionId: string, now: number) {
  try {
    return now - statSync(throttleFile(env, sessionId)).mtimeMs < throttleSeconds(env) * 1000;
  } catch {
    return false;
  }
}

function stamp(env: Record<string, string | undefined>, sessionId: string, now: number): void {
  const file = throttleFile(env, sessionId);
  mkdirSync(join(stateDir(env), 'hb'), { recursive: true });
  writeFileSync(file, '');
  const t = new Date(now);
  utimesSync(file, t, t);
}

/** Run one hook. Never throws. */
export async function runHook(
  event: HookEvent,
  input: HookInput,
  deps: HookDeps,
): Promise<HookResult> {
  try {
    const sessionId = input.session_id;
    if (!sessionId) return { code: 0 };
    switch (event) {
      case 'session-start':
        return await sessionStart(sessionId, input, deps);
      case 'post-tool-use':
      case 'heartbeat':
        return await postToolUse(sessionId, deps);
      case 'stop':
        return await stop(sessionId, input, deps, deps.subagent ?? false);
      case 'subagent-stop':
        return await stop(sessionId, input, deps, true);
      case 'pre-compact':
        return await preCompact(sessionId, input, deps);
    }
  } catch {
    // Fail open: unreachable server, auth errors, malformed responses.
    return { code: 0 };
  }
}

type Holdings = {
  session: string | null;
  attempts: Array<{
    id: string;
    nodeKey?: string;
    graph: string;
    own: boolean;
    newDirectives: Directive[];
    pauseRequested: boolean;
    cancelRequested: boolean;
  }>;
  roles: Array<{ graph: string; key: string }>;
};

/** What this Claude session holds: attempts of its session tree and orchestrator roles. */
async function holdings(
  client: AgentGraphsClient,
  sessionId: string,
  options: { roles: boolean; ownership: boolean },
): Promise<Holdings> {
  const hb = await client.clientHeartbeat(sessionId);
  const attempts: Holdings['attempts'] = [];
  for (const a of hb.attempts) {
    let own = true;
    if (options.ownership && hb.session) {
      try {
        const info = await client.getAttempt(a.id);
        own = info.attempt.sessionId === hb.session;
      } catch {
        own = true;
      }
    }
    attempts.push({
      id: a.id,
      ...(a.nodeKey ? { nodeKey: a.nodeKey } : {}),
      graph: a.graph,
      own,
      newDirectives: a.newDirectives ?? [],
      pauseRequested: a.pauseRequested,
      cancelRequested: a.cancelRequested,
    });
  }
  const roles: Holdings['roles'] = [];
  if (options.roles && hb.session) {
    const graphs = await client.listGraphs({ status: 'active,paused,verifying' });
    for (const g of graphs.items.slice(0, 25)) {
      const orchestrators = await client.orchestrators(g.slug ?? g.id);
      for (const o of orchestrators.items)
        if (o.status === 'active' && o.sessionId === hb.session)
          roles.push({ graph: g.slug ?? g.id, key: o.key });
    }
  }
  return { session: hb.session, attempts, roles };
}

function attemptLabel(a: Holdings['attempts'][number]): string {
  return `attempt ${a.id} on ${a.nodeKey ?? 'a node'} (graph ${a.graph})`;
}

async function sessionStart(sessionId: string, input: HookInput, deps: HookDeps) {
  const { client, env } = deps;
  const source = input.source ?? 'startup';
  try {
    const dirs = new Set([
      input.cwd ?? deps.cwd,
      ...(env.CLAUDE_PROJECT_DIR ? [env.CLAUDE_PROJECT_DIR] : []),
    ]);
    for (const dir of dirs) writeClientSession(dir, sessionId, { env, now: deps.now, source });
  } catch {
    // best effort: the MCP server can still take clientSessionId from tool arguments
  }
  if (env.CLAUDE_ENV_FILE) {
    try {
      const line = `export AGENT_GRAPHS_CLIENT_SESSION=${sessionId}\n`;
      let existing = '';
      try {
        existing = readFileSync(env.CLAUDE_ENV_FILE, 'utf8');
      } catch {
        existing = '';
      }
      if (!existing.includes(line)) appendFileSync(env.CLAUDE_ENV_FILE, line);
    } catch {
      // best effort
    }
  }

  const held = await holdings(client, sessionId, { roles: true, ownership: true });
  const parts: string[] = [];
  const own = held.attempts.filter((a) => a.own);
  const dispatched = held.attempts.filter((a) => !a.own);
  const restoring = source === 'compact' || source === 'resume';

  if (held.session && source === 'resume') {
    await client.sessionEvent(held.session, 'resumed', 'SessionStart(resume)').catch(() => {});
  }

  if (own.length || dispatched.length || held.roles.length) {
    if (restoring) {
      parts.push(
        `Agent Graphs: your context was ${source === 'compact' ? 'compacted' : 'resumed'}. Trust these packets over your memory.`,
      );
      for (const a of own) {
        const briefing = await client
          .attemptBriefing(a.id, BRIEFING_BUDGET)
          .catch(() => `(briefing unavailable; call node_briefing {attemptId: "${a.id}"})`);
        parts.push(`You hold ${attemptLabel(a)}. Its briefing:\n\n${briefing}`);
      }
      for (const r of held.roles) {
        const sitrep = await client
          .sitrep(r.graph, { orchestrator: r.key, budget: SITREP_BUDGET })
          .catch(() => `(sitrep unavailable; call graph_sitrep {graph: "${r.graph}"})`);
        parts.push(`You hold the orchestrator role ${r.key} on ${r.graph}. Sitrep:\n\n${sitrep}`);
      }
    } else {
      for (const a of own)
        parts.push(
          `Agent Graphs: you hold ${attemptLabel(a)}. Re-read it with node_briefing {attemptId: "${a.id}"} and finish it before stopping.`,
        );
      for (const r of held.roles)
        parts.push(
          `Agent Graphs: you hold the orchestrator role ${r.key} on ${r.graph}; call graph_sitrep {graph: "${r.graph}", orchestrator: "${r.key}"}.`,
        );
    }
    for (const a of dispatched)
      parts.push(
        `Dispatched ${attemptLabel(a)} is still running; verify it when the subagent returns, and relay and submit on its behalf if it did not report.`,
      );
  } else if (env.AGENT_GRAPHS_GRAPH) {
    const sitrep = await client
      .sitrep(env.AGENT_GRAPHS_GRAPH, { budget: 1200 })
      .catch(() => undefined);
    if (sitrep) parts.push(`Agent Graphs: graph ${env.AGENT_GRAPHS_GRAPH}:\n\n${sitrep}`);
  }
  if (!parts.length) return { code: 0 };
  parts.push(
    `(Agent Graphs clientSessionId for this Claude session: ${sessionId}; the MCP tools and CLI attach it to claims automatically.)`,
  );
  return context('SessionStart', parts.join('\n\n'));
}

async function postToolUse(sessionId: string, deps: HookDeps): Promise<HookResult> {
  const { env, now } = deps;
  if (throttled(env, sessionId, now)) return { code: 0 };
  try {
    stamp(env, sessionId, now);
  } catch {
    // without a stamp we still heartbeat, just more often
  }
  const held = await holdings(deps.client, sessionId, { roles: false, ownership: false });
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const a of held.attempts) {
    for (const d of a.newDirectives) {
      if (seen.has(`${d.id}:${a.id}`)) continue;
      seen.add(`${d.id}:${a.id}`);
      const ack = d.requiresAck
        ? ` → apply it, then directive_ack {directiveId: "${d.id}", attemptId: "${a.id}", note}`
        : '';
      lines.push(
        `- [${a.nodeKey ?? a.id}] ${d.id} · ${d.kind} · ${d.title}${d.body ? `: ${d.body}` : ''}${ack}`,
      );
    }
    if (a.pauseRequested)
      lines.push(
        `- [${a.nodeKey ?? a.id}] Pause requested: checkpoint, write a handoff note, then attempt_release {attemptId: "${a.id}"}.`,
      );
    if (a.cancelRequested)
      lines.push(
        `- [${a.nodeKey ?? a.id}] Cancel requested: stop, write a handoff note, then attempt_release {attemptId: "${a.id}"}.`,
      );
  }
  if (!lines.length) return { code: 0 };
  return context(
    'PostToolUse',
    `Agent Graphs directives (authoritative; they override the prompt where they conflict):\n${lines.join('\n')}`,
  );
}

async function stop(
  sessionId: string,
  input: HookInput,
  deps: HookDeps,
  subagent: boolean,
): Promise<HookResult> {
  const policy = (deps.env.AGENT_GRAPHS_STOP_POLICY ?? 'block').toLowerCase();
  if (policy === 'off') return { code: 0 };
  const held = await holdings(deps.client, sessionId, { roles: false, ownership: subagent });
  const open = subagent ? held.attempts.filter((a) => !a.own) : held.attempts;
  if (!open.length) return { code: 0 };
  if (subagent) {
    return output({
      systemMessage: `Agent Graphs: attempts dispatched from this session are still open: ${open.map(attemptLabel).join('; ')}. Verify each one; relay results with note_add and submit on the subagent's behalf if it did not report.`,
    });
  }
  const reason =
    open.length === 1
      ? `You hold ${attemptLabel(open[0] as Holdings['attempts'][number])}. Submit, fail, block, or release it (with a handoff) before stopping.`
      : `You hold ${open.length} open attempts: ${open.map(attemptLabel).join('; ')}. Submit, fail, block, or release each (with a handoff) before stopping.`;
  if (input.stop_hook_active || policy === 'warn')
    return output({ systemMessage: `Agent Graphs: ${reason}` });
  return output({ decision: 'block', reason });
}

async function preCompact(sessionId: string, input: HookInput, deps: HookDeps) {
  const hb = await deps.client.clientHeartbeat(sessionId);
  if (hb.session)
    await deps.client.sessionEvent(
      hb.session,
      'compacted',
      `PreCompact(${input.trigger ?? 'auto'})`,
    );
  return { code: 0 };
}

/** Is this an "unreachable server" error (for diagnostics in `--verbose`). */
export function isUnreachable(error: unknown): boolean {
  return error instanceof AgentGraphsError && error.code === 'UNREACHABLE';
}

/** A fetch with a timeout, so a hung server cannot stall the agent's tool loop. */
export function timeoutFetch(base: typeof fetch, ms: number): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) =>
    base(input, { ...init, signal: AbortSignal.timeout(ms) })) as typeof fetch;
}
