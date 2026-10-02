/** Work selection for `POST /graphs/{g}/next` (worker and reviewer roles). */
import { buildAdjacency, criticalPathWeights } from '../graph/algorithms';
import type { ExecutionAnnotation } from '../schemas/common';
import { attemptVerdicts } from './aims';
import { missingSkills } from './attempts';
import { aimsOf, runningCount } from './state';
import type { Aim, Attempt, GraphState, Node } from './types';

export type NextResult =
  | { kind: 'node'; node: Node }
  | { kind: 'evaluation'; attempt: Attempt; node: Node; aims: Aim[] }
  | { kind: 'none'; reason: string; waitingOn: string[] };

const PRIORITY_RANK = { p0: 0, p1: 1, p2: 2, p3: 3 } as const;

export function criticalWeights(state: GraphState): Map<string, number> {
  const adjacency = buildAdjacency(
    [...state.nodes.keys()],
    state.edges
      .filter((e) => e.kind === 'requires')
      .map((e) => ({ from: e.fromNodeId, to: e.toNodeId })),
  );
  return criticalPathWeights(adjacency);
}

/** Ready tasks the caller may claim, best first: priority, critical path, then age. */
export function rankReadyNodes(state: GraphState, skills: string[] = []): Node[] {
  const weights = criticalWeights(state);
  return [...state.nodes.values()]
    .filter(
      (n) => n.kind === 'task' && n.status === 'ready' && missingSkills(n, skills).length === 0,
    )
    .sort(
      (a, b) =>
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
        (weights.get(b.id) ?? 0) - (weights.get(a.id) ?? 0) ||
        (a.readyAt ?? 0) - (b.readyAt ?? 0) ||
        a.key.localeCompare(b.key),
    );
}

/** Submitted attempts awaiting `agent` verdicts that this caller is independent from. */
export function pendingAgentEvaluations(
  state: GraphState,
  actor?: ExecutionAnnotation,
): Array<{ attempt: Attempt; node: Node; aims: Aim[] }> {
  const out: Array<{ attempt: Attempt; node: Node; aims: Aim[] }> = [];
  for (const attempt of state.attempts.values()) {
    if (attempt.status !== 'submitted') continue;
    if (actor?.sessionId && attempt.executor.sessionId === actor.sessionId) continue;
    const verdicts = attemptVerdicts(state, attempt);
    const aims = aimsOf(state, 'node', attempt.nodeId).filter(
      (a) => a.kind === 'qualitative' && a.evaluator === 'agent' && !verdicts.has(a.id),
    );
    if (aims.length > 0) out.push({ attempt, node: state.nodes.get(attempt.nodeId) as Node, aims });
  }
  return out.sort((a, b) => (a.attempt.submittedAt ?? 0) - (b.attempt.submittedAt ?? 0));
}

export function pickNext(
  state: GraphState,
  input: { role?: 'worker' | 'reviewer'; skills?: string[]; actor?: ExecutionAnnotation } = {},
): NextResult {
  const g = state.graph;
  if (input.role === 'reviewer') {
    const first = pendingAgentEvaluations(state, input.actor)[0];
    if (first) return { kind: 'evaluation', ...first };
    return {
      kind: 'none',
      reason: 'No submitted attempts await an independent agent verdict.',
      waitingOn: [],
    };
  }
  if (g.status !== 'active') {
    return { kind: 'none', reason: `Graph is ${g.status}.`, waitingOn: [] };
  }
  const nodes = [...state.nodes.values()];
  const ranked = rankReadyNodes(state, input.skills);
  if (
    g.policy.maxParallel !== null &&
    runningCount(state) >= g.policy.maxParallel &&
    ranked.length > 0
  ) {
    return {
      kind: 'none',
      reason: `maxParallel (${g.policy.maxParallel}) attempts are running.`,
      waitingOn: nodes.filter((n) => n.status === 'running').map((n) => n.key),
    };
  }
  const best = ranked[0];
  if (best) return { kind: 'node', node: best };
  const skillGated = nodes.filter(
    (n) => n.kind === 'task' && n.status === 'ready' && missingSkills(n, input.skills).length > 0,
  );
  if (skillGated.length > 0) {
    return {
      kind: 'none',
      reason: `Ready nodes need skills you did not declare: ${[...new Set(skillGated.flatMap((n) => missingSkills(n, input.skills)))].join(', ')}.`,
      waitingOn: skillGated.map((n) => n.key),
    };
  }
  const busy = nodes.filter((n) =>
    ['running', 'evaluating', 'needs_input', 'blocked'].includes(n.status),
  );
  return {
    kind: 'none',
    reason:
      busy.length > 0
        ? 'No ready nodes; waiting on in-flight work or decisions.'
        : 'No ready nodes.',
    waitingOn: busy.map((n) => `${n.key} (${n.status})`),
  };
}
