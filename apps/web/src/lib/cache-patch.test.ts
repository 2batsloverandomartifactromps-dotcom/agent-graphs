import type {
  GraphSummary,
  GraphView,
  HumanRequest,
  LiveEvent,
  NodeSummary,
} from '@agent-graphs/sdk';
import { describe, expect, it } from 'vitest';
import {
  patchGraphList,
  patchGraphView,
  patchOpenRequests,
  pulseTarget,
  REFETCH,
  touchedNodeIds,
} from './cache-patch';
import { toWire } from './wire';

const T0 = Date.parse('2026-10-02T12:00:00Z');

function node(id: string, key: string, status: NodeSummary['status']): NodeSummary {
  return {
    id,
    key,
    title: key,
    kind: 'task',
    status,
    priority: 'p2',
    tags: [],
    executor: {},
    activation: 1,
    countedAttempts: 0,
    maxAttempts: 3,
    attemptsTotal: 0,
    acceptedWithDeviation: false,
    manual: false,
    aims: [
      {
        key: 'a',
        title: 'A',
        kind: 'qualitative',
        terminating: true,
        status: 'pending',
        evaluator: 'self',
        implicit: false,
      },
    ],
    openRequests: 0,
    updatedAt: new Date(T0).toISOString(),
  } as NodeSummary;
}

function view(): GraphView {
  return {
    graph: {
      id: 'gr_1',
      title: 'G',
      status: 'active',
      counts: { ready: 1, pending: 1 },
    } as GraphView['graph'],
    aims: [],
    nodes: [node('nd_1', 'one', 'ready'), node('nd_2', 'two', 'pending')],
    edges: [],
    loops: [
      {
        id: 'lp_1',
        key: 'cycle',
        iteration: 1,
        status: 'idle',
        from: 'two',
        to: 'one',
        bodyKeys: ['one', 'two'],
      } as GraphView['loops'][number],
    ],
    orchestrators: [],
    requests: [],
    criticalPath: [],
  };
}

function ev(partial: Partial<LiveEvent>): LiveEvent {
  return {
    seq: 1,
    type: 'node.status_changed',
    graphId: 'gr_1',
    entity: { type: 'node', id: 'nd_1' },
    actor: { kind: 'agent' },
    payload: {},
    createdAt: new Date(T0).toISOString(),
    ...partial,
  };
}

describe('toWire', () => {
  it('converts epoch-ms …At fields to ISO strings, recursively', () => {
    expect(toWire({ updatedAt: T0, nested: [{ startedAt: T0, count: 3 }], at: 5 })).toEqual({
      updatedAt: '2026-10-02T12:00:00.000Z',
      nested: [{ startedAt: '2026-10-02T12:00:00.000Z', count: 3 }],
      at: 5,
    });
  });
});

describe('patchGraphView', () => {
  it('replaces a node from its snapshot', () => {
    const snap = { ...node('nd_1', 'one', 'running'), updatedAt: T0 };
    const out = patchGraphView(view(), ev({ snapshot: snap }));
    expect(out).not.toBe(REFETCH);
    const v = out as GraphView;
    expect(v.nodes[0]?.status).toBe('running');
    expect(v.nodes[0]?.updatedAt).toBe('2026-10-02T12:00:00.000Z');
    expect(v.nodes[1]?.status).toBe('pending');
  });

  it('recomputes derived summary fields from nodes', () => {
    const snap = { ...node('nd_1', 'one', 'done'), updatedAt: T0 };
    const v = patchGraphView(view(), ev({ snapshot: snap })) as GraphView;
    expect(v.graph.counts).toEqual({ done: 1, pending: 1 });
    expect(v.graph.progress).toBe(0.5);
    expect(v.graph.total).toBe(2);
  });

  it('ignores events from other graphs', () => {
    expect(patchGraphView(view(), ev({ graphId: 'gr_2' }))).toBeUndefined();
  });

  it('asks for a refetch on structural events and unknown nodes', () => {
    expect(patchGraphView(view(), ev({ type: 'node.created' }))).toBe(REFETCH);
    expect(
      patchGraphView(
        view(),
        ev({ entity: { type: 'node', id: 'nd_9' }, snapshot: node('nd_9', 'x', 'ready') }),
      ),
    ).toBe(REFETCH);
  });

  it('merges graph summaries', () => {
    const out = patchGraphView(
      view(),
      ev({
        type: 'graph.paused',
        entity: { type: 'graph', id: 'gr_1' },
        snapshot: { id: 'gr_1', status: 'paused', updatedAt: T0 },
      }),
    ) as GraphView;
    expect(out.graph.status).toBe('paused');
    expect(out.graph.title).toBe('G');
  });

  it('sets the current attempt from an attempt snapshot', () => {
    const out = patchGraphView(
      view(),
      ev({
        type: 'attempt.progress',
        entity: { type: 'attempt', id: 'at_1' },
        snapshot: {
          id: 'at_1',
          status: 'running',
          progress: 64,
          currentStep: 'Fixing',
          nodeKey: 'one',
          startedAt: T0,
        },
      }),
    ) as GraphView;
    expect(out.nodes[0]?.currentAttempt?.progress).toBe(64);
    expect(out.nodes[0]?.currentAttempt?.startedAt).toBe('2026-10-02T12:00:00.000Z');
  });

  it('adds open requests and removes resolved ones', () => {
    const req = {
      id: 'rq_1',
      status: 'open',
      kind: 'approval',
      subject: 'gate',
      title: 'Approve',
      createdAt: T0,
    };
    const added = patchGraphView(
      view(),
      ev({ type: 'request.created', entity: { type: 'request', id: 'rq_1' }, snapshot: req }),
    ) as GraphView;
    expect(added.requests).toHaveLength(1);
    const removed = patchGraphView(
      added,
      ev({
        type: 'request.resolved',
        entity: { type: 'request', id: 'rq_1' },
        snapshot: { ...req, status: 'resolved' },
      }),
    ) as GraphView;
    expect(removed.requests).toHaveLength(0);
  });

  it('patches loops while keeping derived keys', () => {
    const out = patchGraphView(
      view(),
      ev({
        type: 'loop.iterated',
        entity: { type: 'loop', id: 'lp_1' },
        snapshot: { id: 'lp_1', key: 'cycle', iteration: 2, status: 'active' },
      }),
    ) as GraphView;
    expect(out.loops[0]?.iteration).toBe(2);
    expect(out.loops[0]?.bodyKeys).toEqual(['one', 'two']);
  });

  it('patches node aim verdicts', () => {
    const out = patchGraphView(
      view(),
      ev({
        type: 'aim.evaluated',
        entity: { type: 'aim', id: 'am_1' },
        snapshot: { id: 'am_1', ownerType: 'node', ownerId: 'nd_2', key: 'a', status: 'met' },
      }),
    ) as GraphView;
    expect(out.nodes[1]?.aims[0]?.status).toBe('met');
  });
});

