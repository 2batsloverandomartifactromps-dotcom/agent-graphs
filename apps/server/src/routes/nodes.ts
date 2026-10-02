/** Node routes (docs/api.md § Nodes) and the shared claim flow. */
import {
  type ClaimBody,
  ClaimBody as ClaimBodySchema,
  CompleteManuallyBody,
  EngineError,
  type ExecutionAnnotation,
  engine,
  NoteBody,
  ReasonBody,
  RetryBody,
  WaiveBody,
} from '@agent-graphs/core';
import type { Context } from 'hono';
import { z } from 'zod';
import { type Env, requireCapability, resolveActor } from '../auth';
import { type AppContext, command, readGraph } from '../context';
import { nodeDetail, nodeSummary } from '../read/views';
import { annotationOf, getSession, sessionForActor } from '../sessions';
import type { Api } from './define';
import { recordLessonApplications } from './lessons';
import { briefingFor, briefingOut, nodeOf, notesFor, respond } from './util';

const HEARTBEAT_EVERY = 300;

/**
 * Claim a node for the caller, or for a subagent when `dispatchedBy` names an orchestrator the
 * caller holds (the worker then gets a child session of the orchestrator's session).
 */
export function claimFor(
  app: AppContext,
  c: Context<Env>,
  graphRef: string,
  nodeKey: string,
  body: Pick<
    ClaimBody,
    'actor' | 'session' | 'skills' | 'dispatchedBy' | 'briefing' | 'clientSessionId'
  >,
) {
  const before = readGraph(app, graphRef);
  const node = nodeOf(before, nodeKey);
  let actor: ExecutionAnnotation;
  let dispatchedBy: (ExecutionAnnotation & { orchestratorKey?: string }) | undefined;
  let skills = body.skills;
  if (body.dispatchedBy) {
    const caller = resolveActor(app, c, { ...(body.session ? { session: body.session } : {}) });
    const orch = [...before.orchestrators.values()].find((o) => o.key === body.dispatchedBy);
    if (!orch)
      throw new EngineError(
        'NOT_FOUND',
        `Orchestrator '${body.dispatchedBy}' does not exist.`,
        undefined,
        404,
      );
    requireCapability(c, before, caller, 'dispatch', node);
    const parent = orch.sessionId ?? caller.sessionId;
    const child = sessionForActor(
      app,
      { kind: 'agent', ...body.actor },
      {
        ...(parent ? { parentSessionId: parent } : {}),
        tokenId: c.get('auth').tokenId,
        ...(skills ? { skills } : {}),
      },
    );
    actor = {
      ...annotationOf(child),
      ...body.actor,
      sessionId: child.id,
      ...(parent ? { parentSessionId: parent } : {}),
    } as ExecutionAnnotation;
    dispatchedBy = { ...caller, orchestratorKey: orch.key };
  } else {
    const withClient = body.clientSessionId
      ? { ...body.actor, clientSessionId: body.clientSessionId }
      : body.actor;
    actor = resolveActor(app, c, {
      ...(withClient ? { actor: withClient } : {}),
      ...(body.session ? { session: body.session } : {}),
      ...(skills ? { skills } : {}),
    });
    if (!skills && actor.sessionId) skills = getSession(app, actor.sessionId).skills as string[];
  }
  const out = command(app, graphRef, actor, (s, tx) => {
    const attempt = engine.claim(s, tx, {
      nodeId: node.id,
      actor,
      ...(skills ? { skills } : {}),
      ...(dispatchedBy ? { dispatchedBy } : {}),
    });
    const directives = engine.deliverDirectives(s, tx, attempt, 'claim');
    return { attempt, directives };
  });
  const attempt = out.state.attempts.get(out.result.attempt.id) ?? out.result.attempt;
  const fresh = out.state.nodes.get(node.id) ?? node;
  const result: Record<string, unknown> = {
    attempt,
    lease: {
      expiresAt: attempt.leaseExpiresAt,
      ttlSeconds: fresh.leaseTtlSec,
      heartbeatEvery: HEARTBEAT_EVERY,
    },
    directives: out.result.directives,
    session: actor.sessionId,
  };
  if (body.briefing) {
    const b = briefingFor(app, out.state, fresh, attempt, body.briefing);
    recordLessonApplications(app, attempt.id, b.lessonIds);
    result.briefing = briefingOut(b, body.briefing.format);
  }
  return result;
}

