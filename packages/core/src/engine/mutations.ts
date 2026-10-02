/**
 * Structural changes after creation (docs/api.md `POST /graphs/{g}/mutations`, concepts §14
 * `mutations` policy). A batch is applied to the graph's current spec, validated as a whole, and
 * then synced onto the live state: new entities are created, removed ones deleted, and changed
 * configuration is patched with diffs. Runtime state (statuses, attempts) is never rewritten.
 */

import { toSpecInput } from '../spec/export';
import type { NormalizedAim, NormalizedNode, NormalizedSpec } from '../spec/normalize';
import { validateSpec } from '../spec/validate';
import { canonicalJson } from '../util/hash';
import {
  computeLoopBodies,
  makeAim,
  makeEdge,
  makeLoop,
  makeNode,
  makeOrchestrator,
  NODE_CONFIG_FIELDS,
  nodeAims,
  nodeConfig,
} from './build';
import { createDirective } from './requests';
import { aimsOf, graphAims, openAttempt, prerequisitesSatisfied } from './state';
import { setNodeStatus, touchGraph } from './transitions';
import { type Aim, EngineError, type GraphState, type Node, type Tx } from './types';

type Obj = Record<string, unknown>;

/** The live graph's configuration as a normalized spec (what `GET /graphs/{g}/spec` exports). */
export function stateToSpec(state: GraphState): NormalizedSpec {
  const g = state.graph;
  const keyOf = (id: string) => state.nodes.get(id)?.key ?? id;
  const aimOut = (a: Aim): NormalizedAim => {
    const out: NormalizedAim = {
      key: a.key,
      title: a.title,
      kind: a.kind,
      terminating: a.terminating,
      guard: a.guard,
      source: a.source,
      aggregation: a.aggregation,
      evaluator: a.evaluator,
    };
    for (const k of [
      'description',
      'weight',
      'metric',
      'comparator',
      'target',
      'targetMax',
      'unit',
      'criteria',
      'evaluatorKey',
    ] as const) {
      if (a[k] !== undefined) (out as Obj)[k] = a[k];
    }
    return out;
  };
  const nodes = [...state.nodes.values()]
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .map((n): NormalizedNode => {
      const refs = (kind: 'requires' | 'informs') =>
        state.edges
          .filter((e) => e.kind === kind && e.toNodeId === n.id)
          .map((e) => {
            const ref: NormalizedNode['needs'][number] = { key: keyOf(e.fromNodeId) };
            for (const attr of [
              'label',
              'relation',
              'condition',
              'guidance',
              'pitfalls',
            ] as const) {
              if (e[attr] !== undefined) (ref as Obj)[attr] = e[attr];
            }
            return ref;
          });
      const out: NormalizedNode = {
        key: n.key,
        title: n.title,
        kind: n.kind,
        deliverables: n.deliverables,
        checklist: n.checklist,
        needs: refs('requires'),
        informedBy: refs('informs'),
        aims: aimsOf(state, 'node', n.id)
          .filter((a) => !a.implicit)
          .map(aimOut),
        aimMode: n.aimMode,
        priority: n.priority,
        tags: n.tags,
        executor: n.executor,
        maxAttempts: n.maxAttempts,
        onExhausted: n.onExhausted,
        leaseTtlSec: n.leaseTtlSec,
        metadata: n.metadata,
      };
      for (const k of [
        'aim',
        'purpose',
        'prompt',
        'context',
        'timeoutSec',
        'gate',
        'position',
      ] as const) {
        if (n[k] !== undefined) (out as Obj)[k] = n[k];
      }
      if (n.parentId) out.parent = keyOf(n.parentId);
      return out;
    });
  const spec: NormalizedSpec = {
    schema: 'agent-graphs/v1',
    title: g.title,
    tags: g.tags,
    constraints: g.constraints,
    aims: graphAims(state).map(aimOut),
    policy: g.policy,
    defaults: g.defaults as NormalizedSpec['defaults'],
    evolution: g.evolution,
    orchestrators: [...state.orchestrators.values()]
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map((o) => ({
        key: o.key,
        name: o.name,
        role: o.role,
        ...(o.aim !== undefined ? { aim: o.aim } : {}),
        ...(o.purpose !== undefined ? { purpose: o.purpose } : {}),
        ...(o.prompt !== undefined ? { prompt: o.prompt } : {}),
        scope: o.scope,
        capabilities: o.capabilities,
        triggers: o.triggers,
        aims: aimsOf(state, 'orchestrator', o.id).map(aimOut),
        executor: o.executor,
        metadata: o.metadata,
      })),
    nodes,
    loops: state.loops.map((l) => ({
      key: l.key,
      ...(l.title !== undefined ? { title: l.title } : {}),
      from: keyOf(l.fromNodeId),
      to: keyOf(l.toNodeId),
      maxIterations: l.maxIterations,
      onExhausted: l.onExhausted,
      ...(l.feedbackInstructions !== undefined ? { feedback: l.feedbackInstructions } : {}),
    })),
    metadata: g.metadata,
  };
  if (g.slug !== undefined) spec.slug = g.slug;
  if (g.description !== undefined) spec.description = g.description;
  if (g.repository !== undefined) spec.repository = g.repository;
  if (g.context !== undefined) spec.context = g.context;
  return spec;
}

