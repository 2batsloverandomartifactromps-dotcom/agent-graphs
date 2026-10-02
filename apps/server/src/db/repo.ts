/**
 * Repositories: load a GraphState and apply engine effects (docs/architecture.md §3.1).
 * Entities and rows share property names, so mapping is generic: nulls become absent fields
 * on load, and absent fields become NULL on write.
 */
import {
  chainGenesis,
  chainHash,
  type DomainEvent,
  type Effect,
  type EntityKind,
  type GraphState,
} from '@agent-graphs/core';
import { and, asc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { newId } from '../ids';
import * as s from './schema';
import type { Db } from './sqlite';

const TABLES: Record<EntityKind, SQLiteTable> = {
  graph: s.graphs,
  node: s.nodes,
  edge: s.edges,
  loop: s.loops,
  aim: s.aims,
  attempt: s.attempts,
  evaluation: s.evaluations,
  metric: s.metrics,
  orchestrator: s.orchestrators,
  request: s.requests,
  directive: s.directives,
  delivery: s.directiveDeliveries,
  note: s.notes,
  lessonDuty: s.lessonDuties,
};

/** Columns the server owns; engine upserts never overwrite them. */
const SERVER_OWNED: Partial<Record<EntityKind, string[]>> = {
  graph: ['chainHead', 'sourceSpec'],
  attempt: ['briefingHash'],
  note: [
    'retractedAt',
    'retractedReason',
    'retractedBy',
    'resolvedAt',
    'resolvedBy',
    'resolutionNoteId',
  ],
};

/** Append-only kinds: inserted once, never updated (invariant 8). */
const APPEND_ONLY = new Set<EntityKind>(['evaluation', 'metric', 'note']);

export function stripNulls<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (v !== null && v !== undefined) out[k] = v;
  return out as T;
}

function toRow(kind: EntityKind, entity: Record<string, unknown>, graphId: string) {
  const table = TABLES[kind];
  const owned = new Set(SERVER_OWNED[kind] ?? []);
  const row: Record<string, unknown> = {};
  for (const key of Object.keys(getTableColumns(table))) {
    if (owned.has(key)) continue;
    row[key] = entity[key] ?? null;
  }
  if ('graphId' in row && row.graphId === null) row.graphId = graphId;
  return row;
}

export function loadState(db: Db, graphId: string): GraphState | undefined {
  const graph = db.select().from(s.graphs).where(eq(s.graphs.id, graphId)).get();
  if (!graph) return undefined;
  const byGraph = <T extends SQLiteTable & { graphId: unknown }>(table: T) =>
    db
      .select()
      .from(table as SQLiteTable)
      .where(eq((table as unknown as { graphId: typeof s.nodes.graphId }).graphId, graphId))
      .all()
      .map((r) => stripNulls<Record<string, unknown>>(r as Record<string, unknown>));
  const map = <T extends { id: string }>(rows: Record<string, unknown>[]) =>
    new Map(rows.map((r) => [r.id as string, r as unknown as T]));
  const {
    chainHead: _c,
    sourceSpec: _s,
    ...graphFields
  } = stripNulls<Record<string, unknown>>(graph);
  const evaluations = byGraph(s.evaluations).sort(
    (a, b) => (a.createdAt as number) - (b.createdAt as number),
  );
  const metrics = byGraph(s.metrics).sort(
    (a, b) => (a.recordedAt as number) - (b.recordedAt as number),
  );
  const openHighFindings = db
    .select({ n: sql<number>`count(*)` })
    .from(s.notes)
    .where(
      and(
        eq(s.notes.graphId, graphId),
        eq(s.notes.type, 'finding'),
        inArray(s.notes.severity, ['high', 'critical']),
        sql`${s.notes.retractedAt} IS NULL`,
        sql`${s.notes.resolvedAt} IS NULL`,
      ),
    )
    .get()?.n;
  return {
    graph: graphFields as unknown as GraphState['graph'],
    nodes: map(byGraph(s.nodes)),
    edges: byGraph(s.edges) as unknown as GraphState['edges'],
    loops: byGraph(s.loops) as unknown as GraphState['loops'],
    aims: map(byGraph(s.aims)),
    attempts: map(byGraph(s.attempts)),
    evaluations: evaluations as unknown as GraphState['evaluations'],
    metrics: metrics as unknown as GraphState['metrics'],
    orchestrators: map(byGraph(s.orchestrators)),
    requests: map(byGraph(s.requests)),
    directives: map(byGraph(s.directives)),
    deliveries: byGraph(s.directiveDeliveries).map(
      ({ graphId: _g, ...d }) => d,
    ) as unknown as GraphState['deliveries'],
    lessonDuties: map(byGraph(s.lessonDuties)),
    openHighFindings: openHighFindings ?? 0,
  };
}