const ListQuery = z.object({
  status: z.string().optional(),
  tag: z.string().optional(),
  kind: z.string().optional(),
});

export function nodeRoutes(api: Api, app: AppContext): void {
  api.route(
    {
      method: 'get',
      path: '/graphs/:graph/nodes',
      summary: 'Node summaries',
      tag: 'nodes',
      role: 'viewer',
      query: ListQuery,
    },
    (c, { params, query }) => {
      const state = readGraph(app, params.graph as string);
      const statuses = query.status?.split(',');
      const items = [...state.nodes.values()]
        .filter(
          (n) =>
            (!statuses || statuses.includes(n.status)) &&
            (!query.tag || n.tags.includes(query.tag)) &&
            (!query.kind || n.kind === query.kind),
        )
        .map((n) => nodeSummary(state, n));
      return respond(c, { items });
    },
  );

  api.route(
    {
      method: 'get',
      path: '/graphs/:graph/nodes/:node',
      summary: 'NodeDetail',
      tag: 'nodes',
      role: 'viewer',
    },
    (c, { params }) => {
      const state = readGraph(app, params.graph as string);
      const node = nodeOf(state, params.node as string);
      c.header('ETag', `"${node.version}"`);
      return respond(c, nodeDetail(state, node, notesFor(app, state.graph.id, [node.id])));
    },
  );

  api.route(
    {
      method: 'patch',
      path: '/graphs/:graph/nodes/:node',
      summary: 'Edit node configuration',
      tag: 'nodes',
      role: 'agent',
      body: z.record(z.string(), z.unknown()),
    },
    (c, { params, body }) => {
      const actor = resolveActor(app, c);
      const ifMatch = c.req.header('if-match')?.replace(/"/g, '');
      const out = command(app, params.graph as string, actor, (s, tx) => {
        const node = nodeOf(s, params.node as string);
        if (ifMatch && Number(ifMatch) !== node.version) {
          throw new EngineError(
            'CONFLICT',
            `Version mismatch: current is ${node.version}.`,
            'Refetch the node and retry.',
            409,
            { version: node.version },
          );
        }
        requireCapability(c, s, actor, 'mutate', node);
        return engine.applyMutations(
          s,
          tx,
          { updateNodes: [{ ...body, key: node.key }] },
          { admin: c.get('auth').role === 'admin' },
        );
      });
      const node = nodeOf(out.state, params.node as string);
      c.header('ETag', `"${node.version}"`);
      return respond(c, { node: nodeDetail(out.state, node, []), mutation: out.result });
    },
  );

  api.route(
    {
      method: 'get',
      path: '/graphs/:graph/nodes/:node/briefing',
      summary: 'Briefing preview (does not mark directives delivered)',
      tag: 'nodes',
      role: 'viewer',
      query: z.object({
        budget: z.coerce.number().int().min(500).max(200_000).optional(),
        format: z.enum(['md', 'json']).optional(),
        protocol: z.enum(['true', 'false']).optional(),
      }),
    },
    (c, { params, query }) => {
      const state = readGraph(app, params.graph as string);
      const node = nodeOf(state, params.node as string);
      const b = briefingFor(app, state, node, undefined, {
        ...(query.budget ? { budget: query.budget } : {}),
        protocol: query.protocol !== 'false',
      });
      if (query.format === 'json') return respond(c, briefingOut(b, 'json'));
      return c.text(b.markdown, 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
    },
  );

  api.route(
    {
      method: 'post',
      path: '/graphs/:graph/nodes/:node/claim',
      summary: 'Claim a ready node',
      tag: 'work',
      role: 'agent',
      body: ClaimBodySchema,
    },
    (c, { params, body }) => {
      return respond(c, claimFor(app, c, params.graph as string, params.node as string, body), 201);
    },
  );

  const action = (
    name: string,
    summary: string,
    capability: 'resolve' | null,
    schema: z.ZodType,
    fn: (
      s: Parameters<typeof engine.skip>[0],
      t: Parameters<typeof engine.skip>[1],
      nodeId: string,
      body: Record<string, unknown>,
    ) => unknown,
  ) => {
    api.route(
      {
        method: 'post',
        path: `/graphs/:graph/nodes/:node/${name}`,
        summary,
        tag: 'nodes',
        role: capability ? 'agent' : 'admin',
        body: schema,
      },
      (c, { params, body }) => {
        const actor = resolveActor(app, c);
        const out = command(app, params.graph as string, actor, (s, t) => {
          const node = nodeOf(s, params.node as string);
          if (capability) requireCapability(c, s, actor, capability, node);
          return fn(s, t, node.id, body as Record<string, unknown>);
        });
        return respond(c, {
          node: nodeSummary(out.state, nodeOf(out.state, params.node as string)),
          result: out.result,
        });
      },
    );
  };
  const empty = z.object({}).passthrough();
  action('pause', 'Pause a node', 'resolve', empty, (s, t, id) => engine.pauseNode(s, t, id));
  action('resume', 'Resume a node', 'resolve', empty, (s, t, id) => engine.resumeNode(s, t, id));
  action('skip', 'Skip a node (reason required)', 'resolve', ReasonBody, (s, t, id, b) =>
    engine.skip(s, t, id, b.reason as string),
  );
  action('fail', 'Fail a node (reason required)', 'resolve', ReasonBody, (s, t, id, b) =>
    engine.failNodeAction(s, t, id, b.reason as string),
  );
  action('retry', 'Grant attempts and return to ready', 'resolve', RetryBody, (s, t, id, b) =>
    engine.retry(s, t, id, b.extraAttempts as number),
  );
  action(
    'reopen',
    'Reopen (cascades to started descendants)',
    null,
    z.object({ reason: z.string().optional() }),
    (s, t, id, b) => engine.reopenNode(s, t, id, (b.reason as string) ?? 'reopened'),
  );
  action(
    'complete-manually',
    'Record work done outside the system',
    null,
    CompleteManuallyBody,
    (s, t, id, b) => {
      const { notes: extraNotes, ...input } = b as z.infer<typeof CompleteManuallyBody>;
      const out = engine.completeManually(s, t, { nodeId: id, ...input } as Parameters<
        typeof engine.completeManually
      >[2]);
      for (const n of extraNotes ?? []) engine.addNote(s, t, { ...n, attemptId: out.attempt.id });
      return out;
    },
  );

  api.route(
    {
      method: 'get',
      path: '/graphs/:graph/nodes/:node/attempts',
      summary: 'Attempts of a node',
      tag: 'nodes',
      role: 'viewer',
    },
    (c, { params }) => {
      const state = readGraph(app, params.graph as string);
      const node = nodeOf(state, params.node as string);
      return respond(c, { items: engine.attemptsOf(state, node.id) });
    },
  );

  api.route(
    {
      method: 'get',
      path: '/graphs/:graph/nodes/:node/notes',
      summary: 'Notes on a node',
      tag: 'notes',
      role: 'viewer',
      query: z.object({ type: z.string().optional() }),
    },
    (c, { params, query }) => {
      const state = readGraph(app, params.graph as string);
      const node = nodeOf(state, params.node as string);
      return respond(c, {
        items: notesFor(app, state.graph.id, [node.id]).filter(
          (n) => !query.type || n.type === query.type,
        ),
      });
    },
  );

  api.route(
    {
      method: 'post',
      path: '/graphs/:graph/nodes/:node/notes',
      summary: 'Add a node-level note',
      tag: 'notes',
      role: 'agent',
      body: NoteBody,
    },
    (c, { params, body }) => {
      const out = command(app, params.graph as string, resolveActor(app, c), (s, t) =>
        engine.addNote(s, t, { ...body, nodeId: nodeOf(s, params.node as string).id }),
      );
      return respond(c, out.result, 201);
    },
  );

  api.route(
    {
      method: 'post',
      path: '/graphs/:graph/nodes/:node/aims/:aim/waive',
      summary: 'Waive a node aim',
      tag: 'nodes',
      role: 'agent',
      body: WaiveBody,
    },
    (c, { params, body }) => {
      const actor = resolveActor(app, c);
      const out = command(app, params.graph as string, actor, (s, t) => {
        const node = nodeOf(s, params.node as string);
        requireCapability(c, s, actor, 'resolve', node);
        engine.waiveAim(
          s,
          t,
          engine.aimByKey(s, 'node', node.id, params.aim as string),
          body.justification,
        );
      });
      return respond(c, { node: nodeSummary(out.state, nodeOf(out.state, params.node as string)) });
    },
  );
}
