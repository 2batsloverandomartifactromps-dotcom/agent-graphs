import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateSpecText } from '@agent-graphs/core';
import { describe, expect, it } from 'vitest';
import {
  adjacency,
  assignRanks,
  computeLayout,
  type LayoutInput,
  lineage,
  loopNesting,
  neighborInDirection,
  openingViewport,
  type Rect,
  structureHash,
} from './layout';
import { specToLayoutInput } from './preview';

function exampleInput(name: string): LayoutInput {
  const path = fileURLToPath(new URL(`../../../../examples/graphs/${name}`, import.meta.url));
  const result = validateSpecText(readFileSync(path, 'utf8'));
  if (!result.normalized) throw new Error(JSON.stringify(result.errors));
  return specToLayoutInput(result.normalized);
}

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const contains = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

describe('computeLayout', () => {
  const input = exampleInput('notes-app.yaml');
  const result = computeLayout(input);

  it('positions every node without overlaps', () => {
    expect(Object.keys(result.nodes).sort()).toEqual(input.nodes.map((n) => n.key).sort());
    const rects = Object.values(result.nodes);
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++)
        expect(overlaps(rects[i] as Rect, rects[j] as Rect)).toBe(false);
  });

  it('lays requires edges out left to right', () => {
    for (const e of input.edges.filter((x) => x.kind === 'requires')) {
      const a = result.nodes[e.from] as Rect;
      const b = result.nodes[e.to] as Rect;
      expect(a.x + a.width).toBeLessThanOrEqual(b.x);
    }
  });

  it('draws each loop region around its whole body', () => {
    for (const loop of input.loops) {
      const region = result.loops[loop.key] as Rect;
      expect(region).toBeDefined();
      for (const k of loop.body) expect(contains(region, result.nodes[k] as Rect)).toBe(true);
    }
  });

  it('keeps nodes outside a loop body out of its region', () => {
    for (const name of ['notes-app.yaml', 'nested-loops.yaml']) {
      const inp = exampleInput(name);
      const out = computeLayout(inp);
      for (const loop of inp.loops) {
        const region = out.loops[loop.key] as Rect;
        for (const n of inp.nodes) {
          if (loop.body.includes(n.key)) continue;
          expect(overlaps(region, out.nodes[n.key] as Rect), `${n.key} in ${loop.key}`).toBe(false);
        }
      }
    }
  });

  it('memoizes by structure only', () => {
    const shuffled: LayoutInput = {
      nodes: [...input.nodes].reverse(),
      edges: [...input.edges].reverse(),
      loops: input.loops,
    };
    expect(structureHash(shuffled)).toBe(result.hash);
    expect(computeLayout(shuffled)).toBe(result);
    const changed = { ...input, edges: input.edges.slice(1) };
    expect(structureHash(changed)).not.toBe(result.hash);
  });

  it('puts each node in the earliest column and keeps the main line on the top row', () => {
    const x = (k: string) => (result.nodes[k] as Rect).x;
    const y = (k: string) => (result.nodes[k] as Rect).y;
    // docs and security-audit only need plan-review, so they start right after it.
    expect(x('docs')).toBe(x('db-schema'));
    expect(x('security-audit')).toBe(x('db-schema'));
    expect(y('architecture')).toBe(y('requirements'));
    expect(y('plan-review')).toBe(y('requirements'));
    for (const r of Object.values(result.nodes))
      expect(r.y).toBeGreaterThanOrEqual(y('requirements'));
  });

  it('nests laminar loops', () => {
    const nested = exampleInput('nested-loops.yaml');
    const parents = loopNesting(nested.loops);
    const withParent = [...parents.entries()].filter(([, p]) => p);
    expect(withParent.length).toBeGreaterThan(0);
    const out = computeLayout(nested);
    for (const [child, parent] of withParent)
      expect(contains(out.loops[parent as string] as Rect, out.loops[child] as Rect)).toBe(true);
  });
});

describe('assignRanks', () => {
  it('uses the longest path and pulls sources next to their dependant', () => {
    const ranks = assignRanks(
      ['a', 'b', 'c', 'late'],
      [
        { from: 'a', to: 'b', informs: false },
        { from: 'b', to: 'c', informs: false },
        { from: 'late', to: 'c', informs: false },
      ],
    );
    expect(Object.fromEntries(ranks)).toEqual({ a: 0, b: 1, c: 2, late: 1 });
  });

  it('survives cycles', () => {
    const ranks = assignRanks(
      ['a', 'b'],
      [
        { from: 'a', to: 'b', informs: false },
        { from: 'b', to: 'a', informs: false },
      ],
    );
    expect(ranks.size).toBe(2);
  });
});

describe('openingViewport', () => {
  const pad = { top: 100, right: 20, bottom: 80, left: 20 };
  it('fits a small graph whole', () => {
    const vp = openingViewport({
      bounds: { x: 0, y: 0, width: 600, height: 300 },
      focus: [],
      width: 1000,
      height: 800,
      pad,
    });
    expect(vp.zoom).toBe(1);
    expect(vp.x).toBe(20 + (960 - 600) / 2);
  });

  it('opens a large graph at the reading zoom, anchored on the focus, selection in view', () => {
    const selected = { x: 3000, y: 2000, width: 232, height: 176 };
    const vp = openingViewport({
      bounds: { x: 0, y: 0, width: 4000, height: 3000 },
      focus: [{ x: 500, y: 200, width: 232, height: 176 }],
      selected,
      width: 1000,
      height: 800,
      pad,
    });
    expect(vp.zoom).toBe(0.85);
    const sx = selected.x * vp.zoom + vp.x;
    const sy = selected.y * vp.zoom + vp.y;
    expect(sx).toBeGreaterThanOrEqual(pad.left);
    expect(sx + selected.width * vp.zoom).toBeLessThanOrEqual(1000 - pad.right + 0.001);
    expect(sy + selected.height * vp.zoom).toBeLessThanOrEqual(800 - pad.bottom + 0.001);
  });
});

describe('traversal', () => {
  const edges = [
    { from: 'a', to: 'b', kind: 'requires' },
    { from: 'b', to: 'c', kind: 'requires' },
    { from: 'x', to: 'c', kind: 'requires' },
    { from: 'c', to: 'd', kind: 'requires' },
  ];
  const adj = adjacency(edges);

  it('computes lineage for focus mode', () => {
    expect([...lineage('b', adj)].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('moves between neighbors with arrow keys', () => {
    const rects: Record<string, Rect> = {
      a: { x: 0, y: 0, width: 10, height: 10 },
      b: { x: 50, y: 0, width: 10, height: 10 },
      x: { x: 50, y: 60, width: 10, height: 10 },
      c: { x: 100, y: 0, width: 10, height: 10 },
    };
    expect(neighborInDirection('a', 'right', rects, adj)).toBe('b');
    expect(neighborInDirection('c', 'left', rects, adj)).toBe('b');
    expect(neighborInDirection('b', 'down', rects, adj)).toBe('x');
  });
});
