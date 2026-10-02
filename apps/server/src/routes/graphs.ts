/** Graph routes (docs/api.md § Graphs). */
import {
  CreateGraphBody,
  EngineError,
  engine,
  MutationBody,
  metricList,
  NextBody,
  NoteBody,
  OptionalReasonBody,
  ReasonBody,
  renderSitrep,
  toSpecInput,
  toSpecYaml,
  type ValidationResult,
  validateSpec,
  validateSpecText,
  verifyChain,
} from '@agent-graphs/core';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireCapability, resolveActor } from '../auth';
import { type AppContext, command, createGraph, readGraph, resolveGraphId } from '../context';
import { graphEvents, loadState } from '../db/repo';
import { evaluations, events, graphs, notes } from '../db/schema';
import { graphSummary, graphView, toApi } from '../read/views';
import type { Api } from './define';
import { claimFor } from './nodes';
import { graphNotes, respond, rowToNote } from './util';

function parseSpec(body: z.infer<typeof CreateGraphBody>): ValidationResult {
  return body.format === 'yaml' ? validateSpecText(body.spec) : validateSpec(body.spec);
}

function requireValid(result: ValidationResult) {
  if (!result.ok || !result.normalized) {
    throw new EngineError(
      'VALIDATION_FAILED',
      `The spec has ${result.errors.length} error(s): ${result.errors
        .slice(0, 3)
        .map((e) => `${e.path}: ${e.message}`)
        .join('; ')}`,
      result.errors[0]?.hint ?? 'Validate with POST /api/v1/graphs/validate and fix each issue.',
      400,
      result.errors,
    );
  }
  return result.normalized;
}