export type EdgeSpec = {
  from: string;
  to: string;
  kind?: 'requires' | 'informs';
  label?: string;
  relation?: string;
  condition?: string;
  guidance?: string;
  pitfalls?: string;
};

export type MutationBatch = {
  graph?: Obj;
  addNodes?: Obj[];
  updateNodes?: Array<Obj & { key: string }>;
  removeNodes?: string[];
  addEdges?: EdgeSpec[];
  updateEdges?: EdgeSpec[];
  removeEdges?: Array<Pick<EdgeSpec, 'from' | 'to' | 'kind'>>;
  addLoops?: Obj[];
  updateLoops?: Array<Obj & { key: string }>;
  removeLoops?: string[];
  addOrchestrators?: Obj[];
  updateOrchestrators?: Array<Obj & { key: string }>;
  removeOrchestrators?: string[];
  addGraphAims?: Obj[];
  updateGraphAims?: Array<Obj & { key: string }>;
  removeGraphAims?: string[];
};

export type MutationActor = { admin: boolean };

const STARTED = (n: Node) => n.status !== 'pending' && n.status !== 'ready';
const PROTECTED_GRAPH_FIELDS = new Set(['aims', 'policy', 'evolution']);

function denied(message: string, hint?: string): EngineError {
  return new EngineError('POLICY_DENIED', message, hint, 403);
}

/** Enforce the mutations policy and structural rules before anything is applied. */
function authorize(state: GraphState, batch: MutationBatch, actor: MutationActor): void {
  const policy = state.graph.policy.mutations;
  const modifies =
    batch.updateNodes?.length ||
    batch.removeNodes?.length ||
    batch.updateEdges?.length ||
    batch.removeEdges?.length ||
    batch.updateLoops?.length ||
    batch.removeLoops?.length ||
    batch.updateOrchestrators?.length ||
    batch.removeOrchestrators?.length ||
    batch.graph;
  const protectedEdit =
    batch.addGraphAims?.length ||
    batch.updateGraphAims?.length ||
    batch.removeGraphAims?.length ||
    Object.keys(batch.graph ?? {}).some((k) => PROTECTED_GRAPH_FIELDS.has(k)) ||
    batch.updateNodes?.some((u) => 'aims' in u || 'aimMode' in u);
  if (!actor.admin) {
    if (policy === 'locked')
      throw denied(
        'Mutations are locked for this graph (policy.mutations: locked).',
        'Ask an admin.',
      );
    if (policy === 'append' && modifies) {
      throw denied(
        'policy.mutations is append: orchestrators may only add nodes, edges, and loops.',
        'Ask an admin, or add new nodes instead.',
      );
    }
    if (protectedEdit)
      throw denied('Aims, policy, and evolution settings are protected (admin only).');
  }
  for (const u of batch.updateNodes ?? []) {
    const node = [...state.nodes.values()].find((n) => n.key === u.key);
    if (node && STARTED(node) && !actor.admin) {
      throw denied(`'${node.key}' has started; orchestrators may only modify unstarted nodes.`);
    }
    if (node && STARTED(node) && 'needs' in u) {
      throw new EngineError(
        'INVALID_TRANSITION',
        `Cannot change the prerequisites of '${node.key}': it has started.`,
        'Reopen it first (this cascades to its descendants), then edit its needs.',
      );
    }
    if (node && STARTED(node) && 'kind' in u && u.kind !== node.kind) {
      throw new EngineError(
        'INVALID_TRANSITION',
        `Cannot change the kind of started node '${node.key}'.`,
      );
    }
  }
  for (const key of batch.removeNodes ?? []) {
    const node = [...state.nodes.values()].find((n) => n.key === key);
    if (node && STARTED(node)) {
      throw new EngineError(
        'INVALID_TRANSITION',
        `Cannot remove '${key}': it has started.`,
        'Skip it instead (with a reason).',
      );
    }
  }
  for (const e of batch.addEdges ?? []) {
    const target = [...state.nodes.values()].find((n) => n.key === e.to);
    if (target && (e.kind ?? 'requires') === 'requires' && STARTED(target)) {
      throw new EngineError(
        'INVALID_TRANSITION',
        `Cannot add a prerequisite to '${e.to}': it has started.`,
        'Reopen it first (this cascades to its descendants), then add the edge.',
      );
    }
  }
}

