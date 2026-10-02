/** Edges, loops, aims, and orchestrator routes (docs/api.md). */
import {
  AttachBody,
  DetachBody,
  EngineError,
  ExtendLoopBody,
  engine,
  GraphAimEvaluationBody,
  NoteBody,
  PatchEdgeBody,
  WaiveBody,
} from '@agent-graphs/core';
import { z } from 'zod';
import { requireCapability, resolveActor } from '../auth';
import { type AppContext, command, readGraph } from '../context';
import { loadState } from '../db/repo';
import { graphs } from '../db/schema';
import type { Api } from './define';
import { respond } from './util';

const EdgeCreate = z.object({
  from: z.string(),
  to: z.string(),
  kind: z.enum(['requires', 'informs']).optional(),
  label: z.string().optional(),
  relation: z.string().optional(),
  condition: z.string().optional(),
  guidance: z.string().optional(),
  pitfalls: z.string().optional(),
});

export function structureRoutes(api: Api, app: AppContext): void {
  const mutate = (
    graphRef: string,
    c: Parameters<Parameters<Api['route']>[1]>[0],
    batch: engine.MutationBatch,
  ) => {
    const actor = resolveActor(app, c);
    return command(app, graphRef, actor, (s, tx) => {
      requireCapability(c, s, actor, 'mutate');
      return engine.applyMutations(s, tx, batch, { admin: c.get('auth').role === 'admin' });
    });
  };
  const edgeById = (state: ReturnType<typeof readGraph>, id: string) => {
    const e = state.edges.find((x) => x.id === id);
    if (!e) throw new EngineError('NOT_FOUND', `Edge ${id} not found.`, undefined, 404);
    const key = (nid: string) => state.nodes.get(nid)?.key as string;
    return { edge: e, from: key(e.fromNodeId), to: key(e.toNodeId) };
  };

  api.route(
    {
      method: 'post',
      path: '/graphs/:graph/edges',
      summary: 'Add an edge',
      tag: 'structure',
      role: 'agent',
      body: EdgeCreate,
    },
    (c, { params, body }) => {
      const out = mutate(params.graph as string, c, { addEdges: [body as engine.EdgeSpec] });
      return respond(c, out.result, 201);
    },
  );
  api.route(
    {
      method: 'patch',
      path: '/graphs/:graph/edges/:id',
      summary: 'Set edge label and procedural attributes',
      tag: 'structure',
      role: 'agent',
      body: PatchEdgeBody,
    },
    (c, { params, body }) => {
      const { edge, from, to } = edgeById(
        readGraph(app, params.graph as string),
        params.id as string,
      );
      const attrs = Object.fromEntries(Object.entries(body).map(([k, v]) => [k, v ?? undefined]));
      const out = mutate(params.graph as string, c, {
        updateEdges: [{ from, to, kind: edge.kind, ...attrs } as engine.EdgeSpec],
      });
      return respond(c, out.result);
    },
  );
  api.route(
    {
      method: 'delete',
      path: '/graphs/:graph/edges/:id',
      summary: 'Remove an edge',
      tag: 'structure',
      role: 'agent',
    },
    (c, { params }) => {
      const { edge, from, to } = edgeById(
        readGraph(app, params.graph as string),
        params.id as string,
      );
      const out = mutate(params.graph as string, c, {
        removeEdges: [{ from, to, kind: edge.kind }],
      });
      return respond(c, out.result);
    },
  );

  api.route(
    {
      method: 'get',
      path: '/graphs/:graph/loops',
      summary: 'Loops',
      tag: 'structure',
      role: 'viewer',
    },
    (c, { params }) => {
      const state = readGraph(app, params.graph as string);
      return respond(c, { items: state.loops });
    },
  );
  api.route(
    {
      method: 'patch',
      path: '/graphs/:graph/loops/:key',
      summary: 'Edit a loop',
      tag: 'structure',
      role: 'agent',
      body: z.record(z.string(), z.unknown()),
    },
    (c, { params, body }) => {
      const out = mutate(params.graph as string, c, {
        updateLoops: [{ ...body, key: params.key as string }],
      });
      return respond(c, out.result);
    },
  );
  api.route(
    {
      method: 'post',
      path: '/graphs/:graph/loops/:key/extend',
      summary: 'Grant iterations (fires an exhausted loop)',
      tag: 'structure',
      role: 'agent',
      body: ExtendLoopBody,
    },
    (c, { params, body }) => {
      const actor = resolveActor(app, c);
      const out = command(app, params.graph as string, actor, (s, t) => {
        requireCapability(c, s, actor, 'resolve');
        engine.extendLoop(s, t, params.key as string, body.extraIterations, body.reason);
      });
      return respond(c, { loop: engine.loopByKey(out.state, params.key as string) });
    },
  );

  api.route(
    {
      method: 'get',
      path: '/graphs/:graph/aims',
      summary: 'Graph and node aims with status',
      tag: 'structure',
      role: 'viewer',
    },
    (c, { params }) => {
      const state = readGraph(app, params.graph as string);
      return respond(c, {
        graph: engine
          .graphAims(state)
          .map((a) => ({ ...a, liveValue: a.metric ? engine.aimValue(state, a) : undefined })),
        nodes: [...state.nodes.values()].map((n) => ({
          key: n.key,
          aims: engine.aimsOf(state, 'node', n.id),
        })),
      });
    },
  );
  api.route(
    {
      method: 'post',
      path: '/graphs/:graph/aims/:aim/evaluations',
      summary: 'Judge a graph aim during verifying',
      tag: 'structure',
      role: 'agent',
      body: GraphAimEvaluationBody,
    },
    (c, { params, body }) => {
      const actor = resolveActor(app, c);
      const out = command(app, params.graph as string, actor, (s, t) => {
        requireCapability(c, s, actor, 'evaluate');
        return engine.evaluateGraphAim(s, t, { aim: params.aim as string, ...body });
      });
      return respond(c, { aim: out.result, graphStatus: out.state.graph.status }, 201);
    },
  );
  api.route(
    {
      method: 'post',
      path: '/graphs/:graph/aims/:aim/waive',
      summary: 'Waive a graph aim',
      tag: 'structure',
      role: 'agent',
      body: WaiveBody,
    },
    (c, { params, body }) => {
      const actor = resolveActor(app, c);
      const out = command(app, params.graph as string, actor, (s, t) => {
        requireCapability(c, s, actor, 'resolve');
        engine.waiveAim(
          s,
          t,
          engine.aimByKey(s, 'graph', s.graph.id, params.aim as string),
          body.justification,
        );
      });
      return respond(c, { graphStatus: out.state.graph.status });
    },
  );

  api.route(
    {
      method: 'get',
      path: '/evaluations/pending',
      summary: 'Submitted attempts awaiting agent verdicts (excluding your own)',
      tag: 'work',
      role: 'agent',
      query: z.object({ graph: z.string().optional() }),
    },
    (c, { query }) => {
      const actor = resolveActor(app, c);
      const ids = query.graph
        ? [readGraph(app, query.graph).graph.id]
        : app.db
            .select({ id: graphs.id })
            .from(graphs)
            .all()
            .map((g) => g.id);
      const items = ids.flatMap((id) => {
        const state = loadState(app.db, id);
        if (!state) return [];
        return engine.pendingAgentEvaluations(state, actor).map((p) => ({
          graph: state.graph.slug ?? state.graph.id,
          attempt: p.attempt,
          node: { key: p.node.key, title: p.node.title },
          aims: p.aims,
        }));
      });
      return respond(c, { items });
    },
  );

  // Orchestrators
  api.route(
    {
      method: 'get',
      path: '/graphs/:graph/orchestrators',
      summary: 'Orchestrators',
      tag: 'orchestrators',
      role: 'viewer',
    },
    (c, { params }) => {
      const state = readGraph(app, params.graph as string);
      return respond(c, {
        items: [...state.orchestrators.values()].map((o) => ({
          ...o,
          queue: engine.dutyQueue(state, o.id, app.now()).length,
        })),
      });
    },
  );
  api.route(
    {
      method: 'post',
      path: '/graphs/:graph/orchestrators',
      summary: 'Add an orchestrator',
      tag: 'orchestrators',
      role: 'agent',
      body: z.record(z.string(), z.unknown()),
    },
    (c, { params, body }) => {
      const out = mutate(params.graph as string, c, { addOrchestrators: [body] });
      return respond(c, out.result, 201);
    },
  );
  api.route(
    {
      method: 'patch',
      path: '/graphs/:graph/orchestrators/:key',
      summary: 'Edit an orchestrator',
      tag: 'orchestrators',
      role: 'agent',
      body: z.record(z.string(), z.unknown()),
    },
    (c, { params, body }) => {
      const out = mutate(params.graph as string, c, {
        updateOrchestrators: [{ ...body, key: params.key as string }],
      });
      return respond(c, out.result);
    },
  );
  api.route(
    {
      method: 'post',
      path: '/graphs/:graph/orchestrators/:key/attach',
      summary: 'Take the orchestrator lease',
      tag: 'orchestrators',
      role: 'agent',
      body: AttachBody,
    },
    (c, { params, body }) => {
      const actor = resolveActor(app, c, body);
      if (!actor.sessionId) {
        throw new EngineError(
          'BAD_REQUEST',
          'Attaching needs a session.',
          'Send X-Agent-Session, a session field, or an actor annotation.',
          400,
        );
      }
      const out = command(app, params.graph as string, actor, (s, t) =>
        engine.attachOrchestrator(s, t, {
          key: params.key as string,
          sessionId: actor.sessionId as string,
        }),
      );
      const o = out.result;
      return respond(c, {
        orchestrator: o,
        session: actor.sessionId,
        lease: {
          expiresAt: o.leaseExpiresAt,
          ttlSeconds: engine.ORCHESTRATOR_LEASE_SEC,
          heartbeatEvery: 300,
        },
        queue: engine.dutyQueue(out.state, o.id, app.now()),
      });
    },
  );
  api.route(
    {
      method: 'post',
      path: '/graphs/:graph/orchestrators/:key/heartbeat',
      summary: 'Renew the orchestrator lease',
      tag: 'orchestrators',
      role: 'agent',
      body: z.object({}).passthrough(),
    },
    (c, { params }) => {
      const actor = resolveActor(app, c);
      const out = command(app, params.graph as string, actor, (s, t) =>
        engine.heartbeatOrchestrator(s, t, {
          key: params.key as string,
          ...(actor.sessionId ? { sessionId: actor.sessionId } : {}),
        }),
      );
      const directives = [...out.state.directives.values()].filter(
        (d) =>
          d.targetType === 'orchestrator' && d.targetId === out.result.id && d.status === 'pending',
      );
      return respond(c, {
        leaseExpiresAt: out.result.leaseExpiresAt,
        directives,
        pauseRequested: out.state.graph.status === 'paused',
        cancelRequested: out.state.graph.status === 'cancelled',
        briefingChanged: false,
      });
    },
  );
  api.route(
    {
      method: 'get',
      path: '/graphs/:graph/orchestrators/:key/queue',
      summary: 'Duty queue',
      tag: 'orchestrators',
      role: 'viewer',
    },
    (c, { params }) => {
      const state = readGraph(app, params.graph as string);
      return respond(c, {
        items: engine.dutyQueue(
          state,
          engine.orchestratorByKey(state, params.key as string).id,
          app.now(),
        ),
      });
    },
  );
  api.route(
    {
      method: 'post',
      path: '/graphs/:graph/orchestrators/:key/notes',
      summary: 'Orchestrator note',
      tag: 'orchestrators',
      role: 'agent',
      body: NoteBody,
    },
    (c, { params, body }) => {
      const out = command(app, params.graph as string, resolveActor(app, c), (s, t) =>
        engine.addNote(s, t, {
          ...body,
          orchestratorId: engine.orchestratorByKey(s, params.key as string).id,
        }),
      );
      return respond(c, out.result, 201);
    },
  );
  api.route(
    {
      method: 'post',
      path: '/graphs/:graph/orchestrators/:key/detach',
      summary: 'Release the orchestrator lease',
      tag: 'orchestrators',
      role: 'agent',
      body: DetachBody,
    },
    (c, { params, body }) => {
      const actor = resolveActor(app, c);
      const out = command(app, params.graph as string, actor, (s, t) =>
        engine.detachOrchestrator(s, t, {
          key: params.key as string,
          ...(actor.sessionId ? { sessionId: actor.sessionId } : {}),
          ...(body.handoff ? { handoff: body.handoff } : {}),
        }),
      );
      return respond(c, { orchestrator: out.result });
    },
  );
  for (const action of ['pause', 'resume', 'stop'] as const) {
    api.route(
      {
        method: 'post',
        path: `/graphs/:graph/orchestrators/:key/${action}`,
        summary: `${action} an orchestrator role`,
        tag: 'orchestrators',
        role: 'admin',
      },
      (c, { params }) => {
        const out = command(app, params.graph as string, resolveActor(app, c), (s, t) =>
          engine.setOrchestratorStatus(s, t, params.key as string, action),
        );
        return respond(c, { orchestrator: out.result });
      },
    );
  }
}
