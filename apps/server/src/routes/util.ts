import {
  type Attempt,
  EngineError,
  engine,
  type GraphState,
  type Lesson,
  type Node,
  type Note,
  renderBriefing,
} from '@agent-graphs/core';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Context } from 'hono';
import type { Env } from '../auth';
import type { AppContext } from '../context';
import { stripNulls } from '../db/repo';
import { attempts, lessons, notes } from '../db/schema';
import { toApi } from '../read/views';

export function respond(c: Context<Env>, data: unknown, status: 200 | 201 | 202 = 200): Response {
  return c.json(toApi(data) as object, status);
}

export function nodeOf(state: GraphState, key: string): Node {
  return engine.nodeByKey(state, key);
}

/** The graph that owns an attempt (attempt ids are capabilities; no graph in the path). */
export function graphOfAttempt(app: AppContext, attemptId: string): string {
  const row = app.db
    .select({ graphId: attempts.graphId })
    .from(attempts)
    .where(eq(attempts.id, attemptId))
    .get();
  if (!row)
    throw new EngineError(
      'NOT_FOUND',
      `Attempt ${attemptId} not found.`,
      'Check the attempt id from your claim response.',
      404,
    );
  return row.graphId;
}

export function rowToNote(row: Record<string, unknown>): Note {
  return stripNulls<Note>(row);
}

/** Notes on the given nodes (or graph-level notes when nodeIds is empty and graphLevel is set). */
export function notesFor(app: AppContext, graphId: string, nodeIds: string[], limit = 500): Note[] {
  if (nodeIds.length === 0) return [];
  return app.db
    .select()
    .from(notes)
    .where(and(eq(notes.graphId, graphId), inArray(notes.nodeId, nodeIds)))
    .orderBy(desc(notes.createdAt))
    .limit(limit)
    .all()
    .map((r) => rowToNote(r as Record<string, unknown>));
}

export function graphNotes(app: AppContext, graphId: string, type?: string): Note[] {
  return app.db
    .select()
    .from(notes)
    .where(
      and(
        eq(notes.graphId, graphId),
        isNull(notes.nodeId),
        type ? eq(notes.type, type) : undefined,
      ),
    )
    .orderBy(desc(notes.createdAt))
    .limit(500)
    .all()
    .map((r) => rowToNote(r as Record<string, unknown>));
}

export function activeLessons(app: AppContext): Lesson[] {
  return app.db
    .select()
    .from(lessons)
    .where(or(eq(lessons.status, 'active')))
    .all()
    .map((r) => stripNulls<Lesson>(r as Record<string, unknown>));
}

/** Render a briefing with the node's neighborhood notes and candidate lessons. */
export function briefingFor(
  app: AppContext,
  state: GraphState,
  node: Node,
  attempt: Attempt | undefined,
  options: { budget?: number; protocol?: boolean } = {},
) {
  const neighbors = [
    node.id,
    ...engine.requiresPredecessors(state, node.id).map((n) => n.id),
    ...state.edges
      .filter((e) => e.kind === 'informs' && e.toNodeId === node.id)
      .map((e) => e.fromNodeId),
  ];
  return renderBriefing({
    state,
    nodeId: node.id,
    ...(attempt ? { attempt } : {}),
    notes: notesFor(app, state.graph.id, neighbors),
    lessons: state.graph.evolution.mode === 'off' ? [] : activeLessons(app),
    ...(options.budget ? { budget: options.budget } : {}),
    ...(options.protocol === false ? { protocol: false } : {}),
  });
}

export function briefingOut(b: ReturnType<typeof renderBriefing>, format: 'md' | 'json' = 'md') {
  return format === 'json'
    ? {
        format: 'json',
        tokens: b.tokens,
        budget: b.budget,
        overBudget: b.overBudget,
        sections: b.sections,
        warnings: b.warnings,
      }
    : b.markdown;
}