/** Apply a batch to a spec object (no validation). */
function patch(spec: Obj, batch: MutationBatch): Obj {
  const nodes = spec.nodes as Array<Obj & { key: string }>;
  const find = <T extends { key: string }>(list: T[], key: string, what: string): T => {
    const item = list.find((x) => x.key === key);
    if (!item)
      throw new EngineError('NOT_FOUND', `${what} '${key}' does not exist.`, undefined, 404);
    return item;
  };
  if (batch.graph) {
    for (const [k, v] of Object.entries(batch.graph)) {
      if (k === 'nodes' || k === 'loops' || k === 'orchestrators' || k === 'schema') continue;
      spec[k] = v;
    }
  }
  spec.aims ??= [];
  const aims = spec.aims as Array<Obj & { key: string }>;
  for (const a of batch.addGraphAims ?? []) aims.push(a as Obj & { key: string });
  for (const u of batch.updateGraphAims ?? []) Object.assign(find(aims, u.key, 'Graph aim'), u);
  if (batch.removeGraphAims?.length)
    spec.aims = aims.filter((a) => !batch.removeGraphAims?.includes(a.key));

  for (const n of batch.addNodes ?? []) nodes.push(n as Obj & { key: string });
  for (const u of batch.updateNodes ?? []) Object.assign(find(nodes, u.key, 'Node'), u);
  for (const key of batch.removeNodes ?? []) {
    find(nodes, key, 'Node');
    spec.nodes = (spec.nodes as Array<Obj & { key: string }>).filter((n) => n.key !== key);
    for (const n of spec.nodes as Obj[]) {
      for (const field of ['needs', 'informedBy']) {
        if (Array.isArray(n[field])) {
          n[field] = (n[field] as Array<string | { key: string }>).filter(
            (r) => (typeof r === 'string' ? r : r.key) !== key,
          );
        }
      }
    }
  }
  const refsOf = (to: string, kind: 'requires' | 'informs') => {
    const node = find(spec.nodes as Array<Obj & { key: string }>, to, 'Node');
    const field = kind === 'requires' ? 'needs' : 'informedBy';
    node[field] ??= [];
    return node[field] as Array<string | (Obj & { key: string })>;
  };
  for (const e of batch.addEdges ?? []) {
    const { from, to, kind = 'requires', ...attrs } = e;
    refsOf(to, kind).push(Object.keys(attrs).length ? { key: from, ...attrs } : from);
  }
  for (const e of batch.updateEdges ?? []) {
    const { from, to, kind = 'requires', ...attrs } = e;
    const list = refsOf(to, kind);
    const i = list.findIndex((r) => (typeof r === 'string' ? r : r.key) === from);
    if (i < 0)
      throw new EngineError(
        'NOT_FOUND',
        `Edge ${from} → ${to} (${kind}) does not exist.`,
        undefined,
        404,
      );
    const current = list[i] as string | Obj;
    list[i] = {
      ...(typeof current === 'string' ? { key: current } : current),
      ...attrs,
      key: from,
    };
  }
  for (const e of batch.removeEdges ?? []) {
    const list = refsOf(e.to, e.kind ?? 'requires');
    const i = list.findIndex((r) => (typeof r === 'string' ? r : r.key) === e.from);
    if (i < 0)
      throw new EngineError(
        'NOT_FOUND',
        `Edge ${e.from} → ${e.to} does not exist.`,
        undefined,
        404,
      );
    list.splice(i, 1);
  }
  spec.loops ??= [];
  const loops = spec.loops as Array<Obj & { key: string }>;
  for (const l of batch.addLoops ?? []) loops.push(l as Obj & { key: string });
  for (const u of batch.updateLoops ?? []) Object.assign(find(loops, u.key, 'Loop'), u);
  if (batch.removeLoops?.length)
    spec.loops = loops.filter((l) => !batch.removeLoops?.includes(l.key));
  spec.orchestrators ??= [];
  const orchs = spec.orchestrators as Array<Obj & { key: string }>;
  for (const o of batch.addOrchestrators ?? []) orchs.push(o as Obj & { key: string });
  for (const u of batch.updateOrchestrators ?? [])
    Object.assign(find(orchs, u.key, 'Orchestrator'), u);
  if (batch.removeOrchestrators?.length)
    spec.orchestrators = orchs.filter((o) => !batch.removeOrchestrators?.includes(o.key));
  if ((spec.loops as unknown[]).length === 0) delete spec.loops;
  if ((spec.orchestrators as unknown[]).length === 0) delete spec.orchestrators;
  return spec;
}

