/** Instantiate a GraphState from a validated NormalizedSpec (graph creation), and entity factories. */
import { buildAdjacency, loopBody } from '../graph/algorithms';
import type {
  NormalizedAim,
  NormalizedEdgeRef,
  NormalizedLoop,
  NormalizedNode,
  NormalizedOrchestrator,
  NormalizedSpec,
} from '../spec/normalize';
import type { EdgeKind } from '../vocabulary';
import type { Aim, Edge, Graph, GraphState, Loop, Node, Orchestrator, Tx } from './types';

export function makeAim(
  tx: Tx,
  graphId: string,
  ownerType: Aim['ownerType'],
  ownerId: string,
  input: NormalizedAim,
  sortOrder: number,
  implicit = false,
): Aim {
  const { now } = tx.ctx;
  return {
    ...input,
    id: tx.ctx.id('am'),
    graphId,
    ownerType,
    ownerId,
    implicit,
    sortOrder,
    status: 'pending',
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

/** The implicit approval aim every gate carries (concepts §6.2). */
export function gateApprovalAim(node: Pick<Node, 'gate'>): NormalizedAim {
  const approver = node.gate?.approver ?? 'human';
  return {
    key: 'approval',
    title: approver === 'human' ? 'Approved by a human' : 'Approved by an orchestrator',
    kind: 'qualitative',
    terminating: true,
    guard: false,
    source: 'reported',
    aggregation: 'latest',
    evaluator: approver,
    ...(node.gate?.approverKey ? { evaluatorKey: node.gate.approverKey } : {}),
  };
}

/** Node configuration fields copied from a NormalizedNode (everything but runtime state). */
export function nodeConfig(n: NormalizedNode, idByKey: Map<string, string>): Partial<Node> {
  const config: Partial<Node> = {
    title: n.title,
    kind: n.kind,
    deliverables: n.deliverables,
    checklist: n.checklist,
    aimMode: n.aimMode,
    priority: n.priority,
    tags: n.tags,
    executor: n.executor,
    maxAttempts: n.maxAttempts,
    onExhausted: n.onExhausted,
    leaseTtlSec: n.leaseTtlSec,
    metadata: n.metadata,
    aim: n.aim,
    purpose: n.purpose,
    prompt: n.prompt,
    context: n.context,
    timeoutSec: n.timeoutSec,
    gate: n.gate,
    parentId: n.parent !== undefined ? idByKey.get(n.parent) : undefined,
    position: n.position,
  };
  return config;
}

export const NODE_CONFIG_FIELDS = [
  'title',
  'kind',
  'deliverables',
  'checklist',
  'aimMode',
  'priority',
  'tags',
  'executor',
  'maxAttempts',
  'onExhausted',
  'leaseTtlSec',
  'metadata',
  'aim',
  'purpose',
  'prompt',
  'context',
  'timeoutSec',
  'gate',
  'parentId',
  'position',
] as const satisfies ReadonlyArray<keyof Node>;

export function makeNode(
  tx: Tx,
  graphId: string,
  id: string,
  n: NormalizedNode,
  idByKey: Map<string, string>,
): Node {
  const { now } = tx.ctx;
  const node = {
    id,
    graphId,
    key: n.key,
    grantedAttempts: 0,
    status: 'pending',
    activation: 1,
    countedAttempts: 0,
    attemptsTotal: 0,
    acceptedWithDeviation: false,
    manual: false,
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...nodeConfig(n, idByKey),
  } as Node;
  for (const k of Object.keys(node) as Array<keyof Node>) if (node[k] === undefined) delete node[k];
  return node;
}

export function nodeAims(n: Pick<NormalizedNode, 'kind' | 'aims' | 'gate'>): NormalizedAim[] {
  return n.kind === 'gate' ? [gateApprovalAim(n), ...n.aims] : n.aims;
}

export function makeEdge(
  tx: Tx,
  graphId: string,
  fromNodeId: string,
  toNodeId: string,
  kind: EdgeKind,
  ref: Omit<NormalizedEdgeRef, 'key'>,
): Edge {
  const { now } = tx.ctx;
  const edge: Edge = {
    id: tx.ctx.id('ed'),
    graphId,
    fromNodeId,
    toNodeId,
    kind,
    attrProvenance: {},
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  for (const attr of ['label', 'relation', 'condition', 'guidance', 'pitfalls'] as const) {
    if (ref[attr] !== undefined) (edge as Record<string, unknown>)[attr] = ref[attr];
  }
  return edge;
}

export function makeLoop(
  tx: Tx,
  graphId: string,
  l: NormalizedLoop,
  idByKey: Map<string, string>,
): Loop {
  const { now } = tx.ctx;
  const loop: Loop = {
    id: tx.ctx.id('lp'),
    graphId,
    key: l.key,
    fromNodeId: idByKey.get(l.from) as string,
    toNodeId: idByKey.get(l.to) as string,
    body: [],
    maxIterations: l.maxIterations,
    grantedIterations: 0,
    iteration: 1,
    onExhausted: l.onExhausted,
    status: 'idle',
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  if (l.title !== undefined) loop.title = l.title;
  if (l.feedback !== undefined) loop.feedbackInstructions = l.feedback;
  return loop;
}

/** Recompute stored loop bodies from the current `requires` edges. */
export function computeLoopBodies(state: GraphState): void {
  const adjacency = buildAdjacency(
    [...state.nodes.keys()],
    state.edges
      .filter((e) => e.kind === 'requires')
      .map((e) => ({ from: e.fromNodeId, to: e.toNodeId })),
  );
  for (const loop of state.loops) {
    const body = loopBody(loop.fromNodeId, loop.toNodeId, adjacency);
    loop.body = [...(body ?? new Set([loop.fromNodeId, loop.toNodeId]))];
  }
}

export function makeOrchestrator(tx: Tx, graphId: string, o: NormalizedOrchestrator): Orchestrator {
  const { now } = tx.ctx;
  const orch: Orchestrator = {
    id: tx.ctx.id('or'),
    graphId,
    key: o.key,
    name: o.name,
    role: o.role,
    scope: o.scope,
    capabilities: o.capabilities,
    triggers: o.triggers,
    executor: o.executor,
    metadata: o.metadata,
    status: 'idle',
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  if (o.aim !== undefined) orch.aim = o.aim;
  if (o.purpose !== undefined) orch.purpose = o.purpose;
  if (o.prompt !== undefined) orch.prompt = o.prompt;
  return orch;
}

export type BuildOptions = { id?: string };

/** Build a draft graph. Every entity is touched and `graph.created` is emitted. */
export function buildGraph(spec: NormalizedSpec, tx: Tx, options: BuildOptions = {}): GraphState {
  const { now, actor } = tx.ctx;
  const graphId = options.id ?? tx.ctx.id('gr');
  const graph: Graph = {
    id: graphId,
    title: spec.title,
    status: 'draft',
    pendingApproval: false,
    tags: spec.tags,
    constraints: spec.constraints,
    policy: spec.policy,
    defaults: spec.defaults as Record<string, unknown>,
    evolution: spec.evolution,
    metadata: spec.metadata,
    revision: 1,
    version: 1,
    stalled: false,
    acceptedWithDeviation: false,
    createdBy: actor,
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
  };
  if (spec.slug !== undefined) graph.slug = spec.slug;
  if (spec.description !== undefined) graph.description = spec.description;
  if (spec.repository !== undefined) graph.repository = spec.repository;
  if (spec.context !== undefined) graph.context = spec.context;

  const state: GraphState = {
    graph,
    nodes: new Map(),
    edges: [],
    loops: [],
    aims: new Map(),
    attempts: new Map(),
    evaluations: [],
    metrics: [],
    orchestrators: new Map(),
    requests: new Map(),
    directives: new Map(),
    deliveries: [],
    lessonDuties: new Map(),
  };
  tx.touch('graph', graph);

  const idByKey = new Map<string, string>();
  for (const n of spec.nodes) idByKey.set(n.key, tx.ctx.id('nd'));

  for (const n of spec.nodes) {
    const node = makeNode(tx, graphId, idByKey.get(n.key) as string, n, idByKey);
    state.nodes.set(node.id, tx.touch('node', node));
    nodeAims(n).forEach((a, i) => {
      const aim = makeAim(tx, graphId, 'node', node.id, a, i, n.kind === 'gate' && i === 0);
      state.aims.set(aim.id, tx.touch('aim', aim));
    });
    for (const [kind, refs] of [
      ['requires', n.needs],
      ['informs', n.informedBy],
    ] as const) {
      for (const { key, ...attrs } of refs) {
        const edge = makeEdge(tx, graphId, idByKey.get(key) as string, node.id, kind, attrs);
        state.edges.push(tx.touch('edge', edge));
      }
    }
  }

  for (const l of spec.loops) state.loops.push(tx.touch('loop', makeLoop(tx, graphId, l, idByKey)));
  computeLoopBodies(state);

  for (const o of spec.orchestrators) {
    const orch = makeOrchestrator(tx, graphId, o);
    state.orchestrators.set(orch.id, tx.touch('orchestrator', orch));
    o.aims.forEach((a, i) => {
      const aim = makeAim(tx, graphId, 'orchestrator', orch.id, a, i);
      state.aims.set(aim.id, tx.touch('aim', aim));
    });
  }

  spec.aims.forEach((a, i) => {
    const aim = makeAim(tx, graphId, 'graph', graphId, a, i);
    state.aims.set(aim.id, tx.touch('aim', aim));
  });

  tx.emit('graph.created', graphId, 'graph', graphId, {
    title: spec.title,
    nodes: spec.nodes.length,
    edges: state.edges.length,
    loops: spec.loops.length,
    orchestrators: spec.orchestrators.length,
  });
  return state;
}
