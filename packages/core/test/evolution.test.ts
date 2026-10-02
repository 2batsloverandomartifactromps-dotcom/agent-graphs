import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyOps, classifyOps, type EditOp } from '../src/evolution/dsl';
import { gateDecision, type RunMetrics, runMetrics } from '../src/evolution/gate';
import { type Lesson, rankLessons, shouldRetire } from '../src/evolution/lessons';
import { checkProposal, specDiff } from '../src/evolution/proposals';
import type { NormalizedSpec } from '../src/spec/normalize';
import { validateSpec } from '../src/spec/validate';
import { canonicalJson, chainGenesis, chainHash, sha256, verifyChain } from '../src/util/hash';
import { Harness, JUDGE, spec, task } from './harness';

function base(): NormalizedSpec {
  const result = validateSpec(
    spec(
      [
        task('design'),
        task('impl', ['design']),
        task('test', ['impl'], { checklist: ['run suite'] }),
      ],
      {
        loops: [{ key: 'fix', from: 'test', to: 'impl', maxIterations: 3 }],
        evolution: {
          mode: 'auto',
          scope: ['guidance', 'checklists', 'prompts'],
          validation: { ladder: ['structural', 'replay'], suite: 'notes-suite' },
        },
      },
    ),
  );
  if (!result.normalized) throw new Error(JSON.stringify(result.errors));
  return result.normalized;
}

const target = { type: 'graph' as const, id: 'gr_1' };

describe('hashing', () => {
  it('matches node:crypto sha256', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 300 }), (text) => {
        expect(sha256(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
      }),
      { numRuns: 300 },
    );
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('serializes canonically', () => {
    expect(canonicalJson({ b: 1, a: [true, null, { d: undefined, c: 'x' }] })).toBe(
      '{"a":[true,null,{"c":"x"}],"b":1}',
    );
  });

  it('verifies and detects tampering in a hash chain', () => {
    let prev = chainGenesis('gr_1');
    const events = [1, 2, 3].map((seq) => {
      const e = {
        id: `evt_${seq}`,
        seq,
        graphId: 'gr_1',
        type: 'node.status_changed',
        entityType: 'node',
        entityId: 'nd_1',
        actor: { kind: 'system' },
        payload: { seq },
        createdAt: seq,
      };
      const hash = chainHash(prev, e);
      const out = { ...e, prevHash: prev, hash };
      prev = hash;
      return out;
    });
    expect(verifyChain('gr_1', events)).toBe(-1);
    (events[1] as { payload: unknown }).payload = { seq: 99 };
    expect(verifyChain('gr_1', events)).toBe(1);
  });
});

