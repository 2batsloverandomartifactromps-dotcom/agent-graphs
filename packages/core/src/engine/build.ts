/** Instantiate a GraphState from a validated NormalizedSpec (graph creation). */
import { buildAdjacency, loopBody } from '../graph/algorithms';
import type { NormalizedAim, NormalizedSpec } from '../spec/normalize';
import type { Aim, Edge, Graph, GraphState, Loop, Node, Orchestrator, Tx } from './types';

function makeAim(
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
    const node: Node = {
      id: idByKey.get(n.key) as string,
      graphId,
      key: n.key,
      title: n.title,
      kind: n.kind,
      deliverables: n.deliverables,
      checklist: n.checklist,
      aimMode: n.aimMode,
      priority: n.priority,
      tags: n.tags,
      executor: n.executor,
      maxAttempts: n.maxAttempts,
      grantedAttempts: 0,
      onExhausted: n.onExhausted,
      leaseTtlSec: n.leaseTtlSec,
      metadata: n.metadata,
      status: 'pending',
      activation: 1,
      countedAttempts: 0,
      attemptsTotal: 0,
      acceptedWithDeviation: false,
      manual: false,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    if (n.aim !== undefined) node.aim = n.aim;
    if (n.purpose !== undefined) node.purpose = n.purpose;
    if (n.prompt !== undefined) node.prompt = n.prompt;
    if (n.context !== undefined) node.context = n.context;
    if (n.timeoutSec !== undefined) node.timeoutSec = n.timeoutSec;
    if (n.gate !== undefined) node.gate = n.gate;
    if (n.parent !== undefined) node.parentId = idByKey.get(n.parent);
    if (n.position !== undefined) node.position = n.position;
    state.nodes.set(node.id, tx.touch('node', node));

    const aims = n.kind === 'gate' ? [gateApprovalAim(node), ...n.aims] : n.aims;
    aims.forEach((a, i) => {
      const aim = makeAim(tx, graphId, 'node', node.id, a, i, n.kind === 'gate' && i === 0);
      state.aims.set(aim.id, tx.touch('aim', aim));
    });

    for (const [kind, refs] of [
      ['requires', n.needs],
      ['informs', n.informedBy],
    ] as const) {
      for (const ref of refs) {
        const edge: Edge = {
          id: tx.ctx.id('ed'),
          graphId,
          fromNodeId: idByKey.get(ref.key) as string,
          toNodeId: node.id,
          kind,
          attrProvenance: {},
          version: 1,
          createdAt: now,
          updatedAt: now,
        };
        for (const attr of ['label', 'relation', 'condition', 'guidance', 'pitfalls'] as const) {
          if (ref[attr] !== undefined) (edge as Record<string, unknown>)[attr] = ref[attr];
        }
        state.edges.push(tx.touch('edge', edge));
      }
    }
  }

  const adjacency = buildAdjacency(
    spec.nodes.map((n) => n.key),
    spec.nodes.flatMap((n) => n.needs.map((ref) => ({ from: ref.key, to: n.key }))),
  );
  for (const l of spec.loops) {
    const body = loopBody(l.from, l.to, adjacency) ?? new Set([l.from, l.to]);
    const loop: Loop = {
      id: tx.ctx.id('lp'),
      graphId,
      key: l.key,
      fromNodeId: idByKey.get(l.from) as string,
      toNodeId: idByKey.get(l.to) as string,
      body: [...body].map((key) => idByKey.get(key) as string),
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
    state.loops.push(tx.touch('loop', loop));
  }

  for (const o of spec.orchestrators) {
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
