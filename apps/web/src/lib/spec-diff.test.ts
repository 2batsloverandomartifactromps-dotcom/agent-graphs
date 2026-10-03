import { describe, expect, it } from 'vitest';
import { diffSpecs, isEmptyBatch, parseSpecObject } from './spec-diff';

const BASE = `
schema: agent-graphs/v1
title: Demo
tags: [a]
aims:
  - key: done
    title: All done
nodes:
  - key: one
    title: One
    prompt: Do one
    aims: [Works]
  - key: two
    title: Two
    prompt: Do two
    needs:
      - key: one
    aims: [Works]
loops:
  - key: cycle
    from: two
    to: one
    maxIterations: 3
`;

describe('diffSpecs', () => {
  const before = parseSpecObject(BASE);

  it('finds nothing when the spec is unchanged', () => {
    const d = diffSpecs(before, parseSpecObject(BASE));
    expect(isEmptyBatch(d.batch)).toBe(true);
    expect(d.changes).toEqual([]);
  });

  it('turns a prompt edit into updateNodes', () => {
    const d = diffSpecs(before, parseSpecObject(BASE.replace('Do two', 'Do two, carefully')));
    expect(d.batch.updateNodes).toEqual([{ key: 'two', prompt: 'Do two, carefully' }]);
    expect(d.changes).toEqual(['~ node two: prompt']);
  });

  it('adds nodes and edges, removes edges, and updates loops', () => {
    const edited = parseSpecObject(
      BASE.replace('maxIterations: 3', 'maxIterations: 5')
        .replace('    needs:\n      - key: one\n', '    informedBy: [one]\n')
        .concat(
          '  - key: three\n    title: Three\n    prompt: Do three\n    needs: [two]\n    aims: [Works]\n',
        )
        .replace('loops:', 'XXX')
        .replace('  - key: three', '  - key: three')
        .replace('XXX', 'loops:'),
    );
    // move node three into the nodes list (appended after loops by the concat above)
    const nodes = edited.nodes as unknown[];
    const loops = edited.loops as Array<Record<string, unknown>>;
    const three = loops.pop();
    nodes.push(three);
    const d = diffSpecs(before, edited);
    expect(d.batch.addNodes?.map((n) => (n as { key: string }).key)).toEqual(['three']);
    expect(d.batch.removeEdges).toEqual([{ from: 'one', to: 'two', kind: 'requires' }]);
    expect(d.batch.addEdges).toEqual([{ from: 'one', to: 'two', kind: 'informs' }]);
    expect(d.batch.updateLoops).toEqual([{ key: 'cycle', maxIterations: 5 }]);
  });

  it('diffs graph fields and graph aims, warning on deletions', () => {
    const edited = parseSpecObject(
      BASE.replace('title: Demo', 'title: Demo v2')
        .replace('tags: [a]\n', '')
        .replace('title: All done', 'title: Everything done'),
    );
    const d = diffSpecs(before, edited);
    expect(d.batch.graph).toEqual({ title: 'Demo v2' });
    expect(d.batch.updateGraphAims).toEqual([{ key: 'done', title: 'Everything done' }]);
    expect(d.warnings[0]).toMatch(/tags/);
  });

  it('removes nodes without emitting edge removals for their edges', () => {
    const edited = parseSpecObject(BASE);
    edited.nodes = (edited.nodes as Array<{ key: string }>).filter((n) => n.key !== 'one');
    const d = diffSpecs(before, edited);
    expect(d.batch.removeNodes).toEqual(['one']);
    expect(d.batch.removeEdges).toBeUndefined();
  });
});
