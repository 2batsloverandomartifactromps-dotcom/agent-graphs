/**
 * Read models (docs/data-model.md § Read models): GraphSummary, GraphView, NodeDetail, and the
 * compact snapshots carried by SSE messages. `toApi` converts epoch-ms `…At` fields to ISO.
 */
import { engine, type GraphState, type Node, type Note } from '@agent-graphs/core';

const TIME_KEYS = /At$/;

/** Deep-convert `…At` epoch-ms numbers to ISO-8601 strings for API responses. */
export function toApi<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => toApi(v)) as T;
  if (value instanceof Map) return [...value.values()].map((v) => toApi(v)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = typeof v === 'number' && TIME_KEYS.test(k) ? new Date(v).toISOString() : toApi(v);
    }
    return out as T;
  }
  return value;
}

export function statusCounts(state: GraphState): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const n of state.nodes.values()) counts[n.status] = (counts[n.status] ?? 0) + 1;
  return counts;
}

function annotationOf(a: { executor: Record<string, unknown> }) {
  const { agent, model, thinking, provider, mechanism, kind } = a.executor as Record<
    string,
    string
  >;
  return { kind, agent, model, thinking, provider, mechanism };
}

export function graphSummary(state: GraphState) {
  const g = state.graph;
  const counts = statusCounts(state);
  const total = state.nodes.size;
  const done = (counts.done ?? 0) + (counts.skipped ?? 0);
  const aims = engine.graphAims(state);
  const running = [...state.attempts.values()].filter((a) => a.status === 'running');
  return {
    id: g.id,
    slug: g.slug,
    title: g.title,
    description: g.description,
    status: g.status,
    stalled: g.stalled,
    pendingApproval: g.pendingApproval,
    acceptedWithDeviation: g.acceptedWithDeviation,
    tags: g.tags,
    revision: g.revision,
    counts,
    total,
    progress: total === 0 ? 0 : done / total,
    aims: {
      met: aims.filter((a) => a.status === 'met' || a.status === 'waived').length,
      total: aims.length,
    },
    agents: running.map((a) => ({
      attemptId: a.id,
      nodeKey: state.nodes.get(a.nodeId)?.key,
      ...annotationOf(a),
    })),
    openRequests: [...state.requests.values()].filter((r) => r.status === 'open').length,
    costUsd: engine.derivedMetric(state, 'cost_usd') ?? 0,
    loops: state.loops.map((l) => ({
      key: l.key,
      iteration: l.iteration,
      max: l.maxIterations + l.grantedIterations,
      status: l.status,
    })),
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
    startedAt: g.startedAt,
    completedAt: g.completedAt,
    archivedAt: g.archivedAt,
    lastActivityAt: g.lastActivityAt,
  };
}

export function attemptSummary(state: GraphState, id: string | undefined) {
  if (!id) return undefined;
  const a = state.attempts.get(id);
  if (!a) return undefined;
  return {
    id: a.id,
    number: a.number,
    activation: a.activation,
    status: a.status,
    counted: a.counted,
    executor: a.executor,
    dispatchedBy: a.dispatchedBy,
    progress: a.progress,
    currentStep: a.currentStep,
    leaseExpiresAt: a.leaseExpiresAt,
    lastHeartbeatAt: a.lastHeartbeatAt,
    usage: a.usage,
    summary: a.summary,
    outcomeReason: a.outcomeReason,
    manual: a.manual,
    startedAt: a.startedAt,
    submittedAt: a.submittedAt,
    endedAt: a.endedAt,
  };
}

export function nodeSummary(state: GraphState, node: Node) {
  const aims = engine.aimsOf(state, 'node', node.id);
  const loop = engine.loopsContaining(state, node.id)[0];
  const trigger = engine.loopTriggeredBy(state, node.id);
  const current = node.currentAttemptId ?? engine.openAttempt(state, node.id)?.id;
  return {
    id: node.id,
    key: node.key,
    title: node.title,
    kind: node.kind,
    aim: node.aim,
    status: node.status,
    statusReason: node.statusReason,
    priority: node.priority,
    tags: node.tags,
    executor: node.executor,
    activation: node.activation,
    countedAttempts: node.countedAttempts,
    maxAttempts: node.maxAttempts + node.grantedAttempts,
    attemptsTotal: node.attemptsTotal,
    acceptedWithDeviation: node.acceptedWithDeviation,
    manual: node.manual,
    parentId: node.parentId,
    position: node.position,
    aims: aims.map((a) => ({
      key: a.key,
      title: a.title,
      kind: a.kind,
      terminating: a.terminating,
      status: a.status,
      metric: a.metric,
      comparator: a.comparator,
      target: a.target,
      currentValue: a.currentValue,
      evaluator: a.evaluator,
      implicit: a.implicit,
    })),
    loop: loop
      ? {
          key: loop.key,
          iteration: loop.iteration,
          max: loop.maxIterations + loop.grantedIterations,
        }
      : undefined,
    triggersLoop: trigger?.key,
    currentAttempt: attemptSummary(state, current),
    openRequests: [...state.requests.values()].filter(
      (r) => r.nodeId === node.id && r.status === 'open',
    ).length,
    readyAt: node.readyAt,
    startedAt: node.startedAt,
    completedAt: node.completedAt,
    updatedAt: node.updatedAt,
  };
}

