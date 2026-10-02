/**
 * Pure cache patchers for live events (docs/ui.md §8): SSE snapshots update GraphView,
 * graph-list and inbox data in place; structural changes ask for a refetch instead.
 */
import type {
  AttemptSummary,
  GraphSummary,
  GraphView,
  HumanRequest,
  LiveEvent,
  Loop,
  NodeSummary,
  Orchestrator,
} from '@agent-graphs/sdk';
import { toWire } from './wire';

export const REFETCH = 'refetch' as const;
export type PatchResult<T> = T | typeof REFETCH | undefined;

/** Event types that change structure (nodes, edges, loops, orchestrators): refetch the view. */
const STRUCTURAL = new Set([
  'graph.revised',
  'graph.reopened',
  'node.created',
  'node.removed',
  'edge.created',
  'edge.removed',
  'edge.attributes_updated',
  'loop.created',
  'loop.removed',
  'loop.updated',
  'orchestrator.created',
  'orchestrator.removed',
  'aim.created',
  'aim.removed',
  'node.updated',
  'graph.updated',
]);

export function isStructural(type: string): boolean {
  return STRUCTURAL.has(type);
}

function snapshot<T>(event: LiveEvent): T | undefined {
  return event.snapshot === undefined || event.snapshot === null
    ? undefined
    : toWire(event.snapshot as T);
}

/**
 * Apply one live event to a GraphView. Returns the new view, `REFETCH` when the snapshot cannot
 * express the change, or `undefined` when the view is unaffected.
 */
/**
 * Recompute the graph summary fields that derive from nodes and requests (counts, progress,
 * live agents, open requests), so the header stays exact between server snapshots.
 */
export function withDerived(view: GraphView): GraphView {
  const counts: Partial<Record<string, number>> = {};
  for (const n of view.nodes) counts[n.status] = (counts[n.status] ?? 0) + 1;
  const total = view.nodes.length;
  const done = (counts.done ?? 0) + (counts.skipped ?? 0);
  const agents = view.nodes
    .filter((n) => n.currentAttempt?.status === 'running')
    .map((n) => {
      const x: Partial<NodeSummary['executor'] & { kind: string; agent: string }> =
        n.currentAttempt?.executor ?? {};
      return {
        attemptId: n.currentAttempt?.id as string,
        nodeKey: n.key,
        ...(x.kind ? { kind: x.kind } : {}),
        ...(x.agent ? { agent: x.agent } : {}),
        ...(x.model ? { model: x.model } : {}),
        ...(x.thinking ? { thinking: x.thinking } : {}),
        ...(x.provider ? { provider: x.provider } : {}),
        ...(x.mechanism ? { mechanism: x.mechanism } : {}),
      };
    });
  return {
    ...view,
    graph: {
      ...view.graph,
      counts,
      total,
      progress: total === 0 ? 0 : done / total,
      agents,
      openRequests: view.requests.length,
    },
  };
}

export function patchGraphView(view: GraphView, event: LiveEvent): PatchResult<GraphView> {
  const out = patchGraphViewRaw(view, event);
  if (!out || out === REFETCH || event.entity.type === 'graph') return out;
  return withDerived(out);
}

