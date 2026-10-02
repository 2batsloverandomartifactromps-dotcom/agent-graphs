/**
 * Learn mode (E1; docs/self-evolution.md §6–§7, api.md § Procedural knowledge): lessons with
 * duties, incremental curation, application counters, and edge-attribute appends.
 */
import {
  EngineError,
  type ExecutionAnnotation,
  engine,
  type GraphState,
  LESSON_KINDS,
  type Lesson,
  rankLessons,
  runMetrics,
  shouldRetire,
} from '@agent-graphs/core';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { z } from 'zod';
import { type Env, requireCapability, resolveActor } from '../auth';
import { type AppContext, command, messagesFor, readGraph } from '../context';
import { appendEvents, stripNulls } from '../db/repo';
import { lessonApplications, lessons } from '../db/schema';
import { newId } from '../ids';
import type { Api } from './define';
import { respond } from './util';

const Scope = z.union([
  z.literal('global'),
  z.strictObject({
    graph: z.string().optional(),
    template: z.string().optional(),
    nodeKey: z.string().optional(),
    edge: z.tuple([z.string(), z.string()]).optional(),
    tags: z.array(z.string()).optional(),
    kind: z.enum(['task', 'gate', 'milestone', 'group']).optional(),
  }),
]);
const Evidence = z.strictObject({
  failedAttempts: z.array(z.string()).default([]),
  passedAttempts: z.array(z.string()).default([]),
  notes: z.array(z.string()).optional(),
});
const LessonBody = z.strictObject({
  scope: Scope,
  kind: z.enum(LESSON_KINDS),
  condition: z.string().max(1000).optional(),
  content: z.string().min(1).max(1000),
  evidence: Evidence.optional(),
  dutyId: z.string().optional(),
  source: z.enum(['worker', 'evolver', 'human', 'import']).optional(),
});
const AttributesBody = z.strictObject({
  guidance: z.string().min(1).max(2000).optional(),
  pitfalls: z.string().min(1).max(2000).optional(),
  dutyId: z.string().optional(),
});

function getLesson(app: AppContext, id: string): Lesson {
  const row = app.db.select().from(lessons).where(eq(lessons.id, id)).get();
  if (!row) throw new EngineError('NOT_FOUND', `Lesson ${id} not found.`, undefined, 404);
  return stripNulls<Lesson>(row as Record<string, unknown>);
}

function lessonEvent(
  app: AppContext,
  graphId: string | null,
  type: string,
  lesson: Lesson,
  actor: ExecutionAnnotation,
  payload: Record<string, unknown> = {},
) {
  const stored = appendEvents(app.db, graphId, [
    {
      type,
      graphId: graphId ?? '',
      entityType: 'lesson',
      entityId: lesson.id,
      actor,
      payload: { kind: lesson.kind, content: lesson.content, ...payload },
      createdAt: app.now(),
    },
  ]);
  return stored;
}

/** Allowed when learn mode (or higher) is on and the caller holds a duty or `evolve`, or is admin. */
function requireLearnAccess(
  c: Context<Env>,
  state: GraphState,
  actor: ExecutionAnnotation,
  dutyId?: string,
) {
  if (state.graph.evolution.mode === 'off') {
    throw new EngineError(
      'POLICY_DENIED',
      'Learn mode is off for this graph (evolution.mode: off).',
      'An admin can enable it with PATCH /graphs/{graph} { evolution: { mode: learn } }.',
      403,
    );
  }
  if (c.get('auth').role === 'admin') return;
  if (dutyId) {
    const duty = state.lessonDuties.get(dutyId);
    if (duty?.status === 'open') {
      const passed = state.attempts.get(duty.passedAttemptId);
      if (passed?.sessionId && passed.sessionId === actor.sessionId) return;
    }
  }
  requireCapability(c, state, actor, 'evolve');
}

