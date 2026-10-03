/**
 * Minimal REST driver for the E2E suite: plays agents and orchestrators against the real server
 * (claim, heartbeat, submit, evaluate, fail, ack) so the UI shows live changes.
 */
export const API = process.env.E2E_API_URL ?? 'http://127.0.0.1:4747';

type Json = Record<string, unknown>;

export async function call<T = Json>(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const res = await fetch(`${API}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

export const actors = {
  builder: {
    kind: 'agent',
    agent: 'api-builder',
    model: 'claude-opus-5-5',
    thinking: 'high',
    provider: 'anthropic',
    mechanism: 'claude-code',
  },
  writer: {
    kind: 'agent',
    agent: 'doc-writer',
    model: 'claude-haiku-4-5',
    thinking: 'low',
    provider: 'anthropic',
    mechanism: 'claude-code',
  },
  ui: {
    kind: 'agent',
    agent: 'ui-builder',
    model: 'claude-sonnet-5-5',
    thinking: 'medium',
    provider: 'anthropic',
    mechanism: 'claude-code-web',
  },
  migrator: {
    kind: 'agent',
    agent: 'migrator',
    model: 'gpt-5',
    thinking: 'high',
    provider: 'openai',
    mechanism: 'api',
  },
} as const;

export async function createGraph(
  yaml: string,
  start = true,
): Promise<{ graph: { id: string; slug?: string } }> {
  return call('POST', `/graphs${start ? '?start=true' : ''}`, { format: 'yaml', spec: yaml });
}

export async function claim(graph: string, node: string, actor: Json): Promise<string> {
  const out = await call<{ attempt: { id: string } }>(
    'POST',
    `/graphs/${graph}/nodes/${node}/claim`,
    { actor },
  );
  return out.attempt.id;
}

export function heartbeat(attempt: string, body: Json) {
  return call('POST', `/attempts/${attempt}/heartbeat`, body);
}

export function submit(attempt: string, body: Json) {
  return call<{ outcome: string }>('POST', `/attempts/${attempt}/submit`, body);
}

export function evaluate(
  attempt: string,
  aim: string,
  verdict: 'met' | 'unmet' | 'partial',
  rationale = 'Reviewed',
) {
  return call('POST', `/attempts/${attempt}/evaluations`, { aim, verdict, rationale });
}

export function failAttempt(attempt: string, reason: string, retryable?: boolean) {
  return call('POST', `/attempts/${attempt}/fail`, {
    reason,
    ...(retryable !== undefined ? { retryable } : {}),
  });
}

export function block(attempt: string, reason: string, title: string, body?: string) {
  return call('POST', `/attempts/${attempt}/block`, {
    reason,
    request: { title, ...(body ? { body } : {}) },
  });
}

export function note(attempt: string, body: Json) {
  return call('POST', `/attempts/${attempt}/notes`, body);
}

export async function node(
  graph: string,
  key: string,
): Promise<
  Json & {
    status: string;
    aims: Array<{ key: string; evaluator: string; kind: string; terminating: boolean }>;
  }
> {
  return call('GET', `/graphs/${graph}/nodes/${key}`);
}

export async function openRequests(
  graph?: string,
): Promise<Array<{ id: string; subject: string; kind: string; nodeId?: string; title: string }>> {
  const out = await call<{
    items: Array<{ id: string; subject: string; kind: string; nodeId?: string; title: string }>;
  }>('GET', `/requests?status=open${graph ? `&graph=${graph}` : ''}`);
  return out.items;
}

export async function resolve(id: string, body: Json) {
  return call('POST', `/requests/${id}/resolve`, body);
}

export async function directives(graph: string): Promise<
  Array<{
    id: string;
    kind: string;
    status: string;
    targetType: string;
    targetId: string;
    title: string;
  }>
> {
  const out = await call<{
    items: Array<{
      id: string;
      kind: string;
      status: string;
      targetType: string;
      targetId: string;
      title: string;
    }>;
  }>('GET', `/graphs/${graph}/directives`);
  return out.items;
}

export function ack(directive: string, attemptId: string, noteText: string) {
  return call('POST', `/directives/${directive}/ack`, { attemptId, note: noteText });
}

/**
 * Complete a task node end to end: claim, report progress, submit with self verdicts and
 * metric values for every terminating aim, and judge externally evaluated aims as an admin.
 */
export async function completeTask(
  graph: string,
  key: string,
  actor: Json = actors.builder,
): Promise<string> {
  const detail = await node(graph, key);
  const attempt = await claim(graph, key, actor);
  await heartbeat(attempt, { progress: 50, step: `Working on ${key}` });
  const aims = detail.aims as Array<{
    key: string;
    kind: string;
    evaluator: string;
    metric?: string;
    comparator?: string;
    target?: number;
    terminating: boolean;
    source?: string;
  }>;
  const metrics: Record<string, number> = {};
  const evaluations: Json[] = [];
  for (const a of aims) {
    if (a.kind === 'quantitative' && a.metric && a.source !== 'derived')
      metrics[a.metric] = passingValue(a);
    if (a.kind === 'qualitative' && a.evaluator === 'self')
      evaluations.push({ aim: a.key, verdict: 'met', rationale: 'Done and verified.' });
  }
  await submit(attempt, {
    summary: `Completed ${key}.`,
    metrics,
    evaluations,
    usage: { inputTokens: 120000, outputTokens: 8000, costUsd: 0.85 },
    notes: [
      {
        type: 'proof',
        title: `${key}: checks pass`,
        evidence: [
          { kind: 'command', value: 'pnpm test', meta: { exitCode: 0, output: 'all passed' } },
        ],
      },
    ],
  });
  for (const a of aims) {
    if (a.kind === 'qualitative' && (a.evaluator === 'orchestrator' || a.evaluator === 'agent'))
      await evaluate(attempt, a.key, 'met');
  }
  return attempt;
}

function passingValue(a: { comparator?: string; target?: number }): number {
  const t = a.target ?? 1;
  switch (a.comparator) {
    case 'lte':
    case 'eq':
      return t;
    case 'lt':
      return t - 1;
    case 'gt':
      return t + 1;
    default:
      return t;
  }
}

export async function approveGateViaApi(graph: string, nodeKey: string) {
  const n = await node(graph, nodeKey);
  const req = (await openRequests(graph)).find((r) => r.nodeId === n.id);
  if (!req) throw new Error(`no open request for ${nodeKey}`);
  return resolve(req.id, { choice: 'approve' });
}
