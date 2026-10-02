/**
 * Structural sanity checks for the example specs until the real validator lands in M1
 * (node `core-spec` in docs/build-graph.yaml). Replace with full validation then.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { SPEC_SCHEMA } from '../src/vocabulary';

type RawNode = { key: string; needs?: unknown[]; informedBy?: unknown[] };
type RawLoop = { key: string; from: string; to: string };
type RawSpec = { schema: string; title: string; nodes: RawNode[]; loops?: RawLoop[] };

const repoRoot = resolve(import.meta.dirname, '../../..');
const specFiles = [
  ...readdirSync(join(repoRoot, 'examples/graphs'))
    .filter((file) => file.endsWith('.yaml'))
    .map((file) => join(repoRoot, 'examples/graphs', file)),
  join(repoRoot, 'docs/build-graph.yaml'),
];

const refKey = (ref: unknown): string =>
  typeof ref === 'string' ? ref : String((ref as { key: string }).key);

describe.each(specFiles)('%s', (file) => {
  const spec = parse(readFileSync(file, 'utf8')) as RawSpec;

  it('declares the schema marker and a title', () => {
    expect(spec.schema).toBe(SPEC_SCHEMA);
    expect(spec.title).toBeTruthy();
  });

  it('has unique node keys and only references known nodes', () => {
    const keys = spec.nodes.map((node) => node.key);
    expect(new Set(keys).size).toBe(keys.length);
    const known = new Set(keys);
    for (const node of spec.nodes) {
      for (const ref of [...(node.needs ?? []), ...(node.informedBy ?? [])]) {
        expect(known, `${node.key} → ${refKey(ref)}`).toContain(refKey(ref));
      }
    }
    for (const loop of spec.loops ?? []) {
      expect(known).toContain(loop.from);
      expect(known).toContain(loop.to);
    }
  });
});
