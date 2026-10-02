import { createHash } from 'node:crypto';
import { EngineError, SPEC_SCHEMA } from '@agent-graphs/core';
import { and, eq } from 'drizzle-orm';
import { Hono, type MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import pino from 'pino';
import { authMiddleware, type Env } from './auth';
import { type Config, loadConfig } from './config';
import { type AppContext, createContext } from './context';
import { idempotencyKeys } from './db/schema';
import { createDb } from './db/sqlite';
import { attemptRoutes } from './routes/attempts';
import { Api } from './routes/define';
import { graphRoutes } from './routes/graphs';
import { inboxRoutes } from './routes/inbox';
import { metaRoutes } from './routes/meta';
import { nodeRoutes } from './routes/nodes';
import { structureRoutes } from './routes/structure';

export const VERSION = '0.1.0';

export type CreateAppOptions = {
  context?: AppContext;
  config?: Partial<Config>;
  now?: () => number;
};

/**
 * Builds the HTTP app (docs/architecture.md §3): thin routes over commands over the engine.
 * Without a context it opens an in-memory database (tests and demos).
 */
export function createApp(
  options: CreateAppOptions = {},
): Hono<Env> & { ctx: AppContext; api: Api } {
  const ctx =
    options.context ??
    (() => {
      const config = loadConfig({}, { databasePath: ':memory:', ...options.config });
      return createContext(
        createDb(config.databasePath),
        config,
        pino({ level: 'silent' }),
        options.now,
      );
    })();
  const app = new Hono<Env>() as Hono<Env> & { ctx: AppContext; api: Api };
  app.ctx = ctx;

  if (ctx.config.corsOrigins.length)
    app.use('*', cors({ origin: ctx.config.corsOrigins, credentials: true }));
  app.get('/health', (c) => c.json({ ok: true, version: VERSION, spec: SPEC_SCHEMA }));
  app.use('/api/v1/*', authMiddleware(ctx));
  app.use('/api/v1/*', idempotency(ctx));

  const api = new Api(app);
  app.api = api;
  graphRoutes(api, ctx);
  nodeRoutes(api, ctx);
  attemptRoutes(api, ctx);
  structureRoutes(api, ctx);
  inboxRoutes(api, ctx);
  metaRoutes(api, ctx, { version: VERSION });

  app.notFound((c) =>
    c.json(
      {
        error: {
          code: 'NOT_FOUND',
          message: `No route for ${c.req.method} ${c.req.path}.`,
          hint: 'See GET /api/v1/openapi.json.',
        },
      },
      404,
    ),
  );
  app.onError((error, c) => {
    if (error instanceof EngineError) {
      return c.json(
        {
          error: {
            code: error.code,
            message: error.message,
            ...(error.hint ? { hint: error.hint } : {}),
            ...(error.details !== undefined ? { details: error.details } : {}),
          },
        },
        error.status as 400,
      );
    }
    ctx.log.error({ err: error, path: c.req.path }, 'unhandled error');
    return c.json({ error: { code: 'INTERNAL', message: 'Internal server error.' } }, 500);
  });
  return app;
}

/**
 * `Idempotency-Key` on POST: the same key and body within 24 h replays the original response;
 * the same key with a different body is `422 IDEMPOTENCY_MISMATCH` (docs/api.md §1).
 */
function idempotency(ctx: AppContext): MiddlewareHandler<Env> {
  return async (c, next) => {
    const key = c.req.header('idempotency-key');
    if (c.req.method !== 'POST' || !key) return next();
    const tokenId = c.get('auth').tokenId;
    const body = await c.req.text();
    const requestHash = createHash('sha256')
      .update(`${c.req.method} ${c.req.path}\n${body}`)
      .digest('hex');
    const prior = ctx.db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tokenId, tokenId), eq(idempotencyKeys.key, key)))
      .get();
    if (prior && prior.createdAt > ctx.now() - 24 * 3600_000) {
      if (prior.requestHash !== requestHash) {
        throw new EngineError(
          'IDEMPOTENCY_MISMATCH',
          'This Idempotency-Key was used with a different request.',
          'Use a new key for a new request.',
          422,
        );
      }
      return c.body(prior.responseBody, prior.statusCode as 200, {
        'Content-Type': 'application/json',
        'Idempotent-Replay': 'true',
      });
    }
    await next();
    if (
      c.res.status < 500 &&
      (c.res.headers.get('content-type') ?? '').includes('application/json')
    ) {
      const responseBody = await c.res.clone().text();
      ctx.db
        .insert(idempotencyKeys)
        .values({
          tokenId,
          key,
          method: c.req.method,
          path: c.req.path,
          requestHash,
          statusCode: c.res.status,
          responseBody,
          createdAt: ctx.now(),
        })
        .onConflictDoUpdate({
          target: [idempotencyKeys.tokenId, idempotencyKeys.key],
          set: { requestHash, statusCode: c.res.status, responseBody, createdAt: ctx.now() },
        })
        .run();
    }
  };
}