const ListQuery = z.object({
  status: z.string().optional(),
  tag: z.string().optional(),
  q: z.string().optional(),
  archived: z.enum(['true', 'false', 'all']).optional(),
  stalled: z.enum(['true', 'false']).optional(),
  sort: z.enum(['activity', 'created', 'title', 'progress']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export function graphRoutes(api: Api, app: AppContext): void {
  api.route(
    {
      method: 'get',
      path: '/graphs',
      summary: 'List graphs',
      tag: 'graphs',
      role: 'viewer',
      query: ListQuery,
    },
    (c, { query }) => {
      const statuses = query.status?.split(',');
      const rows = app.db
        .select({ id: graphs.id })
        .from(graphs)
        .where(
          and(
            statuses ? inArray(graphs.status, statuses) : undefined,
            query.archived === 'true'
              ? sql`${graphs.archivedAt} IS NOT NULL`
              : query.archived === 'all'
                ? undefined
                : sql`${graphs.archivedAt} IS NULL`,
            query.stalled ? eq(graphs.stalled, query.stalled === 'true') : undefined,
          ),
        )
        .orderBy(desc(graphs.lastActivityAt))
        .all();
      let items = rows.map((r) =>
        graphSummary(loadState(app.db, r.id) as NonNullable<ReturnType<typeof loadState>>),
      );
      if (query.tag) items = items.filter((g) => g.tags.includes(query.tag as string));
      if (query.q) {
        const q = query.q.toLowerCase();
        items = items.filter(
          (g) =>
            g.title.toLowerCase().includes(q) ||
            (g.slug ?? '').includes(q) ||
            (g.description ?? '').toLowerCase().includes(q),
        );
      }
      if (query.sort === 'created') items.sort((a, b) => b.createdAt - a.createdAt);
      else if (query.sort === 'title') items.sort((a, b) => a.title.localeCompare(b.title));
      else if (query.sort === 'progress') items.sort((a, b) => b.progress - a.progress);
      return respond(c, { items: items.slice(0, query.limit ?? 200), nextCursor: null });
    },
  );

  api.route(
    {
      method: 'post',
      path: '/graphs',
      summary: 'Create a graph from a spec (?start=true to start it)',
      tag: 'graphs',
      role: 'agent',
      body: CreateGraphBody,
      query: z.object({ start: z.enum(['true', 'false']).optional() }),
    },
    (c, { body, query }) => {
      const spec = requireValid(parseSpec(body));
      const actor = resolveActor(app, c);
      const out = createGraph(app, spec, actor, { start: query.start === 'true' });
      return respond(
        c,
        { ...graphView(out.state), started: out.result.started, requestId: out.result.requestId },
        201,
      );
    },
  );

  api.route(
    {
      method: 'post',
      path: '/graphs/validate',
      summary: 'Validate a spec',
      tag: 'graphs',
      role: 'viewer',
      body: CreateGraphBody,
    },
    (c, { body }) => {
      const r = parseSpec(body);
      return respond(c, {
        ok: r.ok,
        normalized: r.normalized,
        errors: r.errors,
        warnings: r.warnings,
        stats: (r as { stats?: unknown }).stats,
      });
    },
  );

  api.route(
    { method: 'get', path: '/graphs/:graph', summary: 'GraphView', tag: 'graphs', role: 'viewer' },
    (c, { params }) => {
      const state = readGraph(app, params.graph as string);
      c.header('ETag', `"${state.graph.version}"`);
      return respond(c, graphView(state));
    },
  );

  api.route(
    {
      method: 'patch',
      path: '/graphs/:graph',
      summary: 'Update graph configuration',
      tag: 'graphs',
      role: 'agent',
      body: z.record(z.string(), z.unknown()),
    },
    (c, { body, params }) => {
      const actor = resolveActor(app, c);
      const ifMatch = c.req.header('if-match')?.replace(/"/g, '');
      const out = command(app, params.graph as string, actor, (s, tx) => {
        if (ifMatch && Number(ifMatch) !== s.graph.version) {
          throw new EngineError(
            'CONFLICT',
            `Version mismatch: current is ${s.graph.version}.`,
            'Refetch and retry.',
            409,
            { version: s.graph.version },
          );
        }
        requireCapability(c, s, actor, 'mutate');
        return engine.applyMutations(
          s,
          tx,
          { graph: body },
          { admin: c.get('auth').role === 'admin' },
        );
      });
      c.header('ETag', `"${out.state.graph.version}"`);
      return respond(c, { ...graphView(out.state), mutation: out.result });
    },
  );

  api.route(
    {
      method: 'delete',
      path: '/graphs/:graph',
      summary: 'Delete a draft graph',
      tag: 'graphs',
      role: 'admin',
    },
    (c, { params }) => {
      const state = readGraph(app, params.graph as string);
      if (state.graph.status !== 'draft') {
        throw new EngineError(
          'INVALID_TRANSITION',
          'Only drafts can be deleted; archive other graphs.',
          'POST /graphs/{graph}/archive',
          409,
        );
      }
      app.db.$client.transaction(() => {
        app.db.delete(events).where(eq(events.graphId, state.graph.id)).run();
        app.db.delete(graphs).where(eq(graphs.id, state.graph.id)).run();
      })();
      return respond(c, { deleted: state.graph.id });
    },
  );

  const lifecycle: Array<
    [
      string,
      string,
      (
        s: Parameters<typeof engine.pause>[0],
        t: Parameters<typeof engine.pause>[1],
        reason?: string,
      ) => unknown,
    ]
  > = [
    ['start', 'Start (or request plan approval)', (s, t) => engine.startGraph(s, t)],
    ['pause', 'Pause', (s, t, r) => engine.pause(s, t, r)],
    ['resume', 'Resume', (s, t) => engine.resume(s, t)],
    ['cancel', 'Cancel', (s, t, r) => engine.cancel(s, t, r)],
    ['reopen', 'Reopen a completed or failed graph', (s, t, r) => engine.reopenGraph(s, t, r)],
    ['archive', 'Archive', (s, t) => engine.archive(s, t, true)],
    ['unarchive', 'Unarchive', (s, t) => engine.archive(s, t, false)],
  ];
  for (const [action, summary, fn] of lifecycle) {
    api.route(
      {
        method: 'post',
        path: `/graphs/:graph/${action}`,
        summary,
        tag: 'graphs',
        role: action === 'start' ? 'agent' : 'admin',
        body: OptionalReasonBody,
      },
      (c, { body, params }) => {
        const actor = resolveActor(app, c);
        const out = command(app, params.graph as string, actor, (s, t) => fn(s, t, body.reason));
        return respond(c, { graph: graphSummary(out.state), result: out.result });
      },
    );
  }
  api.route(
    {
      method: 'post',
      path: '/graphs/:graph/fail',
      summary: 'Fail the graph',
      tag: 'graphs',
      role: 'admin',
      body: ReasonBody,
    },
    (c, { body, params }) => {
      const out = command(app, params.graph as string, resolveActor(app, c), (s, t) =>
        engine.fail(s, t, body.reason),
      );
      return respond(c, { graph: graphSummary(out.state) });
    },
  );

  api.route(
    {
      method: 'post',
      path: '/graphs/:graph/clone',
      summary: 'New draft from this graph’s spec',
      tag: 'graphs',
      role: 'agent',
      body: z.object({ title: z.string().optional(), slug: z.string().optional() }),
    },
    (c, { body, params }) => {
      const state = readGraph(app, params.graph as string);
      const spec = toSpecInput(engine.stateToSpec(state)) as Record<string, unknown>;
      spec.title = body.title ?? `${state.graph.title} (copy)`;
      if (body.slug) spec.slug = body.slug;
      else delete spec.slug;
      const out = createGraph(app, requireValid(validateSpec(spec)), resolveActor(app, c));
      return respond(c, graphView(out.state), 201);
    },
  );

  api.route(
    {
      method: 'get',
      path: '/graphs/:graph/spec',
      summary: 'Export the canonical spec',
      tag: 'graphs',
      role: 'viewer',
      query: z.object({ format: z.enum(['yaml', 'json']).optional() }),
    },
    (c, { params, query }) => {
      const spec = engine.stateToSpec(readGraph(app, params.graph as string));
      if (query.format === 'json') return c.json(toSpecInput(spec));
      return c.text(toSpecYaml(spec), 200, { 'Content-Type': 'application/yaml; charset=utf-8' });
    },
  );

  api.route(
    {
      method: 'post',
      path: '/graphs/:graph/mutations',
      summary: 'Batch structural changes',
      tag: 'graphs',
      role: 'agent',
      body: MutationBody,
    },
    (c, { body, params }) => {
      const actor = resolveActor(app, c);
      const out = command(app, params.graph as string, actor, (s, tx) => {
        requireCapability(c, s, actor, 'mutate');
        return engine.applyMutations(s, tx, body as engine.MutationBatch, {
          admin: c.get('auth').role === 'admin',
        });
      });
      return respond(c, { ...out.result, graph: graphView(out.state) });
    },
  );

  api.route(
    {
      method: 'get',
      path: '/graphs/:graph/sitrep',
      summary: 'Situation report for orchestrators',
      tag: 'graphs',
      role: 'viewer',
      query: z.object({
        budget: z.coerce.number().int().min(500).max(100_000).optional(),
        orchestrator: z.string().optional(),
        format: z.enum(['md', 'json']).optional(),
      }),
    },
    (c, { params, query }) => {
      const state = readGraph(app, params.graph as string);
      const recent = app.db
        .select()
        .from(events)
        .where(eq(events.graphId, state.graph.id))
        .orderBy(desc(events.seq))
        .limit(80)
        .all()
        .reverse();
      const orch = query.orchestrator
        ? [...state.orchestrators.values()].find((o) => o.key === query.orchestrator)
        : undefined;
      const orchNotes = orch
        ? app.db
            .select()
            .from(notes)
            .where(and(eq(notes.graphId, state.graph.id), eq(notes.orchestratorId, orch.id)))
            .orderBy(desc(notes.createdAt))
            .limit(20)
            .all()
            .map((r) => rowToNote(r as Record<string, unknown>))
        : [];
      const sitrep = renderSitrep({
        state,
        now: app.now(),
        ...(query.orchestrator ? { orchestratorKey: query.orchestrator } : {}),
        recentEvents: recent.map((e) => ({
          ...e,
          graphId: e.graphId ?? '',
          actor: e.actor as never,
          payload: e.payload as Record<string, unknown>,
        })),
        notes: orchNotes,
        ...(query.budget ? { budget: query.budget } : {}),
      });
      if (query.format === 'json')
        return respond(c, {
          tokens: sitrep.tokens,
          budget: sitrep.budget,
          sections: sitrep.sections,
          suggestions: sitrep.suggestions,
        });
      return c.text(sitrep.markdown, 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
    },
  );

  api.route(
    {
      method: 'post',
      path: '/graphs/:graph/next',
      summary: 'Pick (and optionally claim) the best item for the caller',
      tag: 'work',
      role: 'agent',
      body: NextBody,
    },
    (c, { body, params }) => {
      const state = readGraph(app, params.graph as string);
      if (body.role === 'reviewer') {
        const actor = resolveActor(app, c, body);
        const next = engine.pickNext(state, { role: 'reviewer', actor });
        if (next.kind !== 'evaluation')
          return respond(c, { attempt: null, reason: next.kind === 'none' ? next.reason : '' });
        return respond(c, {
          attempt: next.attempt,
          node: { key: next.node.key, title: next.node.title },
          aims: next.aims,
        });
      }
      const pick = engine.pickNext(state, { skills: body.skills ?? [] });
      if (pick.kind !== 'node') {
        const running = [...state.attempts.values()]
          .filter((a) => a.status === 'running')
          .map((a) => ({
            key: state.nodes.get(a.nodeId)?.key,
            holder: [a.executor.model, a.executor.mechanism].filter(Boolean).join(' · '),
            progress: a.progress ?? 0,
          }));
        const nodes = [...state.nodes.values()];
        return respond(c, {
          node: null,
          reason: pick.kind === 'none' ? pick.reason : '',
          running,
          needsInput: nodes.filter((n) => n.status === 'needs_input').map((n) => n.key),
          blocked: nodes.filter((n) => n.status === 'blocked').map((n) => n.key),
          suggestion: running.length
            ? 'Wait for running nodes or resolve inbox items; poll again in ~5 minutes.'
            : 'Resolve inbox items, or check the graph status.',
        });
      }
      const node = {
        key: pick.node.key,
        title: pick.node.title,
        priority: pick.node.priority,
        reason: 'highest priority ready node on the critical path',
      };
      if (!body.claim) return respond(c, { node });
      const claimed = claimFor(app, c, params.graph as string, pick.node.key, body);
      return respond(c, { node, ...claimed });
    },
  );

  api.route(
    {
      method: 'get',
      path: '/graphs/:graph/stats',
      summary: 'Counts, cost by model, attempts, loops',
      tag: 'graphs',
      role: 'viewer',
    },
    (c, { params }) => {
      const state = readGraph(app, params.graph as string);
      const byModel: Record<string, { attempts: number; costUsd: number; tokens: number }> = {};
      for (const a of state.attempts.values()) {
        const key = a.executor.model ?? 'unknown';
        byModel[key] ??= { attempts: 0, costUsd: 0, tokens: 0 };
        const m = byModel[key] as { attempts: number; costUsd: number; tokens: number };
        m.attempts++;
        m.costUsd += a.usage?.costUsd ?? 0;
        m.tokens += (a.usage?.inputTokens ?? 0) + (a.usage?.outputTokens ?? 0);
      }
      const nodes = [...state.nodes.values()];
      return respond(c, {
        counts: graphSummary(state).counts,
        costUsd: engine.derivedMetric(state, 'cost_usd'),
        tokens: engine.derivedMetric(state, 'tokens_total'),
        elapsedHours: engine.derivedMetric(state, 'elapsed_hours'),
        failedAttempts: engine.derivedMetric(state, 'failed_attempts'),
        byModel,
        attemptsPerNode: Object.fromEntries(nodes.map((n) => [n.key, n.attemptsTotal])),
        loops: state.loops.map((l) => ({ key: l.key, iteration: l.iteration, status: l.status })),
        throughput: { done: nodes.filter((n) => n.status === 'done').length },
      });
    },
  );

  api.route(
    {
      method: 'get',
      path: '/graphs/:graph/metrics',
      summary: 'Metric series',
      tag: 'graphs',
      role: 'viewer',
      query: z.object({ name: z.string().optional(), node: z.string().optional() }),
    },
    (c, { params, query }) => {
      const state = readGraph(app, params.graph as string);
      const nodeId = query.node ? engine.nodeByKey(state, query.node).id : undefined;
      return respond(c, {
        items: state.metrics.filter(
          (m) => (!query.name || m.name === query.name) && (!nodeId || m.nodeId === nodeId),
        ),
      });
    },
  );

  api.route(
    {
      method: 'post',
      path: '/graphs/:graph/metrics',
      summary: 'Graph-level metric reports',
      tag: 'graphs',
      role: 'agent',
      body: z.object({
        metrics: z.union([
          z.record(z.string(), z.number()),
          z.array(z.object({ name: z.string(), value: z.number(), unit: z.string().optional() })),
        ]),
      }),
    },
    (c, { params, body }) => {
      const out = command(app, params.graph as string, resolveActor(app, c), (s, t) =>
        engine.reportMetrics(s, t, { metrics: metricList(body.metrics) }),
      );
      return respond(c, { graph: graphSummary(out.state) });
    },
  );

  api.route(
    {
      method: 'get',
      path: '/graphs/:graph/events',
      summary: 'Event history',
      tag: 'audit',
      role: 'viewer',
      query: z.object({
        after: z.coerce.number().int().optional(),
        types: z.string().optional(),
        entity: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(1000).optional(),
      }),
    },
    (c, { params, query }) => {
      const graphId = resolveGraphId(app, params.graph as string);
      let items = graphEvents(app.db, graphId, query.after ?? 0, query.limit ?? 200);
      if (query.types) {
        const types = new Set(query.types.split(','));
        items = items.filter((e) => types.has(e.type) || types.has(`${e.type.split('.')[0]}.*`));
      }
      if (query.entity) items = items.filter((e) => e.entityId === query.entity);
      return respond(c, { items, nextCursor: items.at(-1)?.seq ?? null });
    },
  );

  api.route(
    {
      method: 'get',
      path: '/graphs/:graph/audit/verify',
      summary: 'Recompute the hash chain',
      tag: 'audit',
      role: 'viewer',
    },
    (c, { params }) => {
      const graphId = resolveGraphId(app, params.graph as string);
      const rows = app.db
        .select()
        .from(events)
        .where(eq(events.graphId, graphId))
        .orderBy(asc(events.seq))
        .all();
      const mismatch = verifyChain(graphId, rows);
      return respond(c, {
        ok: mismatch < 0,
        events: rows.length,
        ...(mismatch >= 0 ? { firstMismatch: rows[mismatch]?.seq } : {}),
      });
    },
  );

  api.route(
    {
      method: 'get',
      path: '/graphs/:graph/audit/export',
      summary: 'Full audit bundle (JSONL)',
      tag: 'audit',
      role: 'viewer',
      produces: 'application/x-ndjson',
    },
    (c, { params }) => {
      const state = readGraph(app, params.graph as string);
      const lines: unknown[] = [{ kind: 'spec', spec: toSpecInput(engine.stateToSpec(state)) }];
      lines.push({ kind: 'graph', entity: state.graph });
      for (const n of state.nodes.values()) lines.push({ kind: 'node', entity: n });
      for (const a of state.attempts.values()) lines.push({ kind: 'attempt', entity: a });
      for (const e of state.evaluations) lines.push({ kind: 'evaluation', entity: e });
      for (const n of app.db.select().from(notes).where(eq(notes.graphId, state.graph.id)).all())
        lines.push({ kind: 'note', entity: n });
      for (const e of app.db
        .select()
        .from(events)
        .where(eq(events.graphId, state.graph.id))
        .orderBy(asc(events.seq))
        .all())
        lines.push({ kind: 'event', entity: e });
      return c.body(`${lines.map((l) => JSON.stringify(toApi(l))).join('\n')}\n`, 200, {
        'Content-Type': 'application/x-ndjson',
      });
    },
  );

  api.route(
    {
      method: 'get',
      path: '/graphs/:graph/audit/gaps',
      summary: 'Audit gaps',
      tag: 'audit',
      role: 'viewer',
    },
    (c, { params }) => {
      const state = readGraph(app, params.graph as string);
      const proofNodes = new Set(
        app.db
          .select({ nodeId: notes.nodeId })
          .from(notes)
          .where(
            and(
              eq(notes.graphId, state.graph.id),
              eq(notes.type, 'proof'),
              sql`${notes.retractedAt} IS NULL`,
            ),
          )
          .all()
          .map((r) => r.nodeId),
      );
      const nodes = [...state.nodes.values()];
      const waived = app.db
        .select()
        .from(evaluations)
        .where(and(eq(evaluations.graphId, state.graph.id), eq(evaluations.verdict, 'waived')))
        .all();
      const findings = app.db
        .select()
        .from(notes)
        .where(
          and(
            eq(notes.graphId, state.graph.id),
            eq(notes.type, 'finding'),
            inArray(notes.severity, ['high', 'critical']),
            sql`${notes.retractedAt} IS NULL`,
            sql`${notes.resolvedAt} IS NULL`,
          ),
        )
        .all();
      return respond(c, {
        doneWithoutProof: nodes
          .filter((n) => n.status === 'done' && n.kind === 'task' && !proofNodes.has(n.id))
          .map((n) => n.key),
        acceptedWithDeviation: nodes.filter((n) => n.acceptedWithDeviation).map((n) => n.key),
        graphAcceptedWithDeviation: state.graph.acceptedWithDeviation,
        waivedAims: waived.map((e) => ({
          aimId: e.aimId,
          key: state.aims.get(e.aimId)?.key,
          rationale: e.rationale,
          actor: e.actor,
          createdAt: e.createdAt,
        })),
        manualCompletions: nodes.filter((n) => n.manual).map((n) => n.key),
        openHighFindings: findings.map((f) => rowToNote(f as Record<string, unknown>)),
      });
    },
  );

  api.route(
    {
      method: 'get',
      path: '/graphs/:graph/notes',
      summary: 'Graph-level notes',
      tag: 'notes',
      role: 'viewer',
      query: z.object({ type: z.string().optional() }),
    },
    (c, { params, query }) => {
      const graphId = resolveGraphId(app, params.graph as string);
      return respond(c, { items: graphNotes(app, graphId, query.type) });
    },
  );

  api.route(
    {
      method: 'post',
      path: '/graphs/:graph/notes',
      summary: 'Add a graph-level note',
      tag: 'notes',
      role: 'agent',
      body: NoteBody,
    },
    (c, { params, body }) => {
      const out = command(app, params.graph as string, resolveActor(app, c), (s, t) =>
        engine.addNote(s, t, body),
      );
      return respond(c, out.result, 201);
    },
  );
}