export type MutationResult = { revision: number; changes: string[] };

/** Validate and apply a mutation batch. Throws VALIDATION_FAILED with spec-style issues. */
export function applyMutations(
  state: GraphState,
  tx: Tx,
  batch: MutationBatch,
  actor: MutationActor,
): MutationResult {
  authorize(state, batch, actor);
  const spec = patch(JSON.parse(JSON.stringify(toSpecInput(stateToSpec(state)))) as Obj, batch);
  const result = validateSpec(spec);
  if (!result.ok || !result.normalized) {
    throw new EngineError(
      'VALIDATION_FAILED',
      'The mutation batch does not produce a valid graph.',
      'Fix the listed issues; nothing was applied.',
      400,
      result.errors,
    );
  }
  return syncState(state, tx, result.normalized);
}

function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function syncAims(
  state: GraphState,
  tx: Tx,
  ownerType: Aim['ownerType'],
  ownerId: string,
  desired: NormalizedAim[],
  implicitFirst: NormalizedAim | undefined,
  changes: string[],
  label: string,
): void {
  const current = aimsOf(state, ownerType, ownerId);
  const all = implicitFirst ? [implicitFirst, ...desired] : desired;
  const wanted = new Map(all.map((a, i) => [a.key, { a, i }]));
  for (const aim of current) {
    if (!wanted.has(aim.key)) {
      state.aims.delete(aim.id);
      tx.remove('aim', aim.id);
      tx.emit('aim.removed', state.graph.id, 'aim', aim.id, { key: aim.key, owner: label });
      changes.push(`removed aim ${label}.${aim.key}`);
    }
  }
  for (const [key, { a, i }] of wanted) {
    const existing = current.find((c) => c.key === key);
    if (!existing) {
      const aim = makeAim(
        tx,
        state.graph.id,
        ownerType,
        ownerId,
        a,
        i,
        implicitFirst !== undefined && i === 0,
      );
      state.aims.set(aim.id, tx.touch('aim', aim));
      tx.emit('aim.created', state.graph.id, 'aim', aim.id, { key, owner: label });
      changes.push(`added aim ${label}.${key}`);
      continue;
    }
    const before: Obj = {};
    const after: Obj = {};
    for (const [field, value] of Object.entries(a)) {
      if (!same((existing as Obj)[field], value)) {
        before[field] = (existing as Obj)[field];
        after[field] = value;
        (existing as Obj)[field] = value;
      }
    }
    for (const field of [
      'description',
      'weight',
      'metric',
      'comparator',
      'target',
      'targetMax',
      'unit',
      'criteria',
      'evaluatorKey',
    ] as const) {
      if (existing[field] !== undefined && (a as Obj)[field] === undefined) {
        before[field] = existing[field];
        after[field] = undefined;
        delete existing[field];
      }
    }
    existing.sortOrder = i;
    if (Object.keys(after).length) {
      existing.version += 1;
      existing.updatedAt = tx.ctx.now;
      tx.touch('aim', existing);
      tx.emit('aim.updated', state.graph.id, 'aim', existing.id, {
        key,
        owner: label,
        before,
        after,
      });
      changes.push(`updated aim ${label}.${key}`);
    }
  }
}

