import { describe, expect, it } from 'vitest';
import { toSpecInput } from './export';
import { deriveKey, parseCheck } from './normalize';
import { validateSpec, validateSpecText } from './validate';

type Spec = Record<string, unknown> & { nodes: Array<Record<string, unknown>> };

function base(): Spec {
  return {
    schema: 'agent-graphs/v1',
    title: 'Test',
    aims: [{ title: 'Shipped', evaluator: 'human' }],
    orchestrators: [
      { key: 'reviewer', name: 'Reviewer', capabilities: ['evaluate', 'approve', 'resolve'] },
    ],
    nodes: [
      {
        key: 'a',
        title: 'A',
        aim: 'Do A',
        purpose: 'Because',
        prompt: 'Do it',
        aims: ['A is done'],
      },
      {
        key: 'b',
        title: 'B',
        aim: 'Do B',
        purpose: 'Because',
        prompt: 'Do it',
        needs: ['a'],
        aims: [{ check: 'test_pass_rate >= 1' }],
      },
      {
        key: 'c',
        title: 'C',
        kind: 'gate',
        aim: 'Approve',
        purpose: 'Because',
        needs: ['b'],
        gate: { approver: 'human', instructions: 'Look' },
      },
    ],
  };
}

const codes = (spec: unknown) => validateSpec(spec).errors.map((e) => e.code);
const warnCodes = (spec: unknown) => validateSpec(spec).warnings.map((e) => e.code);

