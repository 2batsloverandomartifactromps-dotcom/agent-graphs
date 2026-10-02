/** Aim evaluation: comparators, aggregation, derived metrics (docs/concepts.md §6). */
import type { Aggregation, Comparator, Verdict } from '../vocabulary';
import type { Aim, Attempt, GraphState, Node } from './types';

const EPSILON = 1e-9;

export function compare(
  comparator: Comparator,
  value: number,
  target: number,
  targetMax?: number,
): boolean {
  switch (comparator) {
    case 'gte':
      return value >= target;
    case 'gt':
      return value > target;
    case 'lte':
      return value <= target;
    case 'lt':
      return value < target;
    case 'eq':
      return Math.abs(value - target) <= EPSILON;
    case 'neq':
      return Math.abs(value - target) > EPSILON;
    case 'between':
      return value >= target && value <= (targetMax ?? Number.POSITIVE_INFINITY);
  }
}

export function aggregate(values: number[], aggregation: Aggregation): number | undefined {
  if (values.length === 0) return undefined;
  switch (aggregation) {
    case 'latest':
      return values[values.length - 1];
    case 'min':
      return Math.min(...values);
    case 'max':
      return Math.max(...values);
    case 'avg':
      return values.reduce((s, v) => s + v, 0) / values.length;
    case 'sum':
      return values.reduce((s, v) => s + v, 0);
  }
}

/** The verdict for a quantitative aim at a given value (undefined → no verdict yet). */
export function quantitativeVerdict(aim: Aim, value: number | undefined): Verdict | undefined {
  if (value === undefined || aim.comparator === undefined || aim.target === undefined) {
    return undefined;
  }
  return compare(aim.comparator, value, aim.target, aim.targetMax) ? 'met' : 'unmet';
}

function attemptsInScope(state: GraphState, node?: Node): Attempt[] {
  const all = [...state.attempts.values()];
  return node ? all.filter((a) => a.nodeId === node.id) : all;
}

/** Server-computed metrics (concepts §6.3). Unknown names return undefined. */
export function derivedMetric(state: GraphState, name: string, node?: Node): number | undefined {
  switch (name) {
    case 'nodes_done_ratio': {
      const nodes = [...state.nodes.values()];
      if (nodes.length === 0) return 1;
      const done = nodes.filter((n) => n.status === 'done' || n.status === 'skipped').length;
      return done / nodes.length;
    }
    case 'cost_usd':
      return attemptsInScope(state, node).reduce((s, a) => s + (a.usage?.costUsd ?? 0), 0);
    case 'tokens_total':
      return attemptsInScope(state, node).reduce(
        (s, a) =>
          s +
          (a.usage?.inputTokens ?? 0) +
          (a.usage?.outputTokens ?? 0) +
          (a.usage?.cacheReadTokens ?? 0) +
          (a.usage?.cacheWriteTokens ?? 0),
        0,
      );
    case 'elapsed_hours': {
      const start = state.graph.startedAt;
      if (start === undefined) return 0;
      const end = state.graph.completedAt ?? state.graph.lastActivityAt;
      return Math.max(0, end - start) / 3_600_000;
    }
    case 'failed_attempts':
      return attemptsInScope(state, node).filter((a) => a.counted).length;
    case 'open_findings_high':
      return state.openHighFindings ?? 0;
    case 'children_done_ratio': {
      if (!node) return undefined;
      const children = [...state.nodes.values()].filter((n) => n.parentId === node.id);
      if (children.length === 0) return 1;
      return (
        children.filter((n) => n.status === 'done' || n.status === 'skipped').length /
        children.length
      );
    }
    default:
      return undefined;
  }
}

/**
 * The current value of a quantitative aim. Node aims read the given attempt's reports (or the
 * node's derived metric); graph aims read graph-level reports or graph derived metrics.
 */
export function aimValue(state: GraphState, aim: Aim, attempt?: Attempt): number | undefined {
  if (aim.metric === undefined) return undefined;
  const node = aim.ownerType === 'node' ? state.nodes.get(aim.ownerId) : undefined;
  if (aim.source === 'derived') return derivedMetric(state, aim.metric, node);
  const reports = state.metrics.filter((m) => {
    if (m.name !== aim.metric) return false;
    if (aim.ownerType === 'node') {
      return attempt ? m.attemptId === attempt.id : m.nodeId === aim.ownerId;
    }
    return m.nodeId === undefined && m.attemptId === undefined;
  });
  reports.sort((a, b) => a.recordedAt - b.recordedAt);
  return aggregate(
    reports.map((r) => r.value),
    aim.aggregation,
  );
}

/** Verdicts recorded for an attempt (latest per aim), plus waivers in its activation. */
export function attemptVerdicts(state: GraphState, attempt: Attempt): Map<string, Verdict> {
  const verdicts = new Map<string, Verdict>();
  for (const ev of state.evaluations) {
    const aim = state.aims.get(ev.aimId);
    if (aim?.ownerType !== 'node' || aim.ownerId !== attempt.nodeId) continue;
    if (ev.attemptId === attempt.id) verdicts.set(ev.aimId, ev.verdict);
    else if (
      ev.attemptId === undefined &&
      ev.verdict === 'waived' &&
      ev.activation === attempt.activation
    ) {
      verdicts.set(ev.aimId, 'waived');
    }
  }
  return verdicts;
}

/** Verdicts recorded without an attempt in the node's current activation (gates, milestones). */
export function activationVerdicts(state: GraphState, node: Node): Map<string, Verdict> {
  const verdicts = new Map<string, Verdict>();
  for (const ev of state.evaluations) {
    const aim = state.aims.get(ev.aimId);
    if (aim?.ownerType !== 'node' || aim.ownerId !== node.id) continue;
    if (ev.attemptId === undefined && ev.activation === node.activation) {
      verdicts.set(ev.aimId, ev.verdict);
    }
  }
  return verdicts;
}

export type AimDecision = 'satisfied' | 'unsatisfied' | 'pending';

/** Combine terminating verdicts per aimMode, with the §6.5 short-circuits. */
export function decide(
  aimMode: 'all' | 'any',
  terminating: Aim[],
  verdicts: Map<string, Verdict>,
): AimDecision {
  const ok = (v?: Verdict) => v === 'met' || v === 'waived';
  const bad = (v?: Verdict) => v === 'unmet' || v === 'partial';
  const vs = terminating.map((a) => verdicts.get(a.id));
  if (aimMode === 'all') {
    if (vs.some(bad)) return 'unsatisfied';
    return vs.every(ok) ? 'satisfied' : 'pending';
  }
  if (vs.some(ok)) return 'satisfied';
  if (vs.length === 0) return 'satisfied';
  return vs.every((v) => v !== undefined) ? 'unsatisfied' : 'pending';
}

export function isExternal(aim: Aim): boolean {
  return (
    aim.kind === 'qualitative' &&
    (aim.evaluator === 'agent' || aim.evaluator === 'orchestrator' || aim.evaluator === 'human')
  );
}

export function describeTarget(aim: Aim): string {
  if (aim.metric === undefined) return aim.title;
  const ops: Record<Comparator, string> = {
    gte: '≥',
    gt: '>',
    lte: '≤',
    lt: '<',
    eq: '=',
    neq: '≠',
    between: 'in',
  };
  if (aim.comparator === 'between') return `${aim.metric} in [${aim.target}, ${aim.targetMax}]`;
  return `${aim.metric} ${ops[aim.comparator ?? 'gte']} ${aim.target}`;
}