/** Make the live state match a normalized spec, keeping runtime state. */
export function syncState(state: GraphState, tx: Tx, next: NormalizedSpec): MutationResult {
  const g = state.graph;
  const gid = g.id;
  const changes: string[] = [];

  // Graph fields
  const graphBefore: Obj = {};
  const graphAfter: Obj = {};
  for (const field of [
    'title',
    'slug',
    'description',
    'tags',
    'repository',
    'context',
    'constraints',
    'policy',
    'defaults',
    'evolution',
    'metadata',
  ] as const) {
    const value = (next as Obj)[field];
    if (!same((g as Obj)[field], value)) {
      graphBefore[field] = (g as Obj)[field];
      graphAfter[field] = value;
      if (value === undefined) delete (g as Obj)[field];
      else (g as Obj)[field] = value;
    }
  }
  if (Object.keys(graphAfter).length) {
    tx.emit('graph.updated', gid, 'graph', gid, { before: graphBefore, after: graphAfter });
    changes.push(`updated graph ${Object.keys(graphAfter).join(', ')}`);
  }
  syncAims(state, tx, 'graph', gid, next.aims, undefined, changes, 'graph');

  // Nodes
  const byKey = new Map([...state.nodes.values()].map((n) => [n.key, n]));
  const wanted = new Set(next.nodes.map((n) => n.key));
  for (const node of [...state.nodes.values()]) {
    if (wanted.has(node.key)) continue;
    for (const aim of aimsOf(state, 'node', node.id)) {
      state.aims.delete(aim.id);
      tx.remove('aim', aim.id);
    }
    state.nodes.delete(node.id);
    tx.remove('node', node.id);
    tx.emit('node.removed', gid, 'node', node.id, { key: node.key });
    changes.push(`removed node ${node.key}`);
  }
  const idByKey = new Map([...state.nodes.values()].map((n) => [n.key, n.id]));
  for (const n of next.nodes) if (!idByKey.has(n.key)) idByKey.set(n.key, tx.ctx.id('nd'));
  for (const n of next.nodes) {
    const existing = byKey.get(n.key);
    if (!existing) {
      const node = makeNode(tx, gid, idByKey.get(n.key) as string, n, idByKey);
      state.nodes.set(node.id, tx.touch('node', node));
      tx.emit('node.created', gid, 'node', node.id, { key: n.key, title: n.title, kind: n.kind });
      changes.push(`added node ${n.key}`);
      nodeAims(n).forEach((a, i) => {
        const aim = makeAim(tx, gid, 'node', node.id, a, i, n.kind === 'gate' && i === 0);
        state.aims.set(aim.id, tx.touch('aim', aim));
      });
      continue;
    }
    const config = nodeConfig(n, idByKey);
    const before: Obj = {};
    const after: Obj = {};
    for (const field of NODE_CONFIG_FIELDS) {
      const value = config[field];
      if (!same(existing[field], value)) {
        before[field] = existing[field];
        after[field] = value;
        if (value === undefined) delete (existing as Obj)[field];
        else (existing as Obj)[field] = value;
      }
    }
    if (Object.keys(after).length) {
      existing.version += 1;
      existing.updatedAt = tx.ctx.now;
      tx.touch('node', existing);
      tx.emit('node.updated', gid, 'node', existing.id, { key: n.key, before, after });
      changes.push(`updated node ${n.key}`);
      if (openAttempt(state, existing.id)?.status === 'running') {
        createDirective(state, tx, {
          targetType: 'node',
          targetId: existing.id,
          kind: 'change',
          title: `Configuration changed: ${Object.keys(after).join(', ')}`,
          data: { before, after },
          requiresAck: true,
        });
      }
    }
    syncAims(
      state,
      tx,
      'node',
      existing.id,
      n.aims,
      n.kind === 'gate' ? nodeAims(n)[0] : undefined,
      changes,
      n.key,
    );
  }

  // Edges
  const edgeKey = (from: string, to: string, kind: string) => `${from}>${to}:${kind}`;
  const desiredEdges = new Map<
    string,
    { from: string; to: string; kind: 'requires' | 'informs'; ref: Obj }
  >();
  for (const n of next.nodes) {
    for (const [kind, refs] of [
      ['requires', n.needs],
      ['informs', n.informedBy],
    ] as const) {
      for (const { key, ...ref } of refs) {
        const from = idByKey.get(key) as string;
        const to = idByKey.get(n.key) as string;
        desiredEdges.set(edgeKey(from, to, kind), { from, to, kind, ref });
      }
    }
  }
  const keptEdges = [];
  for (const edge of state.edges) {
    const k = edgeKey(edge.fromNodeId, edge.toNodeId, edge.kind);
    const desired = desiredEdges.get(k);
    if (!desired || !state.nodes.has(edge.fromNodeId) || !state.nodes.has(edge.toNodeId)) {
      tx.remove('edge', edge.id);
      tx.emit('edge.removed', gid, 'edge', edge.id, {
        from: edge.fromNodeId,
        to: edge.toNodeId,
        kind: edge.kind,
      });
      changes.push(`removed edge ${k}`);
      continue;
    }
    desiredEdges.delete(k);
    keptEdges.push(edge);
    const before: Obj = {};
    const after: Obj = {};
    for (const attr of ['label', 'relation', 'condition', 'guidance', 'pitfalls'] as const) {
      if (edge[attr] !== desired.ref[attr]) {
        before[attr] = edge[attr];
        after[attr] = desired.ref[attr];
        if (desired.ref[attr] === undefined) delete edge[attr];
        else (edge as Obj)[attr] = desired.ref[attr];
      }
    }
    if (Object.keys(after).length) {
      edge.version += 1;
      edge.updatedAt = tx.ctx.now;
      tx.touch('edge', edge);
      tx.emit('edge.attributes_updated', gid, 'edge', edge.id, {
        before,
        after,
        provenance: { actor: tx.ctx.actor.kind },
      });
      changes.push(`updated edge ${k}`);
    }
  }
  state.edges = keptEdges;
  for (const [k, d] of desiredEdges) {
    const edge = makeEdge(tx, gid, d.from, d.to, d.kind, d.ref);
    state.edges.push(tx.touch('edge', edge));
    tx.emit('edge.created', gid, 'edge', edge.id, { from: d.from, to: d.to, kind: d.kind });
    changes.push(`added edge ${k}`);
  }

  // Loops
  const wantedLoops = new Map(next.loops.map((l) => [l.key, l]));
  state.loops = state.loops.filter((loop) => {
    if (wantedLoops.has(loop.key)) return true;
    tx.remove('loop', loop.id);
    tx.emit('loop.removed', gid, 'loop', loop.id, { key: loop.key });
    changes.push(`removed loop ${loop.key}`);
    return false;
  });
  for (const l of next.loops) {
    const loop = state.loops.find((x) => x.key === l.key);
    if (!loop) {
      const created = makeLoop(tx, gid, l, idByKey);
      state.loops.push(tx.touch('loop', created));
      tx.emit('loop.created', gid, 'loop', created.id, { key: l.key });
      changes.push(`added loop ${l.key}`);
      continue;
    }
    const desired = {
      title: l.title,
      fromNodeId: idByKey.get(l.from),
      toNodeId: idByKey.get(l.to),
      maxIterations: l.maxIterations,
      onExhausted: l.onExhausted,
      feedbackInstructions: l.feedback,
    };
    const before: Obj = {};
    const after: Obj = {};
    for (const [field, value] of Object.entries(desired)) {
      if ((loop as Obj)[field] !== value) {
        before[field] = (loop as Obj)[field];
        after[field] = value;
        if (value === undefined) delete (loop as Obj)[field];
        else (loop as Obj)[field] = value;
      }
    }
    if (Object.keys(after).length) {
      loop.version += 1;
      loop.updatedAt = tx.ctx.now;
      tx.touch('loop', loop);
      tx.emit('loop.updated', gid, 'loop', loop.id, { key: l.key, before, after });
      changes.push(`updated loop ${l.key}`);
    }
  }
  const bodiesBefore = new Map(state.loops.map((l) => [l.id, [...l.body].sort().join(',')]));
  computeLoopBodies(state);
  for (const loop of state.loops)
    if (bodiesBefore.get(loop.id) !== [...loop.body].sort().join(',')) tx.touch('loop', loop);

  // Orchestrators
  const wantedOrchs = new Map(next.orchestrators.map((o) => [o.key, o]));
  for (const orch of [...state.orchestrators.values()]) {
    if (wantedOrchs.has(orch.key)) continue;
    for (const aim of aimsOf(state, 'orchestrator', orch.id)) {
      state.aims.delete(aim.id);
      tx.remove('aim', aim.id);
    }
    state.orchestrators.delete(orch.id);
    tx.remove('orchestrator', orch.id);
    tx.emit('orchestrator.removed', gid, 'orchestrator', orch.id, { key: orch.key });
    changes.push(`removed orchestrator ${orch.key}`);
  }
  for (const o of next.orchestrators) {
    const orch = [...state.orchestrators.values()].find((x) => x.key === o.key);
    if (!orch) {
      const created = makeOrchestrator(tx, gid, o);
      state.orchestrators.set(created.id, tx.touch('orchestrator', created));
      tx.emit('orchestrator.created', gid, 'orchestrator', created.id, { key: o.key });
      changes.push(`added orchestrator ${o.key}`);
      o.aims.forEach((a, i) => {
        const aim = makeAim(tx, gid, 'orchestrator', created.id, a, i);
        state.aims.set(aim.id, tx.touch('aim', aim));
      });
      continue;
    }
    const before: Obj = {};
    const after: Obj = {};
    for (const field of [
      'name',
      'role',
      'aim',
      'purpose',
      'prompt',
      'scope',
      'capabilities',
      'triggers',
      'executor',
      'metadata',
    ] as const) {
      const value = (o as Obj)[field];
      if (!same((orch as Obj)[field], value)) {
        before[field] = (orch as Obj)[field];
        after[field] = value;
        if (value === undefined) delete (orch as Obj)[field];
        else (orch as Obj)[field] = value;
      }
    }
    if (Object.keys(after).length) {
      orch.version += 1;
      orch.updatedAt = tx.ctx.now;
      tx.touch('orchestrator', orch);
      tx.emit('orchestrator.updated', gid, 'orchestrator', orch.id, { key: o.key, before, after });
      changes.push(`updated orchestrator ${o.key}`);
    }
    syncAims(state, tx, 'orchestrator', orch.id, o.aims, undefined, changes, o.key);
  }

  // New prerequisites on unstarted nodes push them back to pending.
  for (const node of state.nodes.values()) {
    if (node.status === 'ready' && !prerequisitesSatisfied(state, node)) {
      setNodeStatus(state, tx, node, 'pending', 'new prerequisite');
    }
  }
  if (changes.length) {
    g.revision += 1;
    g.version += 1;
    touchGraph(state, tx);
    tx.emit('graph.revised', gid, 'graph', gid, { revision: g.revision, changes });
  }
  return { revision: g.revision, changes };
}