describe('edit DSL', () => {
  it('patches a spec and re-validates it', () => {
    const result = applyOps(base(), [
      {
        op: 'set_edge_attributes',
        from: 'impl',
        to: 'test',
        guidance: 'Run the focused suite first',
      },
      {
        op: 'set_node_field',
        key: 'impl',
        field: 'prompt',
        delta: { append: 'Check token rotation.' },
      },
      {
        op: 'set_node_field',
        key: 'test',
        field: 'checklist',
        delta: { add: [{ title: 'Regenerate OpenAPI', required: true }] },
      },
    ]);
    expect(result.ok).toBe(true);
    const n = result.validation?.normalized?.nodes.find((x) => x.key === 'impl');
    expect(n?.prompt).toContain('Check token rotation.');
    const t = result.validation?.normalized?.nodes.find((x) => x.key === 'test');
    expect(t?.checklist.map((c) => c.title)).toEqual(['run suite', 'Regenerate OpenAPI']);
    expect(t?.needs[0]?.guidance).toBe('Run the focused suite first');
  });

  it('rejects edits that break validation', () => {
    const cycle = applyOps(base(), [
      { op: 'add_edge', from: 'test', to: 'design', kind: 'requires' },
    ]);
    expect(cycle.ok).toBe(false);
    expect(cycle.errors.map((e) => e.code)).toContain('cycle');
    const missing = applyOps(base(), [{ op: 'delete_node', key: 'nope' }]);
    expect(missing.errors[0]?.code).toBe('edit_failed');
    const malformed = applyOps(base(), [
      { op: 'set_node_field', key: 'impl', field: 'aims', delta: {} },
    ]);
    expect(malformed.errors[0]?.code).toBe('invalid_op');
  });

  it.each([
    [
      'add_node',
      [
        {
          op: 'add_node',
          node: {
            key: 'docs',
            title: 'Docs',
            aim: 'docs',
            purpose: 'p',
            prompt: 'write',
            needs: ['test'],
            aims: ['Docs exist'],
          },
        },
      ],
      true,
    ],
    ['delete_node', [{ op: 'delete_node', key: 'design' }], true],
    [
      'add_edge with attrs',
      [{ op: 'add_edge', from: 'design', to: 'test', kind: 'informs', guidance: 'read it' }],
      true,
    ],
    ['duplicate edge', [{ op: 'add_edge', from: 'design', to: 'impl' }], false],
    ['delete_edge', [{ op: 'delete_edge', from: 'design', to: 'impl' }], true],
    ['delete missing edge', [{ op: 'delete_edge', from: 'test', to: 'design' }], false],
    [
      'replace edge attrs',
      [
        {
          op: 'set_edge_attributes',
          from: 'design',
          to: 'impl',
          condition: 'approved',
          mode: 'replace',
        },
      ],
      true,
    ],
    [
      'attrs on missing edge',
      [{ op: 'set_edge_attributes', from: 'test', to: 'design', guidance: 'x' }],
      false,
    ],
    [
      'purpose replace',
      [
        {
          op: 'set_node_field',
          key: 'impl',
          field: 'purpose',
          delta: { replace: { from: 'test', to: 'testing' } },
        },
      ],
      true,
    ],
    [
      'replace missing text',
      [
        {
          op: 'set_node_field',
          key: 'impl',
          field: 'prompt',
          delta: { replace: { from: 'zzz', to: 'y' } },
        },
      ],
      false,
    ],
    [
      'checklist retire + reword',
      [
        {
          op: 'set_node_field',
          key: 'test',
          field: 'checklist',
          delta: { retire: ['run-suite'], add: ['Lint'], reword: [] },
        },
      ],
      true,
    ],
    [
      'reword missing item',
      [
        {
          op: 'set_node_field',
          key: 'test',
          field: 'checklist',
          delta: { reword: [{ key: 'nope', title: 'x' }] },
        },
      ],
      false,
    ],
    [
      'executor',
      [
        {
          op: 'set_node_field',
          key: 'impl',
          field: 'executor',
          delta: { model: 'claude-opus-5-5' },
        },
      ],
      true,
    ],
    [
      'add_loop',
      [{ op: 'add_loop', loop: { key: 'outer', from: 'test', to: 'design', maxIterations: 2 } }],
      false,
    ],
    ['duplicate loop', [{ op: 'add_loop', loop: { key: 'fix', from: 'test', to: 'impl' } }], false],
    ['set_loop', [{ op: 'set_loop', key: 'fix', maxIterations: 5 }], true],
    ['set missing loop', [{ op: 'set_loop', key: 'nope', maxIterations: 5 }], false],
    ['delete_loop', [{ op: 'delete_loop', key: 'fix' }], true],
    ['delete missing loop', [{ op: 'delete_loop', key: 'nope' }], false],
    ['duplicate node', [{ op: 'add_node', node: { key: 'impl', title: 'x' } }], false],
    [
      'lesson ops',
      [
        { op: 'add_lesson', lesson: { content: 'x' } },
        { op: 'retire_lesson', id: 'ls_1' },
      ],
      true,
    ],
  ])('%s', (_name, ops, ok) => {
    expect(applyOps(base(), ops).ok).toBe(ok);
  });

  it('classifies scope and protected fields', () => {
    const c = classifyOps([
      {
        op: 'set_edge_attributes',
        from: 'a',
        to: 'b',
        kind: 'requires',
        mode: 'append',
        guidance: 'x',
      },
      { op: 'delete_node', key: 'a' },
      { op: 'set_loop', key: 'fix', onExhausted: 'accept' },
    ] as EditOp[]);
    expect(c.classes).toEqual(['guidance', 'topology', 'topology']);
    expect(c.protected).toEqual(['aims', 'policy']);
    expect(c.riskClass).toBe('protected');
  });
});

describe('proposals', () => {
  it('hashes equivalent edit sets equally', () => {
    const a = checkProposal({
      target,
      base: base(),
      evolution: base().evolution,
      ops: [
        { op: 'set_node_field', key: 'impl', field: 'prompt', delta: { append: 'A.' } },
        { op: 'set_edge_attributes', from: 'impl', to: 'test', pitfalls: 'B' },
      ],
    });
    const b = checkProposal({
      target,
      base: base(),
      evolution: base().evolution,
      ops: [
        { op: 'set_edge_attributes', from: 'impl', to: 'test', pitfalls: 'B', mode: 'replace' },
        {
          op: 'set_node_field',
          key: 'impl',
          field: 'prompt',
          delta: { set: `${base().nodes[1]?.prompt?.trimEnd()}\nA.` },
        },
      ],
    });
    expect(a.status).toBe('ok');
    expect(b.status).toBe('ok');
    if (a.status === 'ok' && b.status === 'ok') expect(a.canonicalHash).toBe(b.canonicalHash);
  });

  it('refuses re-proposals from the rejection memory', () => {
    const ops = [{ op: 'set_node_field', key: 'impl', field: 'priority', delta: { set: 'p0' } }];
    const first = checkProposal({ target, base: base(), evolution: base().evolution, ops });
    if (first.status !== 'ok') throw new Error('expected ok');
    const again = checkProposal({
      target,
      base: base(),
      evolution: base().evolution,
      ops,
      rejectedHashes: [first.canonicalHash],
    });
    expect(again.status).toBe('refused');
  });

  it('requires approval for protected or out-of-scope edits, and allows in-scope auto edits', () => {
    const inScope = checkProposal({
      target,
      base: base(),
      evolution: base().evolution,
      ops: [{ op: 'set_edge_attributes', from: 'impl', to: 'test', guidance: 'g' }],
    });
    expect(inScope.status === 'ok' && inScope.requiresApproval).toBe(false);
    const topology = checkProposal({
      target,
      base: base(),
      evolution: base().evolution,
      ops: [{ op: 'set_node_field', key: 'impl', field: 'maxAttempts', delta: { set: 5 } }],
    });
    expect(topology.status === 'ok' && topology.outOfScope).toEqual(['topology']);
    expect(topology.status === 'ok' && topology.requiresApproval).toBe(true);
    const tooMany = checkProposal({
      target,
      base: base(),
      evolution: base().evolution,
      ops: Array.from({ length: 6 }, () => ({
        op: 'set_edge_attributes',
        from: 'impl',
        to: 'test',
        guidance: 'g',
      })),
    });
    expect(tooMany.status).toBe('invalid');
  });

  it('reports no changes for a no-op edit', () => {
    expect(specDiff(base(), base())).toEqual([]);
  });
});

