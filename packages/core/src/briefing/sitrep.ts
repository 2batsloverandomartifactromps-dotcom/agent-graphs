/** Graph-level situation reports for orchestrators (docs/agent-protocol.md §4 Sitrep). */
import { derivedMetric, describeTarget } from '../engine/aims';
import { dutyQueue, isStale } from '../engine/duty';
import { graphAims } from '../engine/state';
import type { DomainEvent, GraphState, Node, Note } from '../engine/types';
import { clip, type Fitted, fitSections, isoMinute, type Section } from './budget';

export const DEFAULT_SITREP_BUDGET = 4000;

export type SitrepInput = {
  state: GraphState;
  now: number;
  /** Prepend this orchestrator's role prompt, aims, latest handoff, and duty queue. */
  orchestratorKey?: string;
  /** Recent events, newest last (the server supplies them). */
  recentEvents?: DomainEvent[];
  /** Orchestrator notes (handoffs) and graph-level notes. */
  notes?: Note[];
  budget?: number;
};

export type Sitrep = Fitted & { markdown: string; budget: number; suggestions: string[] };

const SIGNIFICANT = new Set([
  'graph.started',
  'graph.paused',
  'graph.resumed',
  'graph.verifying',
  'graph.completed',
  'graph.failed',
  'graph.stalled',
  'attempt.passed',
  'attempt.failed',
  'attempt.errored',
  'attempt.abandoned',
  'attempt.blocked',
  'loop.iterated',
  'loop.exhausted',
  'request.created',
  'request.resolved',
  'aim.guard_violated',
  'aim.waived',
  'node.reset',
]);

function minutes(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m < 90 ? `${m}m` : `${(m / 60).toFixed(1)}h`;
}

function describeEvent(state: GraphState, e: DomainEvent): string {
  const key =
    (e.payload.key as string | undefined) ??
    (e.payload.nodeId ? state.nodes.get(e.payload.nodeId as string)?.key : undefined);
  const extra = e.payload.reason ?? e.payload.title ?? e.payload.choice ?? '';
  return `${isoMinute(e.createdAt)} ${e.type}${key ? ` ${key}` : ''}${extra ? ` · ${clip(String(extra), 80)}` : ''}`;
}