/** Apply the dirty set: upserts, inserts for append-only kinds, and deletions. */
export function persistEffects(db: Db, effects: Effect[], graphId: string): void {
  // Parents before children so foreign keys hold on insert.
  const order: EntityKind[] = [
    'graph',
    'node',
    'edge',
    'loop',
    'orchestrator',
    'aim',
    'attempt',
    'evaluation',
    'metric',
    'note',
    'request',
    'directive',
    'delivery',
    'lessonDuty',
  ];
  const sorted = [...effects].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  for (const effect of sorted.filter((e) => e.deleted).reverse()) {
    const table = TABLES[effect.kind] as SQLiteTable & { id: typeof s.nodes.id };
    db.delete(table)
      .where(eq(table.id, effect.entity.id as string))
      .run();
  }
  for (const effect of sorted) {
    if (effect.deleted) continue;
    const table = TABLES[effect.kind];
    const row = toRow(effect.kind, effect.entity as Record<string, unknown>, graphId);
    if (APPEND_ONLY.has(effect.kind)) {
      db.insert(table).values(row).onConflictDoNothing().run();
      continue;
    }
    const target =
      effect.kind === 'delivery'
        ? [s.directiveDeliveries.directiveId, s.directiveDeliveries.recipient]
        : (table as unknown as { id: typeof s.nodes.id }).id;
    const { id: _id, ...set } = row;
    db.insert(table).values(row).onConflictDoUpdate({ target, set }).run();
  }
}

export type StoredEvent = typeof s.events.$inferSelect;

/** Append events to the per-graph hash chain (docs/data-model.md § Hash chain). */
export function appendEvents(db: Db, graphId: string | null, events: DomainEvent[]): StoredEvent[] {
  if (events.length === 0) return [];
  const headKey = 'chain_head:global';
  let prev: string;
  if (graphId) {
    prev =
      db.select({ h: s.graphs.chainHead }).from(s.graphs).where(eq(s.graphs.id, graphId)).get()
        ?.h ?? chainGenesis(graphId);
  } else {
    prev =
      (db.select().from(s.settings).where(eq(s.settings.key, headKey)).get()?.value as
        | string
        | undefined) ?? chainGenesis(null);
  }
  const maxSeq = db.select({ m: sql<number>`coalesce(max(seq), 0)` }).from(s.events).get()?.m ?? 0;
  const stored: StoredEvent[] = [];
  events.forEach((e, i) => {
    const row = {
      seq: maxSeq + i + 1,
      id: newId('evt'),
      graphId,
      type: e.type,
      entityType: e.entityType,
      entityId: e.entityId,
      actor: e.actor,
      payload: e.payload,
      createdAt: e.createdAt,
    };
    const hash = chainHash(prev, row);
    const full = { ...row, prevHash: prev, hash };
    db.insert(s.events).values(full).run();
    stored.push(full as StoredEvent);
    prev = hash;
  });
  if (graphId) db.update(s.graphs).set({ chainHead: prev }).where(eq(s.graphs.id, graphId)).run();
  else
    db.insert(s.settings)
      .values({ key: headKey, value: prev })
      .onConflictDoUpdate({ target: s.settings.key, set: { value: prev } })
      .run();
  return stored;
}

export function graphEvents(db: Db, graphId: string, after = 0, limit = 500): StoredEvent[] {
  return db
    .select()
    .from(s.events)
    .where(and(eq(s.events.graphId, graphId), sql`${s.events.seq} > ${after}`))
    .orderBy(asc(s.events.seq))
    .limit(limit)
    .all();
}

/** Resolve a graph by id or slug. */
export function findGraphId(db: Db, ref: string): string | undefined {
  const row = db
    .select({ id: s.graphs.id })
    .from(s.graphs)
    .where(ref.startsWith('gr_') ? eq(s.graphs.id, ref) : eq(s.graphs.slug, ref))
    .get();
  return row?.id;
}
