import { describe, expect, it } from 'vitest';
import { issuePath, rangeOf } from './yaml-range';

const TEXT = `title: Demo
nodes:
  - key: one
    title: One
    aims:
      - metric: x
  - key: two
    title: Two
`;

describe('issuePath', () => {
  it('parses dotted paths with indexes', () => {
    expect(issuePath('nodes[3].aims[0].metric')).toEqual(['nodes', 3, 'aims', 0, 'metric']);
    expect(issuePath('title')).toEqual(['title']);
  });
});

describe('rangeOf', () => {
  it('finds existing scalar values', () => {
    const r = rangeOf(TEXT, 'nodes[0].aims[0].metric');
    expect(TEXT.slice(r.from, r.to)).toBe('x');
  });

  it('marks the first line of the nearest parent for missing fields', () => {
    const r = rangeOf(TEXT, 'nodes[1].purpose');
    expect(TEXT.slice(r.from, r.to)).toBe('key: two');
  });

  it('falls back to the first line when nothing matches', () => {
    const r = rangeOf(TEXT, 'loops[4].from');
    expect(TEXT.slice(r.from, r.to)).toBe('title: Demo');
  });
});