describe('validateSpec', () => {
  it('accepts the base spec without warnings', () => {
    const r = validateSpec(base());
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('reports unknown fields with a did-you-mean hint', () => {
    const s = base();
    (s.nodes[0] as Record<string, unknown>).promt = 'typo';
    const r = validateSpec(s);
    expect(r.errors[0]).toMatchObject({ path: 'nodes[0].promt', code: 'unknown_field' });
    expect(r.errors[0]?.hint).toContain("'prompt'");
  });

  it('reports missing required fields and a wrong schema marker', () => {
    expect(codes({ schema: 'agent-graphs/v1', nodes: [] })).toContain('required');
    expect(validateSpec({ ...base(), schema: 'v0' }).ok).toBe(false);
  });

  const cases: Array<[string, (s: Spec) => void, string]> = [
    ['duplicate node key', (s) => s.nodes.push({ ...s.nodes[0] }), 'duplicate_key'],
    [
      'unknown needs',
      (s) => Object.assign(s.nodes[1] as object, { needs: ['zz'] }),
      'unknown_reference',
    ],
    [
      'self dependency',
      (s) => Object.assign(s.nodes[0] as object, { needs: ['a'] }),
      'self_dependency',
    ],
    [
      'duplicate edge',
      (s) => Object.assign(s.nodes[1] as object, { needs: ['a', 'a'] }),
      'duplicate_edge',
    ],
    ['cycle', (s) => Object.assign(s.nodes[0] as object, { needs: ['c'] }), 'cycle'],
    ['task without prompt', (s) => delete s.nodes[0]?.prompt, 'required'],
    ['task without aim', (s) => delete s.nodes[0]?.aim, 'required'],
    [
      'task without terminating aim',
      (s) => Object.assign(s.nodes[0] as object, { aims: [{ title: 'x', terminating: false }] }),
      'no_terminating_aim',
    ],
    ['gate without approver', (s) => delete s.nodes[2]?.gate, 'required'],
    [
      'gate block on task',
      (s) => Object.assign(s.nodes[0] as object, { gate: { approver: 'human' } }),
      'gate_on_non_gate',
    ],
    [
      'graph aim judged by self',
      (s) => Object.assign(s, { aims: [{ title: 'x', evaluator: 'self' }] }),
      'invalid_graph_evaluator',
    ],
    [
      'quant aim missing target',
      (s) =>
        Object.assign(s.nodes[1] as object, {
          aims: [{ title: 't', metric: 'm', comparator: 'gte' }],
        }),
      'required',
    ],
    [
      'between without targetMax',
      (s) =>
        Object.assign(s.nodes[1] as object, {
          aims: [{ title: 't', metric: 'm', comparator: 'between', target: 1 }],
        }),
      'required',
    ],
    [
      'targetMax < target',
      (s) => Object.assign(s.nodes[1] as object, { aims: [{ check: 'm in [5, 1]' }] }),
      'invalid_range',
    ],
    [
      'bad check',
      (s) => Object.assign(s.nodes[1] as object, { aims: [{ check: 'coverage is high' }] }),
      'invalid_check',
    ],
    [
      'unknown derived metric',
      (s) =>
        Object.assign(s, {
          aims: [{ title: 't', metric: 'nope', comparator: 'gte', target: 1, source: 'derived' }],
        }),
      'unknown_derived_metric',
    ],
    [
      'unknown evaluatorKey',
      (s) =>
        Object.assign(s.nodes[0] as object, {
          aims: [{ title: 'q', evaluator: 'orchestrator', evaluatorKey: 'zz' }],
        }),
      'unknown_reference',
    ],
    [
      'evaluatorKey without capability',
      (s) => {
        (s.orchestrators as Array<Record<string, unknown>>).push({
          key: 'lead',
          name: 'Lead',
          capabilities: [],
        });
        Object.assign(s.nodes[0] as object, {
          aims: [{ title: 'q', evaluator: 'orchestrator', evaluatorKey: 'lead' }],
        });
      },
      'missing_capability',
    ],
    [
      'orchestrator evaluator but none can evaluate',
      (s) => {
        s.orchestrators = [];
        Object.assign(s.nodes[0] as object, { aims: [{ title: 'q', evaluator: 'orchestrator' }] });
      },
      'no_evaluator',
    ],
    [
      'orchestrator approver but none can approve',
      (s) => {
        s.orchestrators = [];
        Object.assign(s.nodes[2] as object, { gate: { approver: 'orchestrator' } });
      },
      'no_approver',
    ],
    [
      'maxAttempts out of range',
      (s) => Object.assign(s.nodes[0] as object, { maxAttempts: 30 }),
      'out_of_range',
    ],
    [
      'loop from == to',
      (s) => Object.assign(s, { loops: [{ key: 'l', from: 'a', to: 'a' }] }),
      'self_loop',
    ],
    [
      'loop unreachable',
      (s) => Object.assign(s, { loops: [{ key: 'l', from: 'a', to: 'b' }] }),
      'unreachable_trigger',
    ],
    [
      'loop unknown node',
      (s) => Object.assign(s, { loops: [{ key: 'l', from: 'zz', to: 'a' }] }),
      'unknown_reference',
    ],
    [
      'loop maxIterations',
      (s) => Object.assign(s, { loops: [{ key: 'l', from: 'b', to: 'a', maxIterations: 99 }] }),
      'out_of_range',
    ],
    [
      'loop skip policy',
      (s) => Object.assign(s, { loops: [{ key: 'l', from: 'b', to: 'a', onExhausted: 'skip' }] }),
      'invalid_loop_policy',
    ],
    [
      'two loops from one trigger',
      (s) =>
        Object.assign(s, {
          loops: [
            { key: 'l1', from: 'c', to: 'a' },
            { key: 'l2', from: 'c', to: 'b' },
          ],
        }),
      'multiple_loops',
    ],
    [
      'single exit',
      (s) => {
        s.nodes.push({
          key: 'd',
          title: 'D',
          aim: 'd',
          purpose: 'p',
          prompt: 'p',
          needs: ['a'],
          aims: ['x'],
        });
        Object.assign(s, { loops: [{ key: 'l', from: 'b', to: 'a' }] });
      },
      'single_exit',
    ],
    [
      'overlapping loops',
      (s) => {
        s.nodes.push({
          key: 'd',
          title: 'D',
          aim: 'd',
          purpose: 'p',
          prompt: 'p',
          needs: ['c'],
          aims: ['x'],
        });
        Object.assign(s, {
          loops: [
            { key: 'l1', from: 'b', to: 'a' },
            { key: 'l2', from: 'd', to: 'b' },
          ],
        });
      },
      'overlapping_loops',
    ],
    [
      'unknown scope node',
      (s) =>
        Object.assign(s, { orchestrators: [{ key: 'o', name: 'O', scope: { nodes: ['zz'] } }] }),
      'unknown_reference',
    ],
    [
      'protected evolution scope',
      (s) => Object.assign(s, { evolution: { mode: 'learn', scope: ['aims'] } }),
      'protected_scope',
    ],
    [
      'unknown evolution scope',
      (s) => Object.assign(s, { evolution: { mode: 'learn', scope: ['vibes'] } }),
      'unknown_scope',
    ],
    ['auto without suite', (s) => Object.assign(s, { evolution: { mode: 'auto' } }), 'required'],
    [
      'replay without suite',
      (s) =>
        Object.assign(s, {
          evolution: { mode: 'propose', validation: { ladder: ['structural', 'replay'] } },
        }),
      'required',
    ],
    [
      'orchestrator approval without resolve',
      (s) => {
        s.orchestrators = [{ key: 'r', name: 'R', capabilities: ['evaluate'] }];
        Object.assign(s, { evolution: { mode: 'propose', approval: 'orchestrator' } });
      },
      'no_approver',
    ],
    [
      'parent not a group',
      (s) => Object.assign(s.nodes[1] as object, { parent: 'a' }),
      'invalid_parent',
    ],
  ];

  it.each(cases)('rejects: %s', (_name, mutate, code) => {
    const s = base();
    mutate(s);
    expect(codes(s)).toContain(code);
  });

  const warningCases: Array<[string, (s: Spec) => void, string]> = [
    ['missing purpose', (s) => delete s.nodes[0]?.purpose, 'missing_purpose'],
    [
      'gate without instructions',
      (s) => Object.assign(s.nodes[2] as object, { gate: { approver: 'human' } }),
      'missing_instructions',
    ],
    ['default graph aim', (s) => delete s.aims, 'default_graph_aim'],
    [
      'unknown model',
      (s) => Object.assign(s.nodes[0] as object, { executor: { model: 'mystery-1' } }),
      'unknown_model',
    ],
    [
      'isolated node',
      (s) =>
        s.nodes.push({ key: 'z', title: 'Z', aim: 'z', purpose: 'p', prompt: 'p', aims: ['x'] }),
      'isolated_node',
    ],
    [
      'float equality',
      (s) => Object.assign(s.nodes[1] as object, { aims: [{ check: 'coverage == 0.8' }] }),
      'float_equality',
    ],
    [
      'unknown trigger event',
      (s) =>
        Object.assign(s, {
          orchestrators: [
            {
              key: 'o',
              name: 'O',
              capabilities: ['evaluate', 'approve'],
              triggers: ['node.submitted'],
            },
          ],
        }),
      'unknown_event_type',
    ],
    [
      'empty tag scope',
      (s) =>
        Object.assign(s, {
          orchestrators: [
            {
              key: 'o',
              name: 'O',
              capabilities: ['evaluate', 'approve'],
              scope: { tags: ['nope'] },
            },
          ],
        }),
      'empty_scope',
    ],
    [
      'informs leaving loop',
      (s) => {
        s.nodes.push({
          key: 'd',
          title: 'D',
          aim: 'd',
          purpose: 'p',
          prompt: 'p',
          needs: ['c'],
          informedBy: ['a'],
          aims: ['x'],
        });
        Object.assign(s, { loops: [{ key: 'l', from: 'b', to: 'a' }] });
      },
      'informs_leaves_loop',
    ],
    [
      'long prompt',
      (s) => Object.assign(s.nodes[0] as object, { prompt: 'x'.repeat(20_001) }),
      'long_prompt',
    ],
  ];

  it.each(warningCases)('warns: %s', (_name, mutate, code) => {
    const s = base();
    mutate(s);
    expect(warnCodes(s)).toContain(code);
  });

  it('suggests the closest node for unknown references', () => {
    const s = base();
    Object.assign(s.nodes[1] as object, { needs: ['aa'] });
    const err = validateSpec(s).errors.find((e) => e.code === 'unknown_reference');
    expect(err?.hint).toBe("Did you mean 'a'?");
  });

  it('reports the cycle path', () => {
    const s = base();
    Object.assign(s.nodes[0] as object, { needs: ['c'] });
    expect(validateSpec(s).errors.find((e) => e.code === 'cycle')?.message).toMatch(/→/);
  });

  it('reports YAML parse errors', () => {
    expect(validateSpecText('nodes: [').errors[0]?.code).toBe('parse_error');
  });
});

describe('normalization', () => {
  it('expands shorthands and applies defaults', () => {
    const r = validateSpec(base());
    const spec = r.normalized;
    expect(spec?.aims[0]).toMatchObject({ evaluator: 'human', kind: 'qualitative' });
    expect(spec?.nodes[0]?.aims[0]).toMatchObject({
      evaluator: 'self',
      key: 'a-is-done',
      terminating: true,
    });
    expect(spec?.nodes[1]?.aims[0]).toMatchObject({
      key: 'test-pass-rate-1',
      kind: 'quantitative',
      metric: 'test_pass_rate',
      comparator: 'gte',
      target: 1,
    });
    expect(spec?.policy).toMatchObject({
      maxAttempts: 3,
      leaseTtlSec: 1800,
      onExhausted: 'escalate',
    });
    expect(spec?.nodes[0]).toMatchObject({ maxAttempts: 3, priority: 'p2', aimMode: 'all' });
  });

  it('applies precedence node > defaults > policy and merges executor', () => {
    const s = base();
    Object.assign(s, {
      policy: { maxAttempts: 5, leaseTtl: '10m' },
      defaults: { maxAttempts: 4, executor: { provider: 'anthropic', model: 'claude-sonnet-5-5' } },
    });
    Object.assign(s.nodes[0] as object, { maxAttempts: 2, executor: { model: 'claude-opus-5-5' } });
    const spec = validateSpec(s).normalized;
    expect(spec?.nodes[0]?.maxAttempts).toBe(2);
    expect(spec?.nodes[1]?.maxAttempts).toBe(4);
    expect(spec?.nodes[1]?.leaseTtlSec).toBe(600);
    expect(spec?.nodes[0]?.executor).toEqual({ provider: 'anthropic', model: 'claude-opus-5-5' });
  });

  it('defaults the graph aim when none is given', () => {
    const s = base();
    delete s.aims;
    expect(validateSpec(s).normalized?.aims[0]).toMatchObject({
      metric: 'nodes_done_ratio',
      source: 'derived',
    });
  });

  it('round-trips through the canonical export', () => {
    const first = validateSpec(base());
    const again = validateSpec(
      toSpecInput(first.normalized as NonNullable<typeof first.normalized>),
    );
    expect(again.errors).toEqual([]);
    expect(again.normalized).toEqual(first.normalized);
  });

  it('parses check shorthands and derives keys', () => {
    expect(parseCheck('p95_ms < 200')).toEqual({ metric: 'p95_ms', comparator: 'lt', target: 200 });
    expect(parseCheck('bundle_kb in [100, 250]')).toEqual({
      metric: 'bundle_kb',
      comparator: 'between',
      target: 100,
      targetMax: 250,
    });
    expect(parseCheck('nonsense')).toBeNull();
    expect(deriveKey('Handlers follow docs/architecture.md layering!')).toBe(
      'handlers-follow-docs-architecture-md-layering',
    );
  });
});
