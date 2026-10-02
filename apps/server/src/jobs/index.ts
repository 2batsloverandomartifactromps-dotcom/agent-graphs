/** Background jobs (docs/architecture.md §3.4). Idempotent, so restarts are safe. */
import { engine } from '@agent-graphs/core';
import { and, inArray, lt, sql } from 'drizzle-orm';
import { type AppContext, command } from '../context';
import { graphs, idempotencyKeys, sessions } from '../db/schema';

const SYSTEM = { kind: 'system' as const, agent: 'agent-graphs', mechanism: 'job' };
const DAY = 24 * 3600_000;

/** One sweep: expire leases, flag timeouts and stalls, re-check guards; mark lost sessions. */
export function sweepOnce(app: AppContext): { graphs: number; expired: number } {
  const live = app.db
    .select({ id: graphs.id })
    .from(graphs)
    .where(inArray(graphs.status, ['active', 'paused', 'verifying']))
    .all();
  let expired = 0;
  for (const { id } of live) {
    try {
      const out = command(app, id, SYSTEM, (s, t) => engine.sweep(s, t));
      expired += out.result.expired.length;
    } catch (error) {
      app.log.error({ err: error, graphId: id }, 'sweep failed');
    }
  }
  const lostBefore = app.now() - 3600_000;
  app.db
    .update(sessions)
    .set({ status: 'lost' })
    .where(and(inArray(sessions.status, ['active', 'idle']), lt(sessions.lastSeenAt, lostBefore)))
    .run();
  return { graphs: live.length, expired };
}

export function purgeOnce(app: AppContext): void {
  app.db
    .delete(idempotencyKeys)
    .where(sql`${idempotencyKeys.createdAt} < ${app.now() - DAY}`)
    .run();
}

export function startJobs(app: AppContext): () => void {
  const sweep = setInterval(() => sweepOnce(app), app.config.leaseSweepIntervalMs);
  const purge = setInterval(() => purgeOnce(app), 3600_000);
  sweep.unref();
  purge.unref();
  return () => {
    clearInterval(sweep);
    clearInterval(purge);
  };
}
