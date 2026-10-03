/**
 * Adapters from specs and GraphViews to canvas inputs. The New-graph preview renders a
 * normalized spec (from POST /graphs/validate) with the same canvas as a live graph.
 */
import { buildAdjacency, loopBody, type NormalizedSpec } from '@agent-graphs/core';
import type { Edge, GraphView, Loop, NodeSummary } from '@agent-graphs/sdk';
import type { LayoutInput } from './layout';

export function specToLayoutInput(spec: NormalizedSpec): LayoutInput {
  const edges = spec.nodes.flatMap((n) => [
    ...n.needs.map((r) => ({ from: r.key, to: n.key, kind: 'requires' as const })),
    ...n.informedBy.map((r) => ({ from: r.key, to: n.key, kind: 'informs' as const })),
  ]);
  const adj = buildAdjacency(
    spec.nodes.map((n) => n.key),
    edges.filter((e) => e.kind === 'requires'),
  );
  return {
    nodes: spec.nodes.map((n) => ({ key: n.key, kind: n.kind })),
    edges,
    loops: spec.loops.map((l) => ({
      key: l.key,
      from: l.from,
      to: l.to,
      body: [...(loopBody(l.from, l.to, adj) ?? new Set([l.from, l.to]))],
    })),
  };
}

export function viewToLayoutInput(view: Pick<GraphView, 'nodes' | 'edges' | 'loops'>): LayoutInput {
  const keyById = new Map(view.nodes.map((n) => [n.id, n.key]));
  return {
    nodes: view.nodes.map((n) => ({ key: n.key, kind: n.kind })),
    edges: view.edges
      .map((e) => ({
        from: e.from ?? keyById.get(e.fromNodeId) ?? '',
        to: e.to ?? keyById.get(e.toNodeId) ?? '',
        kind: e.kind,
      }))
      .filter((e) => e.from && e.to),
    loops: view.loops.map((l) => ({
      key: l.key,
      from: l.from ?? keyById.get(l.fromNodeId) ?? '',
      to: l.to ?? keyById.get(l.toNodeId) ?? '',
      body: (l.bodyKeys ?? l.body.map((id) => keyById.get(id) ?? id)).filter(Boolean) as string[],
    })),
  };
}

/** A read-only GraphView for previewing a spec before it exists on the server. */
export function specToPreviewView(spec: NormalizedSpec): GraphView {
  const now = new Date().toISOString();
  const layout = specToLayoutInput(spec);
  const nodes: NodeSummary[] = spec.nodes.map((n) => ({
    id: `preview:${n.key}`,
    key: n.key,
    title: n.title,
    kind: n.kind,
    ...(n.aim ? { aim: n.aim } : {}),
    status: 'pending',
    priority: n.priority,
    tags: n.tags,
    executor: n.executor,
    activation: 1,
    countedAttempts: 0,
    maxAttempts: n.maxAttempts,
    attemptsTotal: 0,
    acceptedWithDeviation: false,
    manual: false,
    aims: n.aims.map((a) => ({
      key: a.key,
      title: a.title,
      kind: a.kind,
      terminating: a.terminating,
      status: 'pending' as const,
      ...(a.metric ? { metric: a.metric } : {}),
      ...(a.comparator ? { comparator: a.comparator } : {}),
      ...(a.target !== undefined ? { target: a.target } : {}),
      evaluator: a.evaluator,
      implicit: false,
    })),
    ...(n.gate ? {} : {}),
    openRequests: 0,
    updatedAt: now,
  }));
  const edges: Edge[] = layout.edges.map((e, i) => ({
    id: `preview-edge-${i}`,
    graphId: 'preview',
    fromNodeId: `preview:${e.from}`,
    toNodeId: `preview:${e.to}`,
    kind: e.kind as Edge['kind'],
    attrProvenance: {},
    version: 1,
    createdAt: now,
    updatedAt: now,
    from: e.from,
    to: e.to,
  }));
  const loops: Loop[] = layout.loops.map((l) => {
    const spec_ = spec.loops.find((x) => x.key === l.key);
    return {
      id: `preview-loop-${l.key}`,
      graphId: 'preview',
      key: l.key,
      fromNodeId: `preview:${l.from}`,
      toNodeId: `preview:${l.to}`,
      body: l.body.map((k) => `preview:${k}`),
      maxIterations: spec_?.maxIterations ?? 1,
      grantedIterations: 0,
      iteration: 1,
      onExhausted: spec_?.onExhausted ?? 'escalate',
      status: 'idle',
      version: 1,
      createdAt: now,
      updatedAt: now,
      from: l.from,
      to: l.to,
      bodyKeys: l.body,
    } as Loop;
  });
  return {
    graph: {
      id: 'preview',
      title: spec.title,
      status: 'draft',
      tags: spec.tags,
      counts: { pending: nodes.length },
      total: nodes.length,
    } as GraphView['graph'],
    aims: [],
    nodes,
    edges,
    loops,
    orchestrators: spec.orchestrators.map(
      (o) =>
        ({
          id: `preview-orch-${o.key}`,
          key: o.key,
          name: o.name,
          role: o.role,
          status: 'idle',
          scope: o.scope,
          capabilities: o.capabilities,
          executor: o.executor,
          triggers: o.triggers,
        }) as unknown as GraphView['orchestrators'][number],
    ),
    requests: [],
    criticalPath: [],
  };
}
