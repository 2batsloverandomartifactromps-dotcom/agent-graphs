/**
 * Auth (docs/api.md §1): token roles, local mode, actor resolution, and orchestrator
 * capability checks for agent tokens.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  EngineError,
  type ExecutionAnnotation,
  engine,
  type GraphState,
  type Node,
  type OrchestratorCapability,
} from '@agent-graphs/core';
import { eq } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import type { AppContext } from './context';
import { apiTokens } from './db/schema';
import { newId } from './ids';
import { annotationOf, getSession, type SessionInput, sessionForActor } from './sessions';

export type Role = 'viewer' | 'agent' | 'admin';
export type Auth = { role: Role; tokenId: string; tokenName?: string; local: boolean };
export type Env = { Variables: { auth: Auth } };

const RANK: Record<Role, number> = { viewer: 0, agent: 1, admin: 2 };

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function issueToken(
  app: AppContext,
  name: string,
  role: Role,
  createdBy?: ExecutionAnnotation,
) {
  const secret = `ag_${randomBytes(32).toString('base64url')}`;
  const row = {
    id: newId('tk', app.now()),
    name,
    role,
    tokenHash: hashToken(secret),
    prefix: secret.slice(0, 10),
    createdBy: createdBy ?? null,
    createdAt: app.now(),
    lastUsedAt: null,
    revokedAt: null,
  };
  app.db.insert(apiTokens).values(row).run();
  return { token: secret, ...row };
}

export function authMiddleware(app: AppContext): MiddlewareHandler<Env> {
  return async (c, next) => {
    const header = c.req.header('authorization');
    const bearer = header?.match(/^Bearer\s+(.+)$/i)?.[1] ?? c.req.query('access_token');
    if (bearer) {
      const row = app.db
        .select()
        .from(apiTokens)
        .where(eq(apiTokens.tokenHash, hashToken(bearer)))
        .get();
      if (!row || row.revokedAt) {
        throw new EngineError(
          'UNAUTHENTICATED',
          'Invalid or revoked token.',
          'Create a token with `agraph token create`.',
          401,
        );
      }
      app.db.update(apiTokens).set({ lastUsedAt: app.now() }).where(eq(apiTokens.id, row.id)).run();
      c.set('auth', { role: row.role as Role, tokenId: row.id, tokenName: row.name, local: false });
    } else if (app.config.authMode === 'local') {
      c.set('auth', { role: 'admin', tokenId: 'local', local: true });
    } else {
      throw new EngineError(
        'UNAUTHENTICATED',
        'A bearer token is required (AUTH_MODE=token).',
        'Send Authorization: Bearer <token>.',
        401,
      );
    }
    await next();
  };
}

export function requireRole(c: Context<Env>, role: Role): Auth {
  const auth = c.get('auth');
  if (RANK[auth.role] < RANK[role]) {
    throw new EngineError(
      'FORBIDDEN',
      `This action needs the ${role} role (you have ${auth.role}).`,
      undefined,
      403,
    );
  }
  return auth;
}

/**
 * Who is acting: `X-Agent-Session`, a `session` field, an inline `actor` annotation (which
 * creates or reuses a session), or the human/admin behind the request.
 */
export function resolveActor(
  app: AppContext,
  c: Context<Env>,
  body?: { actor?: Partial<ExecutionAnnotation>; session?: string; skills?: string[] },
): ExecutionAnnotation {
  const auth = c.get('auth');
  const sessionId = c.req.header('x-agent-session') ?? body?.session;
  if (sessionId) return annotationOf(getSession(app, sessionId));
  if (body?.actor && Object.keys(body.actor).length) {
    const actor = { kind: 'agent', ...body.actor } as SessionInput;
    if (actor.kind === 'human') return actor as ExecutionAnnotation;
    const session = sessionForActor(app, actor, {
      tokenId: auth.tokenId,
      ...(body.skills ? { skills: body.skills } : {}),
    });
    return {
      ...annotationOf(session),
      ...stripUndefined(body.actor),
      sessionId: session.id,
    } as ExecutionAnnotation;
  }
  if (auth.role === 'agent') return { kind: 'agent', agent: auth.tokenName ?? 'agent' };
  const name = c.req.header('x-actor-name');
  return {
    kind: 'human',
    agent: name ?? auth.tokenName ?? (auth.local ? 'local admin' : 'admin'),
    provider: 'human',
    mechanism: c.req.header('x-client') ?? 'api',
  };
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/**
 * Agent tokens exercise orchestrator capabilities through a session holding an active
 * orchestrator lease whose scope covers the node. Admins (and local mode) pass.
 */
export function requireCapability(
  c: Context<Env>,
  state: GraphState,
  actor: ExecutionAnnotation,
  capability: OrchestratorCapability,
  node?: Node,
): void {
  const auth = c.get('auth');
  if (auth.role === 'admin') return;
  requireRole(c, 'agent');
  const holder = [...state.orchestrators.values()].find(
    (o) =>
      o.status === 'active' &&
      o.sessionId !== undefined &&
      o.sessionId === actor.sessionId &&
      o.capabilities.includes(capability) &&
      (!node || engine.inScope(o, node)),
  );
  if (!holder) {
    throw new EngineError(
      'POLICY_DENIED',
      `This action needs an attached orchestrator with the '${capability}' capability${node ? ` whose scope covers '${node.key}'` : ''}.`,
      'Attach one with POST /graphs/{graph}/orchestrators/{key}/attach and send its session in X-Agent-Session.',
      403,
    );
  }
}
