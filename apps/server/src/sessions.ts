/** Sessions (docs/concepts.md §10): registered agent or human processes and their lineage. */
import { EngineError, type ExecutionAnnotation } from '@agent-graphs/core';
import { and, eq, inArray } from 'drizzle-orm';
import type { AppContext } from './context';
import { globalEvents } from './context';
import { sessions } from './db/schema';
import { newId } from './ids';

export type SessionRow = typeof sessions.$inferSelect;

export function annotationOf(s: SessionRow): ExecutionAnnotation {
  const a: ExecutionAnnotation = { kind: s.kind as ExecutionAnnotation['kind'], sessionId: s.id };
  if (s.name) a.agent = s.name;
  if (s.role) a.role = s.role;
  if (s.model) a.model = s.model;
  if (s.thinking) a.thinking = s.thinking;
  if (s.thinkingBudget !== null) a.thinkingBudget = s.thinkingBudget;
  if (s.provider) a.provider = s.provider;
  if (s.mechanism) a.mechanism = s.mechanism;
  if (s.clientSessionId) a.clientSessionId = s.clientSessionId;
  if (s.parentSessionId) a.parentSessionId = s.parentSessionId;
  if (s.version) a.version = s.version;
  return a;
}

export function getSession(app: AppContext, id: string): SessionRow {
  const row = app.db.select().from(sessions).where(eq(sessions.id, id)).get();
  if (!row)
    throw new EngineError(
      'NOT_FOUND',
      `Session ${id} not found.`,
      'Register with POST /api/v1/sessions.',
      404,
    );
  return row;
}

export function sessionByClientId(
  app: AppContext,
  clientSessionId: string,
): SessionRow | undefined {
  return app.db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.clientSessionId, clientSessionId),
        inArray(sessions.status, ['active', 'idle']),
      ),
    )
    .get();
}

export type SessionInput = Partial<ExecutionAnnotation> & {
  skills?: string[];
  meta?: Record<string, unknown>;
};

export function createSession(
  app: AppContext,
  input: SessionInput,
  options: { parentSessionId?: string; tokenId?: string } = {},
): SessionRow {
  const now = app.now();
  const row: SessionRow = {
    id: newId('se', now),
    kind: input.kind ?? 'agent',
    name: input.agent ?? null,
    role: input.role ?? null,
    provider: input.provider ?? null,
    model: input.model ?? null,
    thinking: input.thinking ?? null,
    thinkingBudget: input.thinkingBudget ?? null,
    mechanism: input.mechanism ?? null,
    version: input.version ?? null,
    clientSessionId: options.parentSessionId ? null : (input.clientSessionId ?? null),
    parentSessionId: options.parentSessionId ?? input.parentSessionId ?? null,
    tokenId: options.tokenId ?? null,
    skills: input.skills ?? [],
    meta: input.meta ?? {},
    status: 'active',
    usage: null,
    startedAt: now,
    lastSeenAt: now,
    endedAt: null,
  };
  app.db.insert(sessions).values(row).run();
  globalEvents(app, [
    {
      type: 'session.registered',
      graphId: '',
      entityType: 'session',
      entityId: row.id,
      actor: annotationOf(row),
      payload: { parentSessionId: row.parentSessionId, clientSessionId: row.clientSessionId },
      createdAt: now,
    },
  ]);
  return row;
}

/** Look up (by id or client session id) or create the session behind an inline annotation. */
export function sessionForActor(
  app: AppContext,
  actor: SessionInput,
  options: { parentSessionId?: string; tokenId?: string; skills?: string[] } = {},
): SessionRow {
  if (options.parentSessionId)
    return createSession(
      app,
      { ...actor, ...(options.skills ? { skills: options.skills } : {}) },
      options,
    );
  if (actor.sessionId)
    return touchSession(app, getSession(app, actor.sessionId), actor, options.skills);
  if (actor.clientSessionId) {
    const existing = sessionByClientId(app, actor.clientSessionId);
    if (existing) return touchSession(app, existing, actor, options.skills);
  }
  return createSession(
    app,
    { ...actor, ...(options.skills ? { skills: options.skills } : {}) },
    options,
  );
}

/** Refresh last-seen, and adopt annotation fields that changed (for example a model switch). */
function touchSession(
  app: AppContext,
  row: SessionRow,
  actor: SessionInput,
  skills?: string[],
): SessionRow {
  const patch: Partial<SessionRow> = { lastSeenAt: app.now(), status: 'active' };
  if (actor.model && actor.model !== row.model) patch.model = actor.model;
  if (actor.thinking && actor.thinking !== row.thinking) patch.thinking = actor.thinking;
  if (actor.mechanism && actor.mechanism !== row.mechanism) patch.mechanism = actor.mechanism;
  if (actor.agent && actor.agent !== row.name) patch.name = actor.agent;
  if (skills?.length) patch.skills = [...new Set([...(row.skills as string[]), ...skills])];
  app.db.update(sessions).set(patch).where(eq(sessions.id, row.id)).run();
  return { ...row, ...patch };
}

/** A session and all its descendants (dispatched subagents), for lease renewal. */
export function sessionTree(app: AppContext, rootId: string): string[] {
  const ids = [rootId];
  for (let i = 0; i < ids.length; i++) {
    const children = app.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.parentSessionId, ids[i] as string))
      .all();
    for (const c of children) if (!ids.includes(c.id)) ids.push(c.id);
  }
  return ids;
}
