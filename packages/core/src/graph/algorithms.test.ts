import { describe, expect, it } from 'vitest';
import {
  buildAdjacency,
  criticalPath,
  criticalPathWeights,
  descendants,
  didYouMean,
  findCycle,
  laminarViolations,
  loopBody,
  singleExitViolations,
  topoSort,
} from './algorithms';

const graph = (edges: string) =>
  buildAdjacency(
    [...new Set(edges.split(/[\s,>]+/).filter(Boolean))],
    edges
      .split(',')
      .map((e) => e.trim().split('>'))
      .filter((p) => p.length === 2)
      .map(([from, to]) => ({ from: from as string, to: to as string })),
  );

describe('graph algorithms', () => {
  it('finds cycles and reports the path', () => {
    expect(findCycle(graph('a>b, b>c'))).toBeNull();
    const cycle = findCycle(graph('a>b, b>c, c>a'));
    expect(cycle?.[0]).toBe(cycle?.[cycle.length - 1]);
    expect(cycle).toHaveLength(4);
  });

  it('sorts topologically', () => {
    const order = topoSort(graph('a>b, a>c, b>d, c>d'));
    expect(order[0]).toBe('a');
    expect(order[3]).toBe('d');
  });

  it('computes loop bodies (paths from entry to trigger)', () => {
    const g = graph('r>d, d>i, i>t, t>e, d>x');
    expect([...(loopBody('t', 'i', g) ?? [])].sort()).toEqual(['i', 't']);
    expect([...(loopBody('e', 'd', g) ?? [])].sort()).toEqual(['d', 'e', 'i', 't']);
    expect(loopBody('i', 't', g)).toBeNull();
  });

  it('detects single-exit violations', () => {
    const g = graph('a>b, b>c, a>z');
    const body = loopBody('b', 'a', g) as Set<string>;
    expect(singleExitViolations(body, 'b', g)).toEqual([['a', 'z']]);
  });

  it('detects partially overlapping bodies', () => {
    expect(
      laminarViolations([
        { key: 'x', body: new Set(['a', 'b']) },
        { key: 'y', body: new Set(['b', 'c']) },
        { key: 'z', body: new Set(['a', 'b', 'c']) },
      ]),
    ).toEqual([['x', 'y']]);
  });

  it('computes critical-path weights and path', () => {
    const g = graph('a>b, b>c, a>d');
    expect(criticalPathWeights(g).get('a')).toBe(3);
    expect(criticalPath(g)).toEqual(['a', 'b', 'c']);
    expect([...descendants('a', g)].sort()).toEqual(['b', 'c', 'd']);
  });

  it('suggests near matches', () => {
    expect(didYouMean('promt', ['prompt', 'purpose'])).toBe('prompt');
    expect(didYouMean('zzzzzz', ['prompt'])).toBeUndefined();
  });

  it('validates a 2000-node graph quickly', () => {
    const n = 2000;
    const edges = Array.from({ length: n - 1 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}` }));
    const start = performance.now();
    const g = buildAdjacency(
      Array.from({ length: n }, (_, i) => `n${i}`),
      edges,
    );
    expect(findCycle(g)).toBeNull();
    criticalPathWeights(g);
    expect(performance.now() - start).toBeLessThan(50);
  });
});