export function graphView(state: GraphState) {
  const keyOf = (id: string) => state.nodes.get(id)?.key;
  return {
    graph: {
      ...state.graph,
      ...graphSummary(state),
    },
    aims: engine.graphAims(state),
    nodes: [...state.nodes.values()]
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map((n) => nodeSummary(state, n)),
    edges: state.edges.map((e) => ({ ...e, from: keyOf(e.fromNodeId), to: keyOf(e.toNodeId) })),
    loops: state.loops.map((l) => ({
      ...l,
      from: keyOf(l.fromNodeId),
      to: keyOf(l.toNodeId),
      bodyKeys: l.body.map(keyOf),
    })),
    orchestrators: [...state.orchestrators.values()].map((o) => ({
      ...o,
      aims: engine.aimsOf(state, 'orchestrator', o.id),
    })),
    requests: [...state.requests.values()].filter((r) => r.status === 'open'),
    criticalPath: criticalPathKeys(state),
  };
}

function criticalPathKeys(state: GraphState): string[] {
  const weights = engine.criticalWeights(state);
  const succ = (id: string) => engine.requiresSuccessors(state, id);
  const preds = new Set(state.edges.filter((e) => e.kind === 'requires').map((e) => e.toNodeId));
  let current = [...state.nodes.values()]
    .filter((n) => !preds.has(n.id))
    .sort((a, b) => (weights.get(b.id) ?? 0) - (weights.get(a.id) ?? 0))[0];
  const path: string[] = [];
  while (current) {
    path.push(current.key);
    current = succ(current.id).sort(
      (a, b) => (weights.get(b.id) ?? 0) - (weights.get(a.id) ?? 0),
    )[0];
  }
  return path;
}

export function nodeDetail(state: GraphState, node: Node, notes: Note[]) {
  const keyOf = (id: string) => state.nodes.get(id)?.key;
  return {
    ...nodeSummary(state, node),
    purpose: node.purpose,
    prompt: node.prompt,
    context: node.context,
    deliverables: node.deliverables,
    checklist: node.checklist,
    aimMode: node.aimMode,
    gate: node.gate,
    onExhausted: node.onExhausted,
    leaseTtlSec: node.leaseTtlSec,
    timeoutSec: node.timeoutSec,
    metadata: node.metadata,
    feedback: node.feedback,
    version: node.version,
    aims: engine.aimsOf(state, 'node', node.id),
    attempts: engine.attemptsOf(state, node.id).map((a) => ({
      ...a,
      evaluations: state.evaluations.filter((e) => e.attemptId === a.id),
      metrics: state.metrics.filter((m) => m.attemptId === a.id),
    })),
    evaluations: state.evaluations.filter((e) => {
      const aim = state.aims.get(e.aimId);
      return aim?.ownerType === 'node' && aim.ownerId === node.id && !e.attemptId;
    }),
    needs: state.edges
      .filter((e) => e.toNodeId === node.id)
      .map((e) => ({ ...e, from: keyOf(e.fromNodeId), to: node.key })),
    dependents: state.edges
      .filter((e) => e.fromNodeId === node.id)
      .map((e) => ({ ...e, from: node.key, to: keyOf(e.toNodeId) })),
    requests: [...state.requests.values()].filter((r) => r.nodeId === node.id),
    directives: [...state.directives.values()].filter(
      (d) =>
        (d.targetType === 'node' && d.targetId === node.id) ||
        (d.targetType === 'attempt' && state.attempts.get(d.targetId)?.nodeId === node.id),
    ),
    notes,
  };
}

/** Compact entity snapshot for an SSE message. */
export function snapshotFor(
  state: GraphState | undefined,
  entityType: string,
  entityId: string,
): unknown {
  if (!state) return undefined;
  switch (entityType) {
    case 'graph':
      return graphSummary(state);
    case 'node': {
      const node = state.nodes.get(entityId);
      return node ? nodeSummary(state, node) : undefined;
    }
    case 'attempt': {
      const a = attemptSummary(state, entityId);
      return a
        ? { ...a, nodeKey: state.nodes.get(state.attempts.get(entityId)?.nodeId ?? '')?.key }
        : undefined;
    }
    case 'request':
      return state.requests.get(entityId);
    case 'directive':
      return state.directives.get(entityId);
    case 'loop':
      return state.loops.find((l) => l.id === entityId);
    case 'aim':
      return state.aims.get(entityId);
    case 'orchestrator':
      return state.orchestrators.get(entityId);
    default:
      return undefined;
  }
}