function patchGraphViewRaw(view: GraphView, event: LiveEvent): PatchResult<GraphView> {
  if (event.graphId !== view.graph.id) return undefined;
  if (isStructural(event.type)) return REFETCH;
  switch (event.entity.type) {
    case 'graph': {
      const snap = snapshot<GraphSummary>(event);
      if (!snap) return REFETCH;
      return { ...view, graph: { ...view.graph, ...snap } };
    }
    case 'node': {
      const snap = snapshot<NodeSummary>(event);
      if (!snap) return REFETCH;
      const i = view.nodes.findIndex((n) => n.id === snap.id);
      if (i < 0) return REFETCH;
      const nodes = view.nodes.slice();
      nodes[i] = snap;
      return { ...view, nodes };
    }
    case 'attempt': {
      const snap = snapshot<AttemptSummary & { nodeKey?: string }>(event);
      if (!snap?.nodeKey) return undefined;
      const i = view.nodes.findIndex((n) => n.key === snap.nodeKey);
      if (i < 0) return undefined;
      const node = view.nodes[i] as NodeSummary;
      const { nodeKey: _key, ...attempt } = snap;
      const isOpen = attempt.status === 'running' || attempt.status === 'submitted';
      if (node.currentAttempt && node.currentAttempt.id !== attempt.id && !isOpen) return undefined;
      const nodes = view.nodes.slice();
      nodes[i] = { ...node, currentAttempt: attempt as AttemptSummary };
      return { ...view, nodes };
    }
    case 'request': {
      const snap = snapshot<HumanRequest>(event);
      if (!snap) return REFETCH;
      const rest = view.requests.filter((r) => r.id !== snap.id);
      return { ...view, requests: snap.status === 'open' ? [snap, ...rest] : rest };
    }
    case 'loop': {
      const snap = snapshot<Loop>(event);
      if (!snap) return REFETCH;
      const i = view.loops.findIndex((l) => l.id === snap.id);
      if (i < 0) return REFETCH;
      const loops = view.loops.slice();
      const prev = loops[i] as Loop;
      loops[i] = { ...prev, ...snap, from: prev.from, to: prev.to, bodyKeys: prev.bodyKeys };
      return { ...view, loops };
    }
    case 'orchestrator': {
      const snap = snapshot<Orchestrator>(event);
      if (!snap) return REFETCH;
      const i = view.orchestrators.findIndex((o) => o.id === snap.id);
      if (i < 0) return REFETCH;
      const orchestrators = view.orchestrators.slice();
      const prev = orchestrators[i] as Orchestrator;
      orchestrators[i] = { ...prev, ...snap, aims: prev.aims };
      return { ...view, orchestrators };
    }
    case 'aim': {
      const snap = snapshot<GraphView['aims'][number]>(event);
      if (!snap) return undefined;
      if (snap.ownerType === 'graph') {
        const i = view.aims.findIndex((a) => a.id === snap.id);
        if (i < 0) return REFETCH;
        const aims = view.aims.slice();
        aims[i] = snap;
        return { ...view, aims };
      }
      if (snap.ownerType === 'node') {
        const i = view.nodes.findIndex((n) => n.id === snap.ownerId);
        if (i < 0) return undefined;
        const node = view.nodes[i] as NodeSummary;
        const nodes = view.nodes.slice();
        nodes[i] = {
          ...node,
          aims: node.aims.map((a) =>
            a.key === snap.key ? { ...a, status: snap.status, currentValue: snap.currentValue } : a,
          ),
        };
        return { ...view, nodes };
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** Patch a graph-list page with a graph summary snapshot. */
export function patchGraphList(
  items: GraphSummary[],
  event: LiveEvent,
): PatchResult<GraphSummary[]> {
  if (event.entity.type !== 'graph' || !event.graphId) return undefined;
  if (event.type === 'graph.created') return REFETCH;
  const snap = snapshot<GraphSummary>(event);
  if (!snap) return undefined;
  const i = items.findIndex((g) => g.id === snap.id);
  if (i < 0) return REFETCH;
  const out = items.slice();
  out[i] = { ...(out[i] as GraphSummary), ...snap };
  return out;
}

/**
 * Patch the open-requests inbox: resolved/dismissed requests leave it; new ones need a refetch
 * (the list rows carry the graph title, which the snapshot lacks).
 */
export function patchOpenRequests(
  items: HumanRequest[],
  event: LiveEvent,
): PatchResult<HumanRequest[]> {
  if (event.entity.type !== 'request') return undefined;
  const snap = snapshot<HumanRequest>(event);
  if (!snap) return REFETCH;
  const i = items.findIndex((r) => r.id === snap.id);
  if (snap.status !== 'open') return i < 0 ? undefined : items.filter((r) => r.id !== snap.id);
  if (i < 0) return REFETCH;
  const out = items.slice();
  out[i] = { ...(out[i] as HumanRequest), ...snap, graph: (out[i] as HumanRequest).graph };
  return out;
}

/** Node keys an event touches (for highlighting changed cards). */
export function touchedNodeIds(view: GraphView, event: LiveEvent): string[] {
  if (event.graphId !== view.graph.id) return [];
  if (event.entity.type === 'node') return [event.entity.id];
  if (event.entity.type === 'attempt') {
    const key = (event.snapshot as { nodeKey?: string } | undefined)?.nodeKey;
    const node = key ? view.nodes.find((n) => n.key === key) : undefined;
    return node ? [node.id] : [];
  }
  const nodeId = (event.payload as { nodeId?: string } | undefined)?.nodeId;
  return nodeId ? [nodeId] : [];
}
