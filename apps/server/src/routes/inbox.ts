/** Requests (Inbox), directives, cross-graph notes, and sessions (docs/api.md). */
import {
  AckBody,
  DirectiveBody,
  EngineError,
  engine,
  type HumanRequest,
  RaiseRequestBody,
  ReasonBody,
  ResolveBody,
  ResolveNoteBody,
  RetractBody,
  SessionBody,
  SessionEventBody,
} from '@agent-graphs/core';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireCapability, resolveActor } from '../auth';
import {
  type AppContext,
  command,
  globalEvents,
  messagesFor,
  readGraph,
  resolveGraphId,
} from '../context';
import { appendEvents, loadState } from '../db/repo';
import { attempts, graphs, nodes, notes, orchestrators, requests, sessions } from '../db/schema';
import {
  annotationOf,
  createSession,
  getSession,
  sessionByClientId,
  sessionTree,
} from '../sessions';
import type { Api } from './define';
import { respond, rowToNote } from './util';

export function inboxRoutes(api: Api, app: AppContext): void {
  api.route(
    {
      method: 'get',
      path: '/requests',
      summary: 'Cross-graph inbox',
      tag: 'inbox',
      role: 'viewer',
      query: z.object({
        status: z.string().optional(),
        graph: z.string().optional(),
        kind: z.string().optional(),
        assignee: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      }),
    },
    (c, { query }) => {
      const graphId = query.graph ? resolveGraphId(app, query.graph) : undefined;
      const rows = app.db
        .select()
        .from(requests)
        .where(
          and(
            eq(requests.status, query.status ?? 'open'),
            graphId ? eq(requests.graphId, graphId) : undefined,
            query.kind ? inArray(requests.kind, query.kind.split(',')) : undefined,
            query.assignee ? eq(requests.assignee, query.assignee) : undefined,
          ),
        )
        .orderBy(desc(requests.createdAt))
        .limit(query.limit ?? 200)
        .all();
      const titles = new Map(
        app.db
          .select({ id: graphs.id, title: graphs.title, slug: graphs.slug })
          .from(graphs)
          .all()
          .map((g) => [g.id, g]),
      );
      return respond(c, { items: rows.map((r) => ({ ...r, graph: titles.get(r.graphId) })) });
    },
  );

  api.route(
    {
      method: 'post',
      path: '/graphs/:graph/requests',
      summary: 'Raise a question or approval',
      tag: 'inbox',
      role: 'agent',
      body: RaiseRequestBody,
    },
    (c, { params, body }) => {
      const out = command(app, params.graph as string, resolveActor(app, c), (s, t) => {
        const node = body.node ? engine.nodeByKey(s, body.node) : undefined;
        return engine.openRequest(s, t, {
          kind: body.kind,
          subject: body.kind === 'question' ? 'question' : 'aim',
          title: body.title,
          ...(body.body ? { body: body.body } : {}),
          ...(node ? { nodeId: node.id } : {}),
          ...(body.attempt ? { attemptId: body.attempt } : {}),
          assignee: body.assignee ?? 'any',
          blocking: body.blocking ?? false,
        });
      });
      return respond(c, out.result, 201);
    },
  );

  const requestGraph = (id: string): HumanRequest & { graphId: string } => {
    const row = app.db.select().from(requests).where(eq(requests.id, id)).get();
    if (!row)
      throw new EngineError(
        'NOT_FOUND',
        `Request ${id} not found.`,
        'List open requests with GET /api/v1/requests.',
        404,
      );
    return row as unknown as HumanRequest & { graphId: string };
  };

  api.route(
    {
      method: 'post',
      path: '/requests/:id/resolve',
      summary: 'Resolve a request (option catalog)',
      tag: 'inbox',
      role: 'agent',
      body: ResolveBody,
    },
    (c, { params, body }) => {
      const r = requestGraph(params.id as string);
      const actor = resolveActor(app, c);
      const out = command(app, r.graphId, actor, (s, t) => {
        const node = r.nodeId ? s.nodes.get(r.nodeId) : undefined;
        requireCapability(c, s, actor, r.kind === 'approval' ? 'approve' : 'resolve', node);
        return engine.resolveRequest(s, t, r.id, body);
      });
      return respond(c, {
        request: out.result,
        graph: { id: out.state.graph.id, status: out.state.graph.status },
      });
    },
  );

  api.route(
    {
      method: 'post',
      path: '/requests/:id/dismiss',
      summary: 'Dismiss a request',
      tag: 'inbox',
      role: 'admin',
      body: ReasonBody,
    },
    (c, { params, body }) => {
      const r = requestGraph(params.id as string);
      const out = command(app, r.graphId, resolveActor(app, c), (s, t) => {
        engine.dismissRequests(s, t, (x) => x.id === r.id, body.reason);
        return s.requests.get(r.id);
      });
      return respond(c, { request: out.result });
    },
  );

  api.route(
    {
      method: 'get',
      path: '/graphs/:graph/directives',
      summary: 'Directives',
      tag: 'inbox',
      role: 'viewer',
      query: z.object({ status: z.string().optional(), target: z.string().optional() }),
    },
    (c, { params, query }) => {
      const state = readGraph(app, params.graph as string);
      const items = [...state.directives.values()]
        .filter(
          (d) =>
            (!query.status || d.status === query.status) &&
            (!query.target || d.targetType === query.target),
        )
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((d) => ({ ...d, deliveries: state.deliveries.filter((x) => x.directiveId === d.id) }));
      return respond(c, { items });
    },
  );

  api.route(
    {
      method: 'post',
      path: '/graphs/:graph/directives',
      summary: 'Send a directive',
      tag: 'inbox',
      role: 'agent',
      body: DirectiveBody,
    },
    (c, { params, body }) => {
      const actor = resolveActor(app, c);
      const out = command(app, params.graph as string, actor, (s, t) => {
        requireCapability(c, s, actor, 'resolve');
        const { type, key, id } = body.target;
        let targetId: string;
        if (type === 'graph') targetId = s.graph.id;
        else if (type === 'node') targetId = engine.nodeByKey(s, key ?? '').id;
        else if (type === 'orchestrator') targetId = engine.orchestratorByKey(s, key ?? '').id;
        else if (id) targetId = id;
        else throw new EngineError('BAD_REQUEST', `A ${type} target needs an id.`, undefined, 400);
        return engine.createDirective(s, t, {
          targetType: type,
          targetId,
          kind: body.kind,
          title: body.title,
          ...(body.body ? { body: body.body } : {}),
          ...(body.data ? { data: body.data } : {}),
          ...(body.requiresAck !== undefined ? { requiresAck: body.requiresAck } : {}),
          ...(body.expiresAt ? { expiresAt: Date.parse(body.expiresAt) } : {}),
          ...(body.supersedes ? { supersedes: body.supersedes } : {}),
        });
      });
      return respond(c, out.result, 201);
    },
  );

  api.route(
    {
      method: 'post',
      path: '/directives/:id/ack',
      summary: 'Acknowledge a directive (per recipient)',
      tag: 'inbox',
      role: 'agent',
      body: AckBody,
    },
    (c, { params, body }) => {
      const row = app.db
        .select({ graphId: sql<string>`graph_id` })
        .from(sql`directives`)
        .where(sql`id = ${params.id}`)
        .get();
      if (!row)
        throw new EngineError('NOT_FOUND', `Directive ${params.id} not found.`, undefined, 404);
      const actor = resolveActor(app, c);
      const recipient = body.attemptId ?? actor.sessionId;
      if (!recipient)
        throw new EngineError(
          'BAD_REQUEST',
          'Acknowledge for an attempt (attemptId) or from a session.',
          undefined,
          400,
        );
      const out = command(app, row.graphId, actor, (s, t) =>
        engine.ackDirective(s, t, {
          directiveId: params.id as string,
          recipient,
          ...(body.note ? { note: body.note } : {}),
        }),
      );
      return respond(c, { delivery: out.result });
    },
  );

  // Notes (cross-cutting)
  api.route(
    {
      method: 'get',
      path: '/notes',
      summary: 'Cross-graph notes query',
      tag: 'notes',
      role: 'viewer',
      query: z.object({
        graph: z.string().optional(),
        type: z.string().optional(),
        severity: z.string().optional(),
        model: z.string().optional(),
        provider: z.string().optional(),
        mechanism: z.string().optional(),
        node: z.string().optional(),
        q: z.string().optional(),
        since: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      }),
    },
    (c, { query }) => {
      const graphId = query.graph ? resolveGraphId(app, query.graph) : undefined;
      let nodeId: string | undefined;
      if (graphId && query.node)
        nodeId = engine.nodeByKey(loadState(app.db, graphId) as never, query.node).id;
      const conds = [
        graphId ? eq(notes.graphId, graphId) : undefined,
        query.type ? inArray(notes.type, query.type.split(',')) : undefined,
        query.severity ? inArray(notes.severity, query.severity.split(',')) : undefined,
        nodeId ? eq(notes.nodeId, nodeId) : undefined,
        query.since ? sql`${notes.createdAt} >= ${Date.parse(query.since)}` : undefined,
        query.model ? sql`json_extract(${notes.author}, '$.model') = ${query.model}` : undefined,
        query.provider
          ? sql`json_extract(${notes.author}, '$.provider') = ${query.provider}`
          : undefined,
        query.mechanism
          ? sql`json_extract(${notes.author}, '$.mechanism') = ${query.mechanism}`
          : undefined,
        query.q
          ? sql`${notes}.rowid IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH ${ftsQuery(query.q)})`
          : undefined,
      ];
      const rows = app.db
        .select()
        .from(notes)
        .where(and(...conds))
        .orderBy(desc(notes.createdAt))
        .limit(query.limit ?? 100)
        .all();
      return respond(c, { items: rows.map((r) => rowToNote(r as Record<string, unknown>)) });
    },
  );

  const noteRow = (id: string) => {
    const row = app.db.select().from(notes).where(eq(notes.id, id)).get();
    if (!row) throw new EngineError('NOT_FOUND', `Note ${id} not found.`, undefined, 404);
    return row;
  };

  api.route(
    {
      method: 'post',
      path: '/notes/:id/retract',
      summary: 'Retract a note (additive stamp)',
      tag: 'notes',
      role: 'agent',
      body: RetractBody,
    },
    (c, { params, body }) => {
      const note = noteRow(params.id as string);
      const actor = resolveActor(app, c);
      const author = note.author as { sessionId?: string };
      if (c.get('auth').role !== 'admin' && author.sessionId !== actor.sessionId) {
        throw new EngineError(
          'FORBIDDEN',
          'Only the author or an admin can retract a note.',
          undefined,
          403,
        );
      }
      if (note.retractedAt)
        throw new EngineError('INVALID_TRANSITION', 'The note is already retracted.');
      const now = app.now();
      const stored = app.db.$client
        .transaction(() => {
          app.db
            .update(notes)
            .set({ retractedAt: now, retractedReason: body.reason, retractedBy: actor })
            .where(eq(notes.id, note.id))
            .run();
          return appendEvents(app.db, note.graphId, [
            {
              type: 'note.retracted',
              graphId: note.graphId,
              entityType: 'note',
              entityId: note.id,
              actor,
              payload: { reason: body.reason },
              createdAt: now,
            },
          ]);
        })
        .immediate();
      app.hub.publish(messagesFor(stored));
      return respond(c, rowToNote(noteRow(note.id) as Record<string, unknown>));
    },
  );

  api.route(
    {
      method: 'post',
      path: '/notes/:id/resolve',
      summary: 'Resolve a finding',
      tag: 'notes',
      role: 'agent',
      body: ResolveNoteBody,
    },
    (c, { params, body }) => {
      const note = noteRow(params.id as string);
      if (note.type !== 'finding')
        throw new EngineError('BAD_REQUEST', 'Only findings can be resolved.', undefined, 400);
      if (note.resolvedAt)
        throw new EngineError('INVALID_TRANSITION', 'The finding is already resolved.');
      const actor = resolveActor(app, c);
      const out = command(
        app,
        note.graphId,
        actor,
        (s, t) => {
          const node = note.nodeId ? s.nodes.get(note.nodeId) : undefined;
          requireCapability(c, s, actor, 'resolve', node);
          return engine.addNote(s, t, {
            type: 'comment',
            title: `Resolved: ${note.title}`,
            body: body.comment,
            replyTo: note.id,
            ...(note.nodeId ? { nodeId: note.nodeId } : {}),
          });
        },
        (_s, reply) => {
          app.db
            .update(notes)
            .set({ resolvedAt: app.now(), resolvedBy: actor, resolutionNoteId: reply.id })
            .where(eq(notes.id, note.id))
            .run();
          appendEvents(app.db, note.graphId, [
            {
              type: 'note.resolved',
              graphId: note.graphId,
              entityType: 'note',
              entityId: note.id,
              actor,
              payload: { replyId: reply.id },
              createdAt: app.now(),
            },
          ]);
        },
      );
      return respond(c, {
        finding: rowToNote(noteRow(note.id) as Record<string, unknown>),
        reply: out.result,
      });
    },
  );

  // Sessions
  api.route(
    {
      method: 'post',
      path: '/sessions',
      summary: 'Register a session',
      tag: 'sessions',
      role: 'agent',
      body: SessionBody,
    },
    (c, { body }) => {
      const existing = body.clientSessionId
        ? sessionByClientId(app, body.clientSessionId)
        : undefined;
      const row = existing ?? createSession(app, body as never, { tokenId: c.get('auth').tokenId });
      return respond(
        c,
        { session: { ...row, annotation: annotationOf(row) } },
        existing ? 200 : 201,
      );
    },
  );
  api.route(
    {
      method: 'get',
      path: '/sessions',
      summary: 'Sessions',
      tag: 'sessions',
      role: 'viewer',
      query: z.object({ status: z.string().optional(), graph: z.string().optional() }),
    },
    (c, { query }) => {
      let rows = app.db
        .select()
        .from(sessions)
        .where(query.status ? inArray(sessions.status, query.status.split(',')) : undefined)
        .orderBy(desc(sessions.lastSeenAt))
        .limit(500)
        .all();
      if (query.graph) {
        const state = readGraph(app, query.graph);
        const ids = new Set(
          [...state.attempts.values()]
            .map((a) => a.sessionId)
            .concat([...state.orchestrators.values()].map((o) => o.sessionId)),
        );
        rows = rows.filter((r) => ids.has(r.id));
      }
      return respond(c, { items: rows.map((r) => ({ ...r, annotation: annotationOf(r) })) });
    },
  );
  api.route(
    {
      method: 'patch',
      path: '/sessions/:id',
      summary: 'Update a session (for example a model switch)',
      tag: 'sessions',
      role: 'agent',
      body: SessionBody,
    },
    (c, { params, body }) => {
      const row = getSession(app, params.id as string);
      const patch: Record<string, unknown> = { lastSeenAt: app.now() };
      for (const [from, to] of [
        ['agent', 'name'],
        ['role', 'role'],
        ['model', 'model'],
        ['thinking', 'thinking'],
        ['provider', 'provider'],
        ['mechanism', 'mechanism'],
        ['version', 'version'],
        ['skills', 'skills'],
        ['meta', 'meta'],
      ] as const) {
        if ((body as Record<string, unknown>)[from] !== undefined)
          patch[to] = (body as Record<string, unknown>)[from];
      }
      app.db.update(sessions).set(patch).where(eq(sessions.id, row.id)).run();
      globalEvents(app, [
        {
          type: 'session.updated',
          graphId: '',
          entityType: 'session',
          entityId: row.id,
          actor: annotationOf(row),
          payload: patch,
          createdAt: app.now(),
        },
      ]);
      return respond(c, { session: getSession(app, row.id) });
    },
  );

  const sessionHeartbeat = (sessionId: string) => {
    const ids = sessionTree(app, sessionId);
    app.db
      .update(sessions)
      .set({ lastSeenAt: app.now(), status: 'active' })
      .where(inArray(sessions.id, ids))
      .run();
    const graphIds = app.db
      .select({ graphId: sql<string>`DISTINCT graph_id` })
      .from(sql`attempts`)
      .where(
        sql`status = 'running' AND session_id IN (${sql.join(
          ids.map((i) => sql`${i}`),
          sql`, `,
        )})`,
      )
      .all()
      .map((r) => r.graphId);
    const out: unknown[] = [];
    for (const graphId of graphIds) {
      const result = command(app, graphId, annotationOf(getSession(app, sessionId)), (s, t) => {
        const renewed = engine.renewSessionLeases(s, t, ids);
        return renewed.map((a) => {
          const fresh = engine.deliverDirectives(s, t, a, 'hook');
          const node = s.nodes.get(a.nodeId);
          return {
            id: a.id,
            nodeKey: node?.key,
            graph: s.graph.slug ?? s.graph.id,
            leaseExpiresAt: a.leaseExpiresAt,
            newDirectives: fresh,
            pauseRequested: node?.status === 'paused' || s.graph.status === 'paused',
            cancelRequested: fresh.some((d) => d.kind === 'cancel'),
          };
        });
      });
      out.push(...result.result);
    }
    return { attempts: out };
  };

  api.route(
    {
      method: 'post',
      path: '/sessions/:id/heartbeat',
      summary: 'Renew leases of a session and its descendants',
      tag: 'sessions',
      role: 'agent',
      body: z.object({}).passthrough(),
    },
    (c, { params }) => {
      getSession(app, params.id as string);
      return respond(c, sessionHeartbeat(params.id as string));
    },
  );
  api.route(
    {
      method: 'get',
      path: '/sessions/by-client/:clientSessionId',
      summary: 'Read-only lookup: session, held attempts, and orchestrator roles (for hooks)',
      tag: 'sessions',
      role: 'agent',
    },
    (c, { params }) => {
      const row = sessionByClientId(app, params.clientSessionId as string);
      if (!row) return respond(c, { session: null, attempts: [], orchestrators: [] });
      const ids = sessionTree(app, row.id);
      const held = app.db
        .select({
          id: attempts.id,
          graphId: attempts.graphId,
          nodeId: attempts.nodeId,
          status: attempts.status,
          leaseExpiresAt: attempts.leaseExpiresAt,
          sessionId: attempts.sessionId,
        })
        .from(attempts)
        .where(
          and(inArray(attempts.sessionId, ids), inArray(attempts.status, ['running', 'submitted'])),
        )
        .all();
      const nodeKeys = new Map(
        held.length
          ? app.db
              .select({ id: nodes.id, key: nodes.key })
              .from(nodes)
              .where(
                inArray(
                  nodes.id,
                  held.map((a) => a.nodeId),
                ),
              )
              .all()
              .map((n) => [n.id, n.key])
          : [],
      );
      const roles = app.db
        .select({
          graphId: orchestrators.graphId,
          key: orchestrators.key,
          status: orchestrators.status,
          leaseExpiresAt: orchestrators.leaseExpiresAt,
        })
        .from(orchestrators)
        .where(eq(orchestrators.sessionId, row.id))
        .all();
      return respond(c, {
        session: { ...row, annotation: annotationOf(row) },
        attempts: held.map((a) => ({ ...a, nodeKey: nodeKeys.get(a.nodeId) })),
        orchestrators: roles,
      });
    },
  );
  api.route(
    {
      method: 'post',
      path: '/sessions/by-client/:clientSessionId/heartbeat',
      summary: 'Hook heartbeat by the runtime session id',
      tag: 'sessions',
      role: 'agent',
      body: z.object({}).passthrough(),
    },
    (c, { params }) => {
      const row = sessionByClientId(app, params.clientSessionId as string);
      if (!row) return respond(c, { attempts: [], session: null });
      return respond(c, { ...sessionHeartbeat(row.id), session: row.id });
    },
  );
  api.route(
    {
      method: 'post',
      path: '/sessions/:id/events',
      summary: 'Client lifecycle signals (for example compaction)',
      tag: 'sessions',
      role: 'agent',
      body: SessionEventBody,
    },
    (c, { params, body }) => {
      const row = getSession(app, params.id as string);
      globalEvents(app, [
        {
          type: body.type === 'compacted' ? 'session.compacted' : 'session.updated',
          graphId: '',
          entityType: 'session',
          entityId: row.id,
          actor: annotationOf(row),
          payload: { signal: body.type, detail: body.detail },
          createdAt: app.now(),
        },
      ]);
      return respond(c, { ok: true });
    },
  );
  api.route(
    {
      method: 'post',
      path: '/sessions/:id/end',
      summary: 'End a session',
      tag: 'sessions',
      role: 'agent',
      body: z.object({}).passthrough(),
    },
    (c, { params }) => {
      const row = getSession(app, params.id as string);
      app.db
        .update(sessions)
        .set({ status: 'ended', endedAt: app.now() })
        .where(eq(sessions.id, row.id))
        .run();
      globalEvents(app, [
        {
          type: 'session.ended',
          graphId: '',
          entityType: 'session',
          entityId: row.id,
          actor: annotationOf(row),
          payload: {},
          createdAt: app.now(),
        },
      ]);
      return respond(c, { ok: true });
    },
  );
}

/** Quote each term so user input cannot inject FTS5 syntax. */
function ftsQuery(q: string): string {
  return q
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"*`)
    .join(' ');
}
