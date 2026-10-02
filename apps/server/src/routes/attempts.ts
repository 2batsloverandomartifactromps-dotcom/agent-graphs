/** Attempt routes (docs/api.md § Attempts): the attempt id is the capability. */
import {
  BlockBody,
  ChecklistBody,
  EngineError,
  EvaluateBody,
  type ExecutionAnnotation,
  engine,
  FailBody,
  HeartbeatBody,
  MetricsBody,
  metricList,
  NoteBody,
  ReleaseBody,
  SubmitBody,
} from '@agent-graphs/core';
import { and, eq, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { z } from 'zod';
import { type Env, requireCapability, resolveActor } from '../auth';
import { type AppContext, command, readGraph } from '../context';
import { notes } from '../db/schema';
import { attemptSummary, nodeSummary } from '../read/views';
import { annotationOf, getSession } from '../sessions';
import type { Api } from './define';
import { recordLessonApplications, settleLessonApplications } from './lessons';
import { briefingFor, briefingOut, graphOfAttempt, respond } from './util';

/** Attempt-scoped calls act as the attempt's executor unless a session header says otherwise. */
function attemptActor(
  app: AppContext,
  c: Context<Env>,
  executor: ExecutionAnnotation,
): ExecutionAnnotation {
  const sessionId = c.req.header('x-agent-session');
  return sessionId ? annotationOf(getSession(app, sessionId)) : executor;
}

function load(app: AppContext, attemptId: string) {
  const graphId = graphOfAttempt(app, attemptId);
  const state = readGraph(app, graphId);
  const attempt = state.attempts.get(attemptId);
  if (!attempt)
    throw new EngineError('NOT_FOUND', `Attempt ${attemptId} not found.`, undefined, 404);
  return { graphId, state, attempt };
}

export function attemptRoutes(api: Api, app: AppContext): void {
  api.route(
    {
      method: 'get',
      path: '/attempts/:attempt',
      summary: 'Attempt, node summary, and lease state',
      tag: 'attempts',
      role: 'viewer',
    },
    (c, { params }) => {
      const { state, attempt } = load(app, params.attempt as string);
      const node = state.nodes.get(attempt.nodeId);
      return respond(c, {
        attempt,
        node: node ? nodeSummary(state, node) : undefined,
        graph: {
          id: state.graph.id,
          slug: state.graph.slug,
          title: state.graph.title,
          status: state.graph.status,
        },
        lease: {
          expiresAt: attempt.leaseExpiresAt,
          active: attempt.status === 'running' && (attempt.leaseExpiresAt ?? 0) > app.now(),
        },
      });
    },
  );

  api.route(
    {
      method: 'get',
      path: '/attempts/:attempt/briefing',
      summary: 'The briefing for this attempt (marks directives delivered)',
      tag: 'attempts',
      role: 'agent',
      query: z.object({
        budget: z.coerce.number().int().min(500).max(200_000).optional(),
        format: z.enum(['md', 'json']).optional(),
      }),
    },
    (c, { params, query }) => {
      const { graphId, attempt } = load(app, params.attempt as string);
      const out = command(app, graphId, attemptActor(app, c, attempt.executor), (s, t) => {
        const a = s.attempts.get(attempt.id);
        if (a && (a.status === 'running' || a.status === 'submitted'))
          engine.deliverDirectives(s, t, a, 'briefing');
      });
      const fresh = out.state.attempts.get(attempt.id) ?? attempt;
      const b = briefingFor(
        app,
        out.state,
        out.state.nodes.get(fresh.nodeId) as never,
        fresh,
        query.budget ? { budget: query.budget } : {},
      );
      if (fresh.status === 'running') recordLessonApplications(app, fresh.id, b.lessonIds);
      if (query.format === 'json') return respond(c, briefingOut(b, 'json'));
      return c.text(b.markdown, 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
    },
  );

  api.route(
    {
      method: 'post',
      path: '/attempts/:attempt/heartbeat',
      summary: 'Renew the lease and report progress',
      tag: 'attempts',
      role: 'agent',
      body: HeartbeatBody,
    },
    (c, { params, body }) => {
      const { graphId, attempt } = load(app, params.attempt as string);
      const out = command(app, graphId, attemptActor(app, c, attempt.executor), (s, t) =>
        engine.heartbeat(s, t, { attemptId: attempt.id, ...body }),
      );
      return respond(c, out.result);
    },
  );

  api.route(
    {
      method: 'get',
      path: '/attempts/:attempt/directives',
      summary: 'Active directives for this attempt',
      tag: 'attempts',
      role: 'agent',
      query: z.object({ status: z.string().optional() }),
    },
    (c, { params, query }) => {
      const { state, attempt } = load(app, params.attempt as string);
      const items = engine
        .activeDirectives(state, attempt)
        .filter((d) => !query.status || d.status === query.status)
        .map((d) => ({
          ...d,
          delivery: state.deliveries.find(
            (x) => x.directiveId === d.id && x.recipient === attempt.id,
          ),
        }));
      return respond(c, { items });
    },
  );

  api.route(
    {
      method: 'post',
      path: '/attempts/:attempt/notes',
      summary: 'Add a note on this attempt',
      tag: 'attempts',
      role: 'agent',
      body: NoteBody,
    },
    (c, { params, body }) => {
      const { graphId, attempt } = load(app, params.attempt as string);
      const out = command(app, graphId, attemptActor(app, c, attempt.executor), (s, t) =>
        engine.addNote(s, t, { ...body, attemptId: attempt.id }),
      );
      return respond(c, out.result, 201);
    },
  );

  api.route(
    {
      method: 'post',
      path: '/attempts/:attempt/metrics',
      summary: 'Report metrics',
      tag: 'attempts',
      role: 'agent',
      body: MetricsBody,
    },
    (c, { params, body }) => {
      const { graphId, attempt } = load(app, params.attempt as string);
      const list = Array.isArray(body) ? body : metricList(body.metrics);
      const out = command(app, graphId, attemptActor(app, c, attempt.executor), (s, t) =>
        engine.reportMetrics(s, t, { attemptId: attempt.id, metrics: list }),
      );
      return respond(c, { attempt: attemptSummary(out.state, attempt.id), recorded: list.length });
    },
  );

  api.route(
    {
      method: 'post',
      path: '/attempts/:attempt/checklist',
      summary: 'Tick checklist items',
      tag: 'attempts',
      role: 'agent',
      body: ChecklistBody,
    },
    (c, { params, body }) => {
      const { graphId, attempt } = load(app, params.attempt as string);
      const out = command(app, graphId, attemptActor(app, c, attempt.executor), (s, t) =>
        engine.updateChecklist(s, t, attempt.id, body.items),
      );
      return respond(c, { checklistState: out.result.checklistState });
    },
  );

  api.route(
    {
      method: 'post',
      path: '/attempts/:attempt/submit',
      summary: 'Submit work for evaluation',
      tag: 'attempts',
      role: 'agent',
      body: SubmitBody,
    },
    (c, { params, body }) => {
      const { graphId, attempt } = load(app, params.attempt as string);
      const existingProof =
        app.db
          .select({ n: sql<number>`count(*)` })
          .from(notes)
          .where(
            and(
              eq(notes.attemptId, attempt.id),
              eq(notes.type, 'proof'),
              sql`${notes.retractedAt} IS NULL`,
            ),
          )
          .get()?.n ?? 0;
      const out = command(app, graphId, attemptActor(app, c, attempt.executor), (s, t) => {
        for (const n of body.notes ?? []) engine.addNote(s, t, { ...n, attemptId: attempt.id });
        return engine.submit(s, t, {
          attemptId: attempt.id,
          summary: body.summary,
          ...(body.evaluations ? { evaluations: body.evaluations } : {}),
          metrics: metricList(body.metrics),
          ...(body.usage ? { usage: body.usage } : {}),
          proofNotes: existingProof + (body.notes ?? []).filter((n) => n.type === 'proof').length,
        });
      });
      if (out.result.outcome !== 'evaluating') {
        settleLessonApplications(app, attempt.id, out.result.outcome);
      }
      const duty = [...out.state.lessonDuties.values()].find(
        (d) => d.passedAttemptId === attempt.id && d.status === 'open',
      );
      return respond(c, {
        outcome: out.result.outcome,
        attempt: attemptSummary(out.state, attempt.id),
        node: nodeSummary(out.state, out.result.node),
        next: out.result.next,
        ...(duty
          ? {
              lessonDuty: {
                id: duty.id,
                ask: 'You passed after earlier failures. Record what made the difference with lesson_add (POST /lessons with dutyId): one or two imperative sentences and the condition under which they apply.',
              },
            }
          : {}),
      });
    },
  );

  api.route(
    {
      method: 'post',
      path: '/attempts/:attempt/evaluations',
      summary: 'Judge a submitted attempt',
      tag: 'attempts',
      role: 'agent',
      body: EvaluateBody,
    },
    (c, { params, body }) => {
      const { graphId, state, attempt } = load(app, params.attempt as string);
      const judge = resolveActor(app, c);
      const node = state.nodes.get(attempt.nodeId);
      const aim = node
        ? engine.aimsOf(state, 'node', node.id).find((a) => a.key === body.aim)
        : undefined;
      if (aim?.evaluator === 'orchestrator') requireCapability(c, state, judge, 'evaluate', node);
      const out = command(app, graphId, judge, (s, t) =>
        engine.evaluate(s, t, { attemptId: attempt.id, ...body }),
      );
      return respond(
        c,
        {
          attempt: attemptSummary(out.state, attempt.id),
          node: nodeSummary(out.state, out.result.node),
        },
        201,
      );
    },
  );

  api.route(
    {
      method: 'post',
      path: '/attempts/:attempt/fail',
      summary: 'Report that the work cannot be completed (counted)',
      tag: 'attempts',
      role: 'agent',
      body: FailBody,
    },
    (c, { params, body }) => {
      const { graphId, attempt } = load(app, params.attempt as string);
      const out = command(app, graphId, attemptActor(app, c, attempt.executor), (s, t) =>
        engine.failAttempt(s, t, { attemptId: attempt.id, ...body }),
      );
      return respond(c, {
        attempt: attemptSummary(out.state, attempt.id),
        node: nodeSummary(out.state, out.result.node),
      });
    },
  );

  api.route(
    {
      method: 'post',
      path: '/attempts/:attempt/block',
      summary: 'Stop on an external blocker (not counted)',
      tag: 'attempts',
      role: 'agent',
      body: BlockBody,
    },
    (c, { params, body }) => {
      const { graphId, attempt } = load(app, params.attempt as string);
      const out = command(app, graphId, attemptActor(app, c, attempt.executor), (s, t) =>
        engine.blockAttempt(s, t, { attemptId: attempt.id, ...body }),
      );
      return respond(c, {
        attempt: attemptSummary(out.state, attempt.id),
        node: nodeSummary(out.state, out.result.node),
        request: out.result.request,
      });
    },
  );

  api.route(
    {
      method: 'post',
      path: '/attempts/:attempt/release',
      summary: 'Release voluntarily (not counted)',
      tag: 'attempts',
      role: 'agent',
      body: ReleaseBody,
    },
    (c, { params, body }) => {
      const { graphId, attempt } = load(app, params.attempt as string);
      const out = command(app, graphId, attemptActor(app, c, attempt.executor), (s, t) =>
        engine.releaseAttempt(s, t, { attemptId: attempt.id, ...body }),
      );
      return respond(c, {
        attempt: attemptSummary(out.state, attempt.id),
        node: nodeSummary(out.state, out.result.node),
      });
    },
  );
}