/** Record that lessons were included in a claimed attempt's briefing (once per pair). */
export function recordLessonApplications(
  app: AppContext,
  attemptId: string,
  lessonIds: string[],
): void {
  if (lessonIds.length === 0) return;
  app.db.$client
    .transaction(() => {
      for (const lessonId of lessonIds) {
        const inserted = app.db
          .insert(lessonApplications)
          .values({ lessonId, attemptId, outcome: 'pending', createdAt: app.now() })
          .onConflictDoNothing()
          .run();
        if (inserted.changes > 0) {
          app.db
            .update(lessons)
            .set({
              counters: sql`json_set(${lessons.counters}, '$.applied', json_extract(${lessons.counters}, '$.applied') + 1)`,
            })
            .where(eq(lessons.id, lessonId))
            .run();
        }
      }
    })
    .immediate();
}

/** When an attempt ends, stamp the outcome on its lesson applications. */
export function settleLessonApplications(
  app: AppContext,
  attemptId: string,
  outcome: 'passed' | 'failed',
): void {
  app.db
    .update(lessonApplications)
    .set({ outcome })
    .where(
      and(eq(lessonApplications.attemptId, attemptId), eq(lessonApplications.outcome, 'pending')),
    )
    .run();
}

export function lessonRoutes(api: Api, app: AppContext): void {
  api.route(
    {
      method: 'get',
      path: '/lessons',
      summary: 'Search lessons (ranked like briefings when node is given)',
      tag: 'evolution',
      role: 'viewer',
      query: z.object({
        graph: z.string().optional(),
        template: z.string().optional(),
        node: z.string().optional(),
        status: z.string().optional(),
        q: z.string().optional(),
      }),
    },
    (c, { query }) => {
      let rows = app.db
        .select()
        .from(lessons)
        .where(inArray(lessons.status, (query.status ?? 'active').split(',')))
        .orderBy(desc(lessons.updatedAt))
        .all()
        .map((r) => stripNulls<Lesson>(r as Record<string, unknown>));
      if (query.q) {
        const q = query.q.toLowerCase();
        rows = rows.filter(
          (l) =>
            l.content.toLowerCase().includes(q) || (l.condition ?? '').toLowerCase().includes(q),
        );
      }
      if (query.graph && query.node) {
        const state = readGraph(app, query.graph);
        rows = rankFor(rows, state, engine.nodeByKey(state, query.node));
      }
      return respond(c, {
        items: rows.map((l) => ({ ...l, flaggedForRetirement: shouldRetire(l) })),
      });
    },
  );

  api.route(
    {
      method: 'post',
      path: '/lessons',
      summary: 'Record a lesson (fulfils a duty with dutyId)',
      tag: 'evolution',
      role: 'agent',
      body: LessonBody,
    },
    (c, { body }) => {
      const actor = resolveActor(app, c);
      const now = app.now();
      const lesson: Lesson = {
        id: newId('ls', now),
        scope: body.scope as Lesson['scope'],
        kind: body.kind,
        ...(body.condition ? { condition: body.condition } : {}),
        content: body.content,
        evidence: body.evidence ?? { failedAttempts: [], passedAttempts: [] },
        source:
          body.source ?? (actor.kind === 'human' ? 'human' : body.dutyId ? 'worker' : 'evolver'),
        counters: { applied: 0, helpful: 0, harmful: 0 },
        status: 'active',
        version: 1,
        author: actor,
        createdAt: now,
        updatedAt: now,
      };
      const graphRef = typeof body.scope === 'object' ? body.scope.graph : undefined;
      const dutyGraph = body.dutyId
        ? (
            app.db.$client
              .prepare('SELECT graph_id FROM lesson_duties WHERE id = ?')
              .get(body.dutyId) as { graph_id: string } | undefined
          )?.graph_id
        : undefined;
      const graph = dutyGraph ?? graphRef;
      if (!graph) {
        if (c.get('auth').role !== 'admin')
          throw new EngineError(
            'BAD_REQUEST',
            'Global lessons need an admin; scope the lesson to a graph or pass dutyId.',
            undefined,
            400,
          );
        app.db.insert(lessons).values(lesson).run();
        app.hub.publish(messagesFor(lessonEvent(app, null, 'lesson.created', lesson, actor)));
        return respond(c, lesson, 201);
      }
      command(
        app,
        graph,
        actor,
        (s, t) => {
          requireLearnAccess(c, s, actor, body.dutyId);
          if (typeof lesson.scope === 'object' && !lesson.scope.graph && !lesson.scope.template)
            lesson.scope = { ...lesson.scope, graph: s.graph.id };
          if (body.dutyId) {
            const duty = s.lessonDuties.get(body.dutyId);
            if (!duty || duty.status !== 'open')
              throw new EngineError(
                'INVALID_TRANSITION',
                `Lesson duty ${body.dutyId} is not open.`,
              );
            duty.status = 'fulfilled';
            duty.lessonId = lesson.id;
            duty.closedAt = t.ctx.now;
            t.touch('lessonDuty', duty);
            t.emit('lesson.duty_fulfilled', s.graph.id, 'lessonDuty', duty.id, {
              lessonId: lesson.id,
            });
            if (lesson.evidence.failedAttempts.length === 0)
              lesson.evidence = {
                failedAttempts: duty.failedAttemptIds,
                passedAttempts: [duty.passedAttemptId],
              };
          }
          t.emit('lesson.created', s.graph.id, 'lesson', lesson.id, {
            kind: lesson.kind,
            content: lesson.content,
            dutyId: body.dutyId,
          });
        },
        () => {
          app.db.insert(lessons).values(lesson).run();
        },
      );
      return respond(c, lesson, 201);
    },
  );

  api.route(
    {
      method: 'post',
      path: '/lessons/duties/:id/dismiss',
      summary: 'Dismiss a lesson duty',
      tag: 'evolution',
      role: 'agent',
      body: z.strictObject({ reason: z.string().min(1) }),
    },
    (c, { params, body }) => {
      const row = app.db.$client
        .prepare('SELECT graph_id FROM lesson_duties WHERE id = ?')
        .get(params.id) as { graph_id: string } | undefined;
      if (!row)
        throw new EngineError('NOT_FOUND', `Lesson duty ${params.id} not found.`, undefined, 404);
      const actor = resolveActor(app, c);
      const out = command(app, row.graph_id, actor, (s, t) => {
        requireCapability(c, s, actor, 'evolve');
        const duty = s.lessonDuties.get(params.id as string);
        if (!duty || duty.status !== 'open')
          throw new EngineError('INVALID_TRANSITION', 'The duty is not open.');
        duty.status = 'dismissed';
        duty.closedAt = t.ctx.now;
        t.touch('lessonDuty', duty);
        t.emit('lesson.duty_dismissed', s.graph.id, 'lessonDuty', duty.id, { reason: body.reason });
        return duty;
      });
      return respond(c, out.result);
    },
  );

  const curate = (
    action: string,
    body: z.ZodType,
    apply: (
      lesson: Lesson,
      body: Record<string, unknown>,
      actor: ExecutionAnnotation,
    ) => { lesson: Lesson; event: string; payload?: Record<string, unknown>; extra?: Lesson },
  ) => {
    api.route(
      {
        method: 'post',
        path: `/lessons/:id/${action}`,
        summary: `${action} a lesson`,
        tag: 'evolution',
        role: 'agent',
        body,
      },
      (c, { params, body: input }) => {
        const actor = resolveActor(app, c);
        if (c.get('auth').role !== 'admin') {
          const lesson = getLesson(app, params.id as string);
          const graph = typeof lesson.scope === 'object' ? lesson.scope.graph : undefined;
          if (!graph)
            throw new EngineError(
              'FORBIDDEN',
              'Curating global lessons needs an admin.',
              undefined,
              403,
            );
          requireCapability(c, readGraph(app, graph), actor, 'evolve');
        }
        const current = getLesson(app, params.id as string);
        const result = apply(current, input as Record<string, unknown>, actor);
        const graphId = typeof current.scope === 'object' ? (current.scope.graph ?? null) : null;
        const stored = app.db.$client
          .transaction(() => {
            const { id, ...rest } = result.lesson;
            app.db
              .update(lessons)
              .set({ ...rest, updatedAt: app.now() })
              .where(eq(lessons.id, id))
              .run();
            if (result.extra) app.db.insert(lessons).values(result.extra).run();
            return lessonEvent(
              app,
              graphId,
              result.event,
              result.extra ?? result.lesson,
              actor,
              result.payload,
            );
          })
          .immediate();
        app.hub.publish(messagesFor(stored));
        return respond(c, { lesson: result.extra ?? getLesson(app, current.id) });
      },
    );
  };

  curate('retire', z.strictObject({ reason: z.string().optional() }), (lesson, b) => ({
    lesson: { ...lesson, status: 'retired' },
    event: 'lesson.retired',
    payload: { reason: b.reason },
  }));
  curate(
    'tag',
    z.strictObject({ tag: z.enum(['helpful', 'harmful']), attemptId: z.string().optional() }),
    (lesson, b) => {
      const counters = {
        ...lesson.counters,
        [b.tag as 'helpful' | 'harmful']: lesson.counters[b.tag as 'helpful' | 'harmful'] + 1,
      };
      if (b.attemptId)
        app.db
          .update(lessonApplications)
          .set({ tag: b.tag as string })
          .where(
            and(
              eq(lessonApplications.lessonId, lesson.id),
              eq(lessonApplications.attemptId, b.attemptId as string),
            ),
          )
          .run();
      return {
        lesson: { ...lesson, counters },
        event: 'lesson.tagged',
        payload: { tag: b.tag, attemptId: b.attemptId },
      };
    },
  );
  curate(
    'revise',
    z.strictObject({
      content: z.string().min(1).max(1000),
      condition: z.string().max(1000).optional(),
    }),
    (lesson, b, actor) => {
      const now = app.now();
      const next: Lesson = {
        ...lesson,
        id: newId('ls', now),
        content: b.content as string,
        ...(b.condition ? { condition: b.condition as string } : {}),
        version: lesson.version + 1,
        supersedes: lesson.id,
        author: actor,
        counters: { applied: 0, helpful: 0, harmful: 0 },
        createdAt: now,
        updatedAt: now,
      };
      return {
        lesson: { ...lesson, status: 'retired' },
        event: 'lesson.revised',
        payload: { supersedes: lesson.id },
        extra: next,
      };
    },
  );
  curate(
    'merge',
    z.strictObject({
      ids: z.array(z.string()).min(1),
      content: z.string().min(1).max(1000).optional(),
    }),
    (lesson, b) => {
      const others = (b.ids as string[]).map((id) => getLesson(app, id));
      for (const o of others)
        app.db
          .update(lessons)
          .set({ status: 'retired', updatedAt: app.now() })
          .where(eq(lessons.id, o.id))
          .run();
      const counters = others.reduce(
        (acc, o) => ({
          applied: acc.applied + o.counters.applied,
          helpful: acc.helpful + o.counters.helpful,
          harmful: acc.harmful + o.counters.harmful,
        }),
        lesson.counters,
      );
      const evidence = {
        failedAttempts: [
          ...new Set([
            ...lesson.evidence.failedAttempts,
            ...others.flatMap((o) => o.evidence.failedAttempts),
          ]),
        ],
        passedAttempts: [
          ...new Set([
            ...lesson.evidence.passedAttempts,
            ...others.flatMap((o) => o.evidence.passedAttempts),
          ]),
        ],
      };
      return {
        lesson: {
          ...lesson,
          counters,
          evidence,
          ...(b.content ? { content: b.content as string } : {}),
        },
        event: 'lesson.merged',
        payload: { merged: b.ids },
      };
    },
  );

  api.route(
    {
      method: 'post',
      path: '/graphs/:graph/edges/:id/attributes',
      summary: 'Append edge guidance or pitfalls (learn mode)',
      tag: 'evolution',
      role: 'agent',
      body: AttributesBody,
    },
    (c, { params, body }) => {
      if (!body.guidance && !body.pitfalls)
        throw new EngineError('BAD_REQUEST', 'Send guidance and/or pitfalls.', undefined, 400);
      const actor = resolveActor(app, c);
      const out = command(app, params.graph as string, actor, (s, t) => {
        requireLearnAccess(c, s, actor, body.dutyId);
        const edge = s.edges.find((e) => e.id === params.id);
        if (!edge)
          throw new EngineError('NOT_FOUND', `Edge ${params.id} not found.`, undefined, 404);
        const before = { guidance: edge.guidance, pitfalls: edge.pitfalls };
        const append = (current: string | undefined, add: string | undefined) =>
          add
            ? current
              ? current.includes(add)
                ? current
                : `${current}; ${add}`
              : add
            : current;
        const guidance = append(edge.guidance, body.guidance);
        const pitfalls = append(edge.pitfalls, body.pitfalls);
        if (guidance !== undefined) edge.guidance = guidance;
        if (pitfalls !== undefined) edge.pitfalls = pitfalls;
        const provenance = {
          actor: {
            kind: actor.kind,
            agent: actor.agent,
            model: actor.model,
            sessionId: actor.sessionId,
          },
          at: t.ctx.now,
          mode: 'append',
          ...(body.dutyId ? { dutyId: body.dutyId } : {}),
        };
        const history = (edge.attrProvenance.history as unknown[] | undefined) ?? [];
        edge.attrProvenance = {
          ...edge.attrProvenance,
          history: [
            ...history,
            { ...provenance, guidance: body.guidance, pitfalls: body.pitfalls },
          ],
        };
        edge.version += 1;
        edge.updatedAt = t.ctx.now;
        t.touch('edge', edge);
        t.emit('edge.attributes_updated', s.graph.id, 'edge', edge.id, {
          before,
          after: { guidance: edge.guidance, pitfalls: edge.pitfalls },
          provenance,
        });
        return edge;
      });
      return respond(c, out.result);
    },
  );

  api.route(
    {
      method: 'get',
      path: '/graphs/:graph/evolution',
      summary: 'Evolution status: mode, scores, duties, lessons',
      tag: 'evolution',
      role: 'viewer',
    },
    (c, { params }) => {
      const state = readGraph(app, params.graph as string);
      const graphLessons = app.db
        .select()
        .from(lessons)
        .where(sql`json_extract(${lessons.scope}, '$.graph') = ${state.graph.id}`)
        .all()
        .map((r) => stripNulls<Lesson>(r as Record<string, unknown>));
      return respond(c, {
        mode: state.graph.evolution.mode,
        settings: state.graph.evolution,
        metrics: runMetrics(state, app.now()),
        duties: [...state.lessonDuties.values()],
        lessons: graphLessons,
        proposals: [],
        rejectionMemory: [],
        protected: ['aims', 'guards', 'policy', 'validationSuites', 'evolutionGate', 'evolution'],
      });
    },
  );
}

function rankFor(
  rows: Lesson[],
  state: GraphState,
  node: ReturnType<typeof engine.nodeByKey>,
): Lesson[] {
  const keyOf = (id: string) => state.nodes.get(id)?.key ?? '';
  return rankLessons(rows, {
    graphId: state.graph.id,
    nodeKey: node.key,
    nodeKind: node.kind,
    tags: node.tags,
    edges: state.edges
      .filter((e) => e.fromNodeId === node.id || e.toNodeId === node.id)
      .map((e) => [keyOf(e.fromNodeId), keyOf(e.toNodeId)] as [string, string]),
  });
}
