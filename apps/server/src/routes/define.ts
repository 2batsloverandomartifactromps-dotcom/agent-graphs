/**
 * Route declaration: each route names its role, body/query schemas (zod, from
 * @agent-graphs/core), and handler. The same declarations generate the OpenAPI 3.1 document,
 * so validation and docs never drift.
 */
import { EngineError } from '@agent-graphs/core';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { type Env, type Role, requireRole } from '../auth';

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';

export type RouteSpec<B extends z.ZodType | undefined, Q extends z.ZodType | undefined> = {
  method: Method;
  path: string;
  summary: string;
  tag: string;
  role: Role;
  body?: B;
  query?: Q;
  /** Response content type (default application/json). */
  produces?: string;
};

type Infer<T> = T extends z.ZodType ? z.infer<T> : undefined;

export type Handler<B, Q> = (
  c: Context<Env>,
  input: { body: B; query: Q; params: Record<string, string> },
) => Response | Promise<Response>;

export class Api {
  readonly specs: Array<RouteSpec<z.ZodType | undefined, z.ZodType | undefined>> = [];

  constructor(
    readonly app: Hono<Env>,
    readonly prefix = '/api/v1',
  ) {}

  route<B extends z.ZodType | undefined = undefined, Q extends z.ZodType | undefined = undefined>(
    spec: RouteSpec<B, Q>,
    handler: Handler<Infer<B>, Infer<Q>>,
  ): void {
    this.specs.push(spec as RouteSpec<z.ZodType | undefined, z.ZodType | undefined>);
    this.app.on(spec.method.toUpperCase(), `${this.prefix}${spec.path}`, async (c) => {
      requireRole(c, spec.role);
      let body: unknown;
      if (spec.body) {
        let raw: unknown = {};
        const text = await c.req.text();
        if (text.trim()) {
          try {
            raw = JSON.parse(text);
          } catch {
            throw new EngineError(
              'BAD_REQUEST',
              'The request body is not valid JSON.',
              undefined,
              400,
            );
          }
        }
        body = parse(spec.body, raw, 'body');
      }
      const query = spec.query ? parse(spec.query, c.req.query(), 'query') : undefined;
      return handler(c, {
        body: body as Infer<B>,
        query: query as Infer<Q>,
        params: c.req.param() as Record<string, string>,
      });
    });
  }

  /** The OpenAPI 3.1 document for every declared route. */
  openapi(info: { title: string; version: string }) {
    const paths: Record<string, Record<string, unknown>> = {};
    for (const spec of this.specs) {
      const path = `${this.prefix}${spec.path}`.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
      const params = [...spec.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => ({
        name: m[1],
        in: 'path',
        required: true,
        schema: { type: 'string' },
      }));
      const query = spec.query ? queryParams(spec.query) : [];
      const op: Record<string, unknown> = {
        summary: spec.summary,
        tags: [spec.tag],
        operationId: `${spec.method}${path.replace(/[{}]/g, '').replace(/[^A-Za-z0-9]+(.)?/g, (_m, ch: string | undefined) => (ch ? ch.toUpperCase() : ''))}`,
        'x-role': spec.role,
        parameters: [...params, ...query],
        responses: {
          '200': { description: 'OK', content: { [spec.produces ?? 'application/json']: {} } },
          default: {
            description: 'Error envelope',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
        },
      };
      if (spec.body) {
        op.requestBody = {
          required: true,
          content: { 'application/json': { schema: jsonSchema(spec.body) } },
        };
      }
      paths[path] ??= {};
      (paths[path] as Record<string, unknown>)[spec.method] = op;
    }
    return {
      openapi: '3.1.0',
      info,
      servers: [{ url: '/' }],
      components: {
        securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
        schemas: {
          Error: {
            type: 'object',
            properties: {
              error: {
                type: 'object',
                properties: {
                  code: { type: 'string' },
                  message: { type: 'string' },
                  hint: { type: 'string' },
                  details: {},
                },
                required: ['code', 'message'],
              },
            },
          },
        },
      },
      security: [{ bearer: [] }],
      paths,
    };
  }
}

function parse(schema: z.ZodType, value: unknown, where: string): unknown {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new EngineError(
      'VALIDATION_FAILED',
      `Invalid request ${where}: ${result.error.issues.map((i) => `${i.path.join('.') || where}: ${i.message}`).join('; ')}`,
      'Check the request against GET /api/v1/openapi.json.',
      400,
      result.error.issues.map((i) => ({
        path: i.path.join('.'),
        code: i.code,
        message: i.message,
      })),
    );
  }
  return result.data;
}

function jsonSchema(schema: z.ZodType): unknown {
  try {
    const { $schema: _s, ...rest } = z.toJSONSchema(schema, {
      io: 'input',
      unrepresentable: 'any',
    }) as Record<string, unknown>;
    return rest;
  } catch {
    return {};
  }
}

function queryParams(schema: z.ZodType) {
  const json = jsonSchema(schema) as { properties?: Record<string, unknown>; required?: string[] };
  return Object.entries(json.properties ?? {}).map(([name, s]) => ({
    name,
    in: 'query',
    required: json.required?.includes(name) ?? false,
    schema: s,
  }));
}
