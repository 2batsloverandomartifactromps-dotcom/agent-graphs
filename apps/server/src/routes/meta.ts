/** Meta routes and SSE streams (docs/api.md § Meta, §3). */
import { EngineError, specJsonSchema, TokenBody, vocabPayload } from '@agent-graphs/core';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { type Env, issueToken, resolveActor } from '../auth';
import { type AppContext, resolveGraphId } from '../context';
import { loadState } from '../db/repo';
import { apiTokens, events, settings } from '../db/schema';
import type { HubMessage } from '../events/hub';
import { snapshotFor } from '../read/views';
import type { Api } from './define';
import { respond } from './util';

const REPLAY_LIMIT = 10_000;
const PING_MS = 15_000;

export function metaRoutes(api: Api, app: AppContext, info: { version: string }): void {
  api.route(
    {
      method: 'get',
      path: '/openapi.json',
      summary: 'OpenAPI 3.1 document',
      tag: 'meta',
      role: 'viewer',
    },
    (c) => c.json(api.openapi({ title: 'Agent Graphs API', version: info.version })),
  );
  api.route(
    {
      method: 'get',
      path: '/schema/graph-spec.json',
      summary: 'JSON Schema for specs',
      tag: 'meta',
      role: 'viewer',
    },
    (c) => c.json(specJsonSchema()),
  );
  api.route(
    {
      method: 'get',
      path: '/vocab',
      summary: 'Vocabularies and display metadata',
      tag: 'meta',
      role: 'viewer',
    },
    (c) => {
      const overrides = app.db
        .select()
        .from(settings)
        .where(eq(settings.key, 'vocab_overrides'))
        .get()?.value as Record<string, unknown> | undefined;
      return respond(c, { ...vocabPayload(), overrides: overrides ?? {} });
    },
  );
  api.route(
    {
      method: 'put',
      path: '/vocab',
      summary: 'Display overrides',
      tag: 'meta',
      role: 'admin',
      body: z.record(z.string(), z.unknown()),
    },
    (c, { body }) => {
      app.db
        .insert(settings)
        .values({ key: 'vocab_overrides', value: body })
        .onConflictDoUpdate({ target: settings.key, set: { value: body } })
        .run();
      return respond(c, { ...vocabPayload(), overrides: body });
    },
  );
  api.route(
    { method: 'get', path: '/me', summary: 'Token role and identity', tag: 'meta', role: 'viewer' },
    (c) => {
      const auth = c.get('auth');
      return respond(c, {
        role: auth.role,
        tokenId: auth.tokenId,
        tokenName: auth.tokenName,
        authMode: app.config.authMode,
        actor: resolveActor(app, c),
      });
    },
  );
  api.route(
    { method: 'get', path: '/tokens', summary: 'API tokens', tag: 'meta', role: 'admin' },
    (c) => {
      const rows = app.db
        .select()
        .from(apiTokens)
        .where(isNull(apiTokens.revokedAt))
        .orderBy(desc(apiTokens.createdAt))
        .all();
      return respond(c, { items: rows.map(({ tokenHash: _h, ...r }) => r) });
    },
  );
  api.route(
    {
      method: 'post',
      path: '/tokens',
      summary: 'Create a token (shown once)',
      tag: 'meta',
      role: 'admin',
      body: TokenBody,
    },
    (c, { body }) => {
      const { tokenHash: _h, ...row } = issueToken(app, body.name, body.role, resolveActor(app, c));
      return respond(c, row, 201);
    },
  );
  api.route(
    {
      method: 'delete',
      path: '/tokens/:id',
      summary: 'Revoke a token',
      tag: 'meta',
      role: 'admin',
    },
    (c, { params }) => {
      const result = app.db
        .update(apiTokens)
        .set({ revokedAt: app.now() })
        .where(eq(apiTokens.id, params.id as string))
        .run();
      if (result.changes === 0)
        throw new EngineError('NOT_FOUND', `Token ${params.id} not found.`, undefined, 404);
      return respond(c, { revoked: params.id });
    },
  );

  api.route(
    {
      method: 'get',
      path: '/graphs/:graph/events/stream',
      summary: 'Live events (SSE)',
      tag: 'events',
      role: 'viewer',
      produces: 'text/event-stream',
    },
    (c, { params }) => stream(app, c, [resolveGraphId(app, params.graph as string)]),
  );
  api.route(
    {
      method: 'get',
      path: '/events/stream',
      summary: 'Live events across graphs (SSE)',
      tag: 'events',
      role: 'viewer',
      produces: 'text/event-stream',
      query: z.object({ graphs: z.string().optional() }),
    },
    (c, { query }) =>
      stream(
        app,
        c,
        query.graphs ? query.graphs.split(',').map((g) => resolveGraphId(app, g)) : null,
      ),
  );
}

/** SSE with Last-Event-ID replay (up to 10k events, then `resync`) and 15 s pings. */
function stream(app: AppContext, c: Context<Env>, graphIds: string[] | null): Response {
  c.header('Cache-Control', 'no-cache');
  c.header('X-Accel-Buffering', 'no');
  const lastId = Number(c.req.header('last-event-id') ?? c.req.query('lastEventId') ?? 0);
  return streamSSE(c, async (sse) => {
    const queue: HubMessage[] = [];
    let wake: (() => void) | undefined;
    const unsubscribe = app.hub.subscribe(graphIds, (m) => {
      queue.push(m);
      wake?.();
    });
    let closed = false;
    sse.onAbort(() => {
      closed = true;
      unsubscribe();
      wake?.();
    });
    let maxSent = lastId;
    const send = async (m: HubMessage) => {
      if (m.seq <= maxSent) return;
      maxSent = m.seq;
      await sse.writeSSE({ id: String(m.seq), event: m.type, data: JSON.stringify(m) });
    };
    if (lastId > 0) {
      const missed = app.db
        .select()
        .from(events)
        .where(
          and(
            sql`${events.seq} > ${lastId}`,
            graphIds ? inArray(events.graphId, graphIds) : undefined,
          ),
        )
        .orderBy(asc(events.seq))
        .limit(REPLAY_LIMIT + 1)
        .all();
      if (missed.length > REPLAY_LIMIT) {
        await sse.writeSSE({
          event: 'resync',
          data: JSON.stringify({ reason: 'too many missed events; refetch' }),
        });
        maxSent = missed.at(-1)?.seq ?? maxSent;
      } else {
        const states = new Map<string, ReturnType<typeof loadState>>();
        for (const e of missed) {
          if (e.graphId && !states.has(e.graphId))
            states.set(e.graphId, loadState(app.db, e.graphId));
          await send({
            seq: e.seq,
            type: e.type,
            graphId: e.graphId,
            entity: { type: e.entityType, id: e.entityId },
            actor: e.actor,
            payload: e.payload,
            createdAt: new Date(e.createdAt).toISOString(),
            snapshot: snapshotFor(
              e.graphId ? states.get(e.graphId) : undefined,
              e.entityType,
              e.entityId,
            ),
          });
        }
      }
    } else {
      await sse.writeSSE({ event: 'ready', data: JSON.stringify({ graphs: graphIds }) });
    }
    while (!closed) {
      while (queue.length) await send(queue.shift() as HubMessage);
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, PING_MS);
      });
      wake = undefined;
      if (!closed && queue.length === 0) await sse.write(': ping\n\n');
    }
  });
}
