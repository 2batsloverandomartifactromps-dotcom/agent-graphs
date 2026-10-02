/**
 * Application context and the command runner (docs/architecture.md §3.1–§3.2): every write
 * opens an IMMEDIATE transaction, loads the GraphState, runs one engine command, persists the
 * effects and hash-chained events, commits, and only then publishes to SSE subscribers.
 */
import {
  type DomainEvent,
  type EngineCtx,
  EngineError,
  type ExecutionAnnotation,
  engine,
  type GraphState,
  type NormalizedSpec,
  Tx,
} from '@agent-graphs/core';
import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Config } from './config';
import { appendEvents, findGraphId, loadState, persistEffects, type StoredEvent } from './db/repo';
import { graphs } from './db/schema';
import type { Db } from './db/sqlite';
import { EventHub, type HubMessage } from './events/hub';
import { newId } from './ids';
import { snapshotFor } from './read/views';

export type AppContext = {
  db: Db;
  config: Config;
  hub: EventHub;
  now: () => number;
  log: Logger;
};

export function engineCtx(app: AppContext, actor: ExecutionAnnotation): EngineCtx {
  const now = app.now();
  return { now, actor, id: (prefix) => newId(prefix, now) };
}

export function messagesFor(stored: StoredEvent[], state?: GraphState): HubMessage[] {
  return stored.map((e) => ({
    seq: e.seq,
    type: e.type,
    graphId: e.graphId,
    entity: { type: e.entityType, id: e.entityId },
    actor: e.actor,
    payload: e.payload,
    createdAt: new Date(e.createdAt).toISOString(),
    snapshot: snapshotFor(state, e.entityType, e.entityId),
  }));
}

export function resolveGraphId(app: AppContext, ref: string): string {
  const id = findGraphId(app.db, ref);
  if (!id)
    throw new EngineError(
      'NOT_FOUND',
      `Graph '${ref}' does not exist.`,
      'List graphs with GET /api/v1/graphs.',
      404,
    );
  return id;
}

/** Read-only: load the current state of a graph. */
export function readGraph(app: AppContext, ref: string): GraphState {
  const id = resolveGraphId(app, ref);
  return loadState(app.db, id) as GraphState;
}

export type CommandResult<R> = { result: R; state: GraphState; events: StoredEvent[] };

/** Run one engine command against a graph in a single transaction. */
export function command<R>(
  app: AppContext,
  graphRef: string,
  actor: ExecutionAnnotation,
  fn: (state: GraphState, tx: Tx) => R,
  extra?: (state: GraphState, result: R) => void,
): CommandResult<R> {
  const graphId = resolveGraphId(app, graphRef);
  const sqlite = app.db.$client;
  const out = sqlite
    .transaction(() => {
      const state = loadState(app.db, graphId);
      if (!state)
        throw new EngineError('NOT_FOUND', `Graph '${graphRef}' does not exist.`, undefined, 404);
      const run = engine.run(state, engineCtx(app, actor), fn);
      persistEffects(app.db, run.effects, graphId);
      const events = appendEvents(app.db, graphId, run.events);
      extra?.(state, run.result);
      return { result: run.result, state, events };
    })
    .immediate();
  app.hub.publish(messagesFor(out.events, out.state));
  return out;
}

/** Create a graph from a validated spec (and optionally start it) in one transaction. */
export function createGraph(
  app: AppContext,
  spec: NormalizedSpec,
  actor: ExecutionAnnotation,
  options: { start?: boolean } = {},
): CommandResult<{ started: boolean; requestId?: string }> {
  const sqlite = app.db.$client;
  const out = sqlite
    .transaction(() => {
      if (spec.slug && findGraphId(app.db, spec.slug)) {
        throw new EngineError(
          'CONFLICT',
          `A graph with slug '${spec.slug}' already exists.`,
          'Choose another slug or omit it.',
          409,
        );
      }
      const ctx = engineCtx(app, actor);
      const tx = new Tx(ctx);
      const state = engine.buildGraph(spec, tx);
      persistEffects(app.db, [...tx.dirty.values()], state.graph.id);
      app.db.update(graphs).set({ sourceSpec: spec }).where(eq(graphs.id, state.graph.id)).run();
      const events: DomainEvent[] = [...tx.events];
      let result: { started: boolean; requestId?: string } = { started: false };
      if (options.start) {
        const run = engine.run(state, ctx, (s, t) => engine.startGraph(s, t));
        persistEffects(app.db, run.effects, state.graph.id);
        events.push(...run.events);
        result = {
          started: run.result.started,
          ...(run.result.request ? { requestId: run.result.request.id } : {}),
        };
      }
      const stored = appendEvents(app.db, state.graph.id, events);
      return { result, state, events: stored };
    })
    .immediate();
  app.hub.publish(messagesFor(out.events, out.state));
  return out;
}

/** Append global (non-graph) events, such as session lifecycle. */
export function globalEvents(app: AppContext, events: DomainEvent[]): void {
  const stored = app.db.$client.transaction(() => appendEvents(app.db, null, events)).immediate();
  app.hub.publish(messagesFor(stored));
}

export function createContext(
  db: Db,
  config: Config,
  log: Logger,
  now: () => number = Date.now,
): AppContext {
  return { db, config, hub: new EventHub(), now, log };
}
