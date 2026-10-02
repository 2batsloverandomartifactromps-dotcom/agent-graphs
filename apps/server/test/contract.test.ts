/** docs/api.md ↔ implementation: every documented M2/E1 endpoint exists in the OpenAPI document. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeServer } from './helpers';

const doc = readFileSync(resolve(import.meta.dirname, '../../../docs/api.md'), 'utf8');

/** Later milestones, documented ahead of implementation. */
const DEFERRED = /\((M5|E2|E3)\)/;

function documentedEndpoints(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const line of doc.split('\n')) {
    if (!line.startsWith('| `') || DEFERRED.test(line)) continue;
    const cell = line.split('|')[1] ?? '';
    for (const code of cell.matchAll(/`([^`]+)`/g)) {
      const text = code[1] as string;
      const m = /^((?:GET|POST|PATCH|PUT|DELETE)(?:\|(?:GET|POST|PATCH|PUT|DELETE))*) (\/\S+)/.exec(
        text,
      );
      if (!m) continue;
      const methods = (m[1] as string).split('|');
      const base = (m[2] as string).split('?')[0] as string;
      // "… · `pause` · `resume`" shorthand: sibling actions on the same parent path.
      for (const method of methods) out.push([method, base]);
    }
    const siblings = [...cell.matchAll(/· `([a-z-]+)`/g)].map((s) => s[1] as string);
    const first = /`(POST|GET) (\/\S+)`/.exec(cell);
    if (first && siblings.length) {
      const parent = (first[2] as string).replace(/\/[^/]+$/, '');
      for (const s of siblings) out.push([first[1] as string, `${parent}/${s}`]);
    }
  }
  return out;
}

function toOpenApi(path: string): string {
  return `/api/v1${path}`.replace(/\{[^}]+\}/g, '{p}');
}

describe('API contract', () => {
  it('implements every documented endpoint', async () => {
    const s = makeServer();
    const res = await s.call<{ paths: Record<string, Record<string, unknown>> }>(
      'GET',
      '/openapi.json',
    );
    const implemented = new Set<string>();
    for (const [path, ops] of Object.entries(res.body.paths)) {
      for (const method of Object.keys(ops))
        implemented.add(`${method.toUpperCase()} ${path.replace(/\{[^}]+\}/g, '{p}')}`);
    }
    const missing = documentedEndpoints()
      .filter(([, path]) => path.startsWith('/'))
      .filter(
        ([, path]) =>
          !path.startsWith('/health') && !path.startsWith('/mcp') && !path.startsWith('/api/'),
      )
      .filter(([method, path]) => !implemented.has(`${method} ${toOpenApi(path)}`))
      .map(([method, path]) => `${method} ${path}`);
    expect(documentedEndpoints().length).toBeGreaterThan(70);
    expect(missing).toEqual([]);
  });
});