describe('gate', () => {
  const run = (over: Partial<RunMetrics> = {}): RunMetrics => ({
    success: 1,
    firstPassYield: 0.6,
    loopIterationsPerEntry: 1.5,
    humanInterventions: 1,
    costUsd: 10,
    wallTimeHours: 2,
    openFindingsHigh: 0,
    ...over,
  });
  const weights = base().evolution.objective;

  it('accepts ties and improvements; rejects regressions', () => {
    const five = (o: Partial<RunMetrics> = {}) => Array.from({ length: 5 }, () => run(o));
    expect(gateDecision({ candidate: five(), incumbent: five(), weights, minRuns: 5 }).accept).toBe(
      true,
    );
    expect(
      gateDecision({
        candidate: five({ firstPassYield: 0.8 }),
        incumbent: five(),
        weights,
        minRuns: 5,
      }).accept,
    ).toBe(true);
    const worse = gateDecision({
      candidate: five({ firstPassYield: 0.3 }),
      incumbent: five(),
      weights,
      minRuns: 5,
    });
    expect(worse.accept).toBe(false);
    expect(worse.reasons[0]).toMatch(/score/);
  });

  it('enforces constraints and sample minimums', () => {
    const few = gateDecision({
      candidate: [run()],
      incumbent: [run(), run()],
      weights,
      minRuns: 2,
    });
    expect(few.reasons).toContain('candidate has 1 runs; 2 required');
    const pricey = gateDecision({
      candidate: [run({ costUsd: 20, firstPassYield: 1 })],
      incumbent: [run()],
      weights,
      minRuns: 1,
    });
    expect(pricey.accept).toBe(false);
    expect(pricey.reasons.some((r) => r.startsWith('cost regressed'))).toBe(true);
  });

  it('computes run metrics from a graph', () => {
    const h = new Harness(spec([task('a'), task('b', ['a'])], { evolution: { mode: 'learn' } }));
    h.failAim('a');
    h.pass('a');
    h.pass('b');
    const m = runMetrics(h.state, h.ctx.now);
    expect(m.success).toBe(1);
    expect(m.firstPassYield).toBe(0.5);
    expect(h.state.lessonDuties.size).toBe(1);
  });
});

describe('lessons', () => {
  const lesson = (
    id: string,
    scope: Lesson['scope'],
    counters = { applied: 0, helpful: 0, harmful: 0 },
  ): Lesson => ({
    id,
    scope,
    kind: 'guidance',
    content: id,
    evidence: { failedAttempts: [], passedAttempts: [] },
    source: 'worker',
    counters,
    status: 'active',
    version: 1,
    author: JUDGE,
    createdAt: 0,
    updatedAt: 0,
  });
  const ctx = {
    graphId: 'gr_1',
    nodeKey: 'impl',
    nodeKind: 'task' as const,
    tags: ['backend'],
    edges: [['design', 'impl']] as Array<[string, string]>,
  };

  it('ranks by scope match, then helpfulness', () => {
    const ranked = rankLessons(
      [
        lesson('global', 'global'),
        lesson('tag', { tags: ['backend'] }),
        lesson('node', { nodeKey: 'impl' }),
        lesson('edge', { edge: ['design', 'impl'] }),
        lesson('other', { nodeKey: 'deploy' }),
        lesson('node-helpful', { nodeKey: 'impl' }, { applied: 4, helpful: 4, harmful: 0 }),
      ],
      ctx,
    ).map((l) => l.id);
    expect(ranked).toEqual(['edge', 'node-helpful', 'node', 'tag', 'global']);
  });

  it('flags harmful lessons for retirement', () => {
    expect(shouldRetire(lesson('x', 'global', { applied: 5, helpful: 1, harmful: 3 }))).toBe(true);
    expect(shouldRetire(lesson('x', 'global', { applied: 4, helpful: 0, harmful: 3 }))).toBe(false);
  });
});