describe('patchGraphList and patchOpenRequests', () => {
  it('patches list rows from graph snapshots', () => {
    const items = [{ id: 'gr_1', title: 'G', status: 'active' } as GraphSummary];
    const out = patchGraphList(
      items,
      ev({ entity: { type: 'graph', id: 'gr_1' }, snapshot: { id: 'gr_1', status: 'completed' } }),
    );
    expect((out as GraphSummary[])[0]?.status).toBe('completed');
    expect(
      patchGraphList(items, ev({ type: 'graph.created', entity: { type: 'graph', id: 'gr_2' } })),
    ).toBe(REFETCH);
  });

  it('drops resolved requests and refetches for new ones', () => {
    const items = [
      { id: 'rq_1', status: 'open', graph: { id: 'gr_1', title: 'G' } } as HumanRequest,
    ];
    expect(
      patchOpenRequests(
        items,
        ev({
          entity: { type: 'request', id: 'rq_1' },
          snapshot: { id: 'rq_1', status: 'resolved' },
        }),
      ),
    ).toEqual([]);
    expect(
      patchOpenRequests(
        items,
        ev({ entity: { type: 'request', id: 'rq_2' }, snapshot: { id: 'rq_2', status: 'open' } }),
      ),
    ).toBe(REFETCH);
  });
});

describe('touchedNodeIds', () => {
  it('resolves node ids from node, attempt and payload references', () => {
    const v = view();
    expect(touchedNodeIds(v, ev({}))).toEqual(['nd_1']);
    expect(
      touchedNodeIds(
        v,
        ev({ entity: { type: 'attempt', id: 'at_1' }, snapshot: { nodeKey: 'two' } }),
      ),
    ).toEqual(['nd_2']);
    expect(
      touchedNodeIds(v, ev({ entity: { type: 'request', id: 'rq' }, payload: { nodeId: 'nd_2' } })),
    ).toEqual(['nd_2']);
  });
});

describe('pulseTarget', () => {
  it('maps a dispatch to its orchestrator and node', () => {
    const e = ev({
      type: 'orchestrator.dispatched',
      entity: { type: 'attempt', id: 'at_1' },
      payload: { orchestratorKey: 'lead', nodeKey: 'one' },
    });
    expect(pulseTarget(view(), e)).toEqual({ orch: 'lead', nodeKey: 'one' });
  });

  it('maps an orchestrator evaluation through its session and the attempt', () => {
    const v = view();
    v.orchestrators = [
      { key: 'reviewer', sessionId: 'ss_9' } as GraphView['orchestrators'][number],
    ];
    v.nodes[1] = { ...(v.nodes[1] as NodeSummary), currentAttempt: { id: 'at_7' } } as NodeSummary;
    const e = ev({
      type: 'aim.evaluated',
      entity: { type: 'aim', id: 'am_1' },
      actor: { kind: 'agent', sessionId: 'ss_9' },
      payload: { attemptId: 'at_7', evaluatorKind: 'orchestrator' },
    });
    expect(pulseTarget(v, e)).toEqual({ orch: 'reviewer', nodeKey: 'two' });
    expect(pulseTarget(v, { ...e, payload: { attemptId: 'at_7', evaluatorKind: 'human' } })).toBe(
      undefined,
    );
  });
});