export function renderSitrep(input: SitrepInput): Sitrep {
  const { state, now } = input;
  const g = state.graph;
  const budget = input.budget ?? DEFAULT_SITREP_BUDGET;
  const nodes = [...state.nodes.values()];
  const counts = new Map<string, number>();
  for (const n of nodes) counts.set(n.status, (counts.get(n.status) ?? 0) + 1);
  const done = (counts.get('done') ?? 0) + (counts.get('skipped') ?? 0);
  const elapsed = g.startedAt ? minutes((g.completedAt ?? now) - g.startedAt) : 'not started';
  const cost = derivedMetric(state, 'cost_usd') ?? 0;
  const tokens = derivedMetric(state, 'tokens_total') ?? 0;
  const orch = input.orchestratorKey
    ? [...state.orchestrators.values()].find((o) => o.key === input.orchestratorKey)
    : undefined;

  const header = [
    `# Sitrep · ${g.title}${g.slug ? ` (${g.slug})` : ''}`,
    `status ${g.status}${g.stalled ? ' · STALLED' : ''}${g.pendingApproval ? ' · plan awaiting approval' : ''} · elapsed ${elapsed} · revision ${g.revision} · as of ${isoMinute(now)}`,
  ].join('\n');

  const progress = [
    '## Progress',
    `done ${done}/${nodes.length} · ${[...counts.entries()]
      .filter(([s]) => s !== 'done' && s !== 'skipped')
      .map(([s, c]) => `${s} ${c}`)
      .join(' · ')}`,
    `spend $${cost.toFixed(2)} · tokens ${tokens.toLocaleString('en-US')}`,
    `aims: ${graphAims(state)
      .map(
        (a) =>
          `${a.status === 'met' ? '✓' : a.status === 'unmet' ? '✗' : a.status === 'waived' ? '⊘' : '○'} ${a.metric ? describeTarget(a) : a.title}${a.currentValue !== undefined ? ` (now ${a.currentValue})` : ''}${a.guard ? ' [guard]' : ''}`,
      )
      .join(' · ')}`,
  ].join('\n');

  const roleLines: string[] = [];
  if (orch) {
    roleLines.push(`## Your role · ${orch.name} (${orch.role})`);
    if (orch.aim) roleLines.push(`Aim: ${orch.aim}`);
    if (orch.purpose) roleLines.push(`Purpose: ${orch.purpose}`);
    if (orch.prompt) roleLines.push(`Prompt:\n${orch.prompt.trimEnd()}`);
    roleLines.push(`Capabilities: ${orch.capabilities.join(', ') || '(none)'}`);
    const handoff = (input.notes ?? [])
      .filter((n) => n.orchestratorId === orch.id && n.type === 'handoff' && !n.retractedAt)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (handoff)
      roleLines.push(
        `Latest handoff (${isoMinute(handoff.createdAt)}): ${handoff.body ?? handoff.title}`,
      );
  }

  const queue = orch ? dutyQueue(state, orch.id, now) : [];
  const ready = nodes.filter((n) => n.kind === 'task' && n.status === 'ready');
  const openRequests = [...state.requests.values()].filter((r) => r.status === 'open');
  const awaiting = [...state.attempts.values()].filter((a) => a.status === 'submitted');
  const stale = [...state.attempts.values()].filter((a) => isStale(state, a.id, now));
  const queueLines = orch
    ? queue.map((q) => `- [${q.kind}] ${q.title} → ${q.hint}`)
    : [
        ...ready.map(
          (n) =>
            `- [ready] ${n.key} (${n.priority})${n.executor.model ? ` · ${n.executor.model}` : ''}`,
        ),
        ...awaiting.map(
          (a) => `- [awaiting evaluation] ${state.nodes.get(a.nodeId)?.key} attempt ${a.number}`,
        ),
        ...openRequests.map((r) => `- [request · ${r.kind}] ${r.title} (${r.assignee})`),
        ...stale.map(
          (a) => `- [stale lease] ${state.nodes.get(a.nodeId)?.key} attempt ${a.number}`,
        ),
      ];
  const queueTitle = orch ? `## Duty queue · ${queue.length}` : '## Queue';
  const queueLevels = queueLines.length
    ? [
        [queueTitle, ...queueLines].join('\n'),
        [
          queueTitle,
          ...queueLines.slice(0, 8),
          queueLines.length > 8 ? `… ${queueLines.length - 8} more` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      ]
    : [`${queueTitle}\n(empty)`];

  const running = [...state.attempts.values()].filter((a) => a.status === 'running');
  const runningLines = running.map((a) => {
    const n = state.nodes.get(a.nodeId) as Node;
    const who = [a.executor.agent, a.executor.model, a.executor.thinking, a.executor.mechanism]
      .filter(Boolean)
      .join(' · ');
    const hb = minutes(now - (a.lastHeartbeatAt ?? a.startedAt));
    const lease = a.leaseExpiresAt ? minutes(a.leaseExpiresAt - now) : '?';
    return `- ${n.key} #${a.number} · ${who || a.executor.kind} · ${a.progress ?? 0}%${a.currentStep ? ` · ${clip(a.currentStep, 60)}` : ''} · heartbeat ${hb} ago · lease ${lease} left${a.dispatchedBy?.orchestratorKey ? ` · via ${a.dispatchedBy.orchestratorKey}` : ''}`;
  });
  const runningLevels = running.length
    ? [
        ['## Running', ...runningLines].join('\n'),
        `## Running\n${running.map((a) => `${state.nodes.get(a.nodeId)?.key} ${a.progress ?? 0}%`).join(' · ')}`,
      ]
    : [''];

  const loopLines = state.loops.map(
    (l) => `${l.key} ↺ ${l.iteration}/${l.maxIterations + l.grantedIterations} ${l.status}`,
  );
  const loopLevels = loopLines.length ? [`## Loops\n${loopLines.join(' · ')}`, ''] : [''];

  const events = (input.recentEvents ?? []).filter((e) => SIGNIFICANT.has(e.type)).slice(-15);
  const eventLevels = events.length
    ? [
        ['## Recent', ...events.map((e) => `- ${describeEvent(state, e)}`)].join('\n'),
        ['## Recent', ...events.slice(-5).map((e) => `- ${describeEvent(state, e)}`)].join('\n'),
        '',
      ]
    : [''];

  const suggestions = suggest(
    state,
    orch?.capabilities ?? ['dispatch', 'evaluate', 'resolve', 'approve'],
    {
      ready,
      stale: stale.map((a) => state.nodes.get(a.nodeId)?.key ?? a.id),
      awaiting: awaiting.length,
      requests: openRequests.filter((r) => r.assignee !== 'human').length,
      humanRequests: openRequests.filter((r) => r.assignee === 'human').length,
    },
  );
  const suggestText = suggestions.length
    ? ['## Suggested next actions', ...suggestions.map((s, i) => `${i + 1}. ${s}`)].join('\n')
    : '';

  const sections: Section[] = [
    { id: 'header', title: 'Header', priority: 1, fixed: true, levels: [header] },
    { id: 'progress', title: 'Progress', priority: 2, fixed: true, levels: [progress] },
    {
      id: 'role',
      title: 'Role',
      priority: 3,
      levels: roleLines.length ? [roleLines.join('\n'), roleLines.slice(0, 1).join('\n')] : [''],
    },
    {
      id: 'suggestions',
      title: 'Suggested next actions',
      priority: 4,
      fixed: true,
      levels: [suggestText],
    },
    { id: 'queue', title: 'Queue', priority: 5, levels: queueLevels },
    { id: 'running', title: 'Running', priority: 6, levels: runningLevels },
    { id: 'loops', title: 'Loops', priority: 7, levels: loopLevels },
    { id: 'recent', title: 'Recent', priority: 8, levels: eventLevels },
  ];
  const fitted = fitSections(sections, budget);
  return {
    ...fitted,
    markdown: fitted.sections
      .map((s) => s.text)
      .filter(Boolean)
      .join('\n\n'),
    budget,
    suggestions,
  };
}

/** Rule-based next actions for orchestrators. */
function suggest(
  state: GraphState,
  capabilities: string[],
  facts: {
    ready: Node[];
    stale: string[];
    awaiting: number;
    requests: number;
    humanRequests: number;
  },
): string[] {
  const out: string[] = [];
  const g = state.graph;
  const can = (c: string) => capabilities.includes(c);
  if (g.status === 'draft')
    out.push(
      g.pendingApproval
        ? 'Wait for a human to approve the plan.'
        : 'Start the graph when the plan is ready.',
    );
  if (g.status === 'paused')
    out.push('The graph is paused: resolve the guard or pause reason, then resume.');
  if (g.stalled)
    out.push('The graph is stalled: resolve the escalation or blocker that holds it (see Queue).');
  if (g.status === 'active' && can('dispatch') && facts.ready.length > 0) {
    const max = g.policy.maxParallel;
    const running = [...state.attempts.values()].filter((a) => a.status === 'running').length;
    const slots = max === null ? facts.ready.length : Math.max(0, max - running);
    const pick = facts.ready.slice(0, Math.min(slots, 3));
    if (pick.length) {
      out.push(
        `Dispatch ${pick.map((n) => `${n.key}${n.executor.model ? ` (${n.executor.model}${n.executor.thinking ? ` · ${n.executor.thinking}` : ''})` : ''}`).join(', ')}.`,
      );
    } else out.push(`maxParallel (${max}) reached: wait for running attempts.`);
  }
  if (facts.stale.length) out.push(`Check on ${facts.stale.join(', ')}: no recent heartbeat.`);
  if (can('evaluate') && facts.awaiting > 0)
    out.push(`${facts.awaiting} submitted attempt(s) await evaluation.`);
  if ((can('resolve') || can('approve')) && facts.requests > 0)
    out.push(`${facts.requests} open request(s) can be resolved by orchestrators.`);
  if (facts.humanRequests > 0)
    out.push(`${facts.humanRequests} request(s) wait on a human (Inbox).`);
  if (g.status === 'verifying')
    out.push('Verifying: report graph-level metrics and make sure each graph aim has evidence.');
  if (g.status === 'completed') out.push('The graph is complete: write a final handoff note.');
  return out.slice(0, 6);
}
