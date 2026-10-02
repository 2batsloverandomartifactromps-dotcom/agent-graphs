import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as E from '../src/engine/index';
import { validateSpecText } from '../src/spec/validate';
import { canonicalJson } from '../src/util/hash';
import { codeOf, Harness, spec, task } from './harness';

const root = resolve(import.meta.dirname, '../../..');
const specs = [
  ...readdirSync(resolve(root, 'examples/graphs')).map((f) => resolve(root, 'examples/graphs', f)),
  resolve(root, 'docs/build-graph.yaml'),
];

describe('stateToSpec', () => {
  it.each(specs.map((p) => [p.split('/').slice(-2).join('/'), p]))(
    'round-trips %s',
    (_name, path) => {
      const result = validateSpecText(readFileSync(path, 'utf8'));
      const normalized = result.normalized as NonNullable<typeof result.normalized>;
      const state = E.buildGraph(normalized, new E.Tx(E.testCtx()));
      expect(canonicalJson(E.stateToSpec(state))).toBe(canonicalJson(normalized));
    },
  );
});

describe('mutations', () => {
  const admin = { admin: true };
  const orch = { admin: false };

  it('adds nodes and edges; new work becomes ready', () => {
    const h = new Harness(spec([task('a')]));
    h.pass('a');
    expect(h.state.graph.status).toBe('completed');
    h.run((s, t) => E.reopenGraph(s, t));
    const out = h.run((s, t) => E.applyMutations(s, t, { addNodes: [task('b', ['a'])] }, orch));
    expect(out.revision).toBe(2);
    expect(out.changes).toEqual(expect.arrayContaining(['added node b']));
    expect(h.status('b')).toBe('ready');
    expect(h.types()).toContain('graph.revised');
  });

  it('enforces the mutations policy', () => {
    const locked = new Harness(spec([task('a')], { policy: { mutations: 'locked' } }));
    expect(
      codeOf(() => locked.run((s, t) => E.applyMutations(s, t, { addNodes: [task('b')] }, orch))),
    ).toBe('POLICY_DENIED');
    const append = new Harness(spec([task('a'), task('b')]));
    expect(
      codeOf(() =>
        append.run((s, t) =>
          E.applyMutations(s, t, { updateNodes: [{ key: 'b', prompt: 'x' }] }, orch),
        ),
      ),
    ).toBe('POLICY_DENIED');
    const open = new Harness(spec([task('a'), task('b')], { policy: { mutations: 'open' } }));
    open.run((s, t) =>
      E.applyMutations(s, t, { updateNodes: [{ key: 'b', prompt: 'New prompt' }] }, orch),
    );
    expect(open.node('b').prompt).toBe('New prompt');
    expect(
      codeOf(() =>
        open.run((s, t) =>
          E.applyMutations(s, t, { addGraphAims: [{ key: 'x', title: 'X' }] }, orch),
        ),
      ),
    ).toBe('POLICY_DENIED');
  });

  it('refuses prerequisites on started nodes and removal of started nodes', () => {
    const h = new Harness(spec([task('a'), task('b')]));
    h.claim('b');
    expect(
      codeOf(() =>
        h.run((s, t) => E.applyMutations(s, t, { addEdges: [{ from: 'a', to: 'b' }] }, admin)),
      ),
    ).toBe('INVALID_TRANSITION');
    expect(
      codeOf(() => h.run((s, t) => E.applyMutations(s, t, { removeNodes: ['b'] }, admin))),
    ).toBe('INVALID_TRANSITION');
  });

  it('pushes a ready node back to pending when it gains a prerequisite', () => {
    const h = new Harness(spec([task('a'), task('b')]));
    h.run((s, t) =>
      E.applyMutations(
        s,
        t,
        { addEdges: [{ from: 'a', to: 'b', guidance: 'use the API' }] },
        admin,
      ),
    );
    expect(h.status('b')).toBe('pending');
    h.pass('a');
    expect(h.status('b')).toBe('ready');
  });

  it('rejects invalid batches without applying anything', () => {
    const h = new Harness(spec([task('a'), task('b', ['a'])]));
    const before = canonicalJson(E.stateToSpec(h.state));
    let error: unknown;
    try {
      h.run((s, t) => E.applyMutations(s, t, { addEdges: [{ from: 'b', to: 'a' }] }, admin));
    } catch (e) {
      error = e;
    }
    expect((error as E.EngineError).code).toBe('VALIDATION_FAILED');
    expect(((error as E.EngineError).details as Array<{ code: string }>)[0]?.code).toBe('cycle');
    expect(canonicalJson(E.stateToSpec(h.state))).toBe(before);
  });

  it('updates aims and edge attributes with diffs, removes unstarted nodes', () => {
    const h = new Harness(spec([task('a'), task('b', ['a']), task('c')]));
    const out = h.run((s, t) =>
      E.applyMutations(
        s,
        t,
        {
          updateNodes: [
            {
              key: 'a',
              aims: [{ key: 'ok', title: 'a works', evaluator: 'self' }, { check: 'cov >= 0.8' }],
            },
          ],
          updateEdges: [{ from: 'a', to: 'b', pitfalls: 'mind the schema' }],
          removeNodes: ['c'],
          addLoops: [{ key: 'fix', from: 'b', to: 'a', maxIterations: 2 }],
        },
        admin,
      ),
    );
    expect(out.changes).toEqual(
      expect.arrayContaining(
        ['added aim a.cov-0-8', 'updated edge', 'removed node c', 'added loop fix'].map((c) =>
          c === 'updated edge' ? expect.stringMatching(/^updated edge/) : c,
        ),
      ),
    );
    expect(h.state.loops[0]?.body).toHaveLength(2);
    expect(h.state.edges[0]?.pitfalls).toBe('mind the schema');
    expect(h.types()).toContain('edge.attributes_updated');
  });

  it('syncs graph fields, graph aims, loops, and orchestrators', () => {
    const h = new Harness(
      spec([task('a'), task('b', ['a'])], {
        loops: [{ key: 'fix', from: 'b', to: 'a', maxIterations: 2 }],
        orchestrators: [
          { key: 'lead', name: 'Lead', capabilities: ['dispatch'], aims: ['Keeps things moving'] },
        ],
        aims: [
          {
            key: 'done',
            check: 'nodes_done_ratio >= 1',
            source: 'derived',
            evaluator: 'orchestrator',
          },
        ],
      }),
    );
    const out = h.run((s, t) =>
      E.applyMutations(
        s,
        t,
        {
          graph: { title: 'Renamed', constraints: ['Be kind'] },
          updateGraphAims: [{ key: 'done', target: 0.9 }],
          addGraphAims: [
            { key: 'cheap', check: 'cost_usd <= 10', source: 'derived', evaluator: 'orchestrator' },
          ],
          updateLoops: [{ key: 'fix', maxIterations: 4 }],
          updateOrchestrators: [{ key: 'lead', name: 'Lead agent', aims: [] }],
          addOrchestrators: [
            { key: 'reviewer', name: 'Reviewer', capabilities: ['evaluate'], aims: ['Fair'] },
          ],
        },
        admin,
      ),
    );
    expect(h.state.graph.title).toBe('Renamed');
    expect(E.graphAims(h.state).map((a) => [a.key, a.target])).toEqual([
      ['done', 0.9],
      ['cheap', 10],
    ]);
    expect(h.state.loops[0]?.maxIterations).toBe(4);
    expect(out.changes).toEqual(
      expect.arrayContaining([
        'updated graph title, constraints',
        'updated loop fix',
        'updated orchestrator lead',
        'added orchestrator reviewer',
        'removed aim lead.keeps-things-moving',
      ]),
    );
    h.run((s, t) =>
      E.applyMutations(
        s,
        t,
        {
          removeLoops: ['fix'],
          removeOrchestrators: ['reviewer'],
          removeGraphAims: ['cheap'],
          removeEdges: [{ from: 'a', to: 'b' }],
        },
        admin,
      ),
    );
    expect(h.state.loops).toHaveLength(0);
    expect([...h.state.orchestrators.values()].map((o) => o.key)).toEqual(['lead']);
    expect(h.state.edges).toHaveLength(0);
    expect(h.types()).toEqual(
      expect.arrayContaining([
        'loop.removed',
        'orchestrator.removed',
        'aim.removed',
        'edge.removed',
      ]),
    );
  });

  it('sends a change directive when a running node is updated', () => {
    const h = new Harness(spec([task('a')]));
    const at = h.claim('a');
    h.run((s, t) =>
      E.applyMutations(s, t, { updateNodes: [{ key: 'a', prompt: 'Changed' }] }, admin),
    );
    expect(h.heartbeatFor(at).briefingChanged).toBe(true);
    expect(
      codeOf(() =>
        h.run((s, t) =>
          E.applyMutations(s, t, { updateNodes: [{ key: 'zz', prompt: 'x' }] }, admin),
        ),
      ),
    ).toBe('NOT_FOUND');
    expect(
      codeOf(() =>
        h.run((s, t) =>
          E.applyMutations(s, t, { updateNodes: [{ key: 'a', kind: 'milestone' }] }, admin),
        ),
      ),
    ).toBe('INVALID_TRANSITION');
  });
});
