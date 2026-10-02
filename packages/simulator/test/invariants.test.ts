import type { AgentGraphsClient } from '@agent-graphs/sdk';
import { describe, expect, it } from 'vitest';
import { checkInvariants, satisfying, violating } from '../src/index';

/** A stub client serving a deliberately corrupted graph. */
function corrupted(): AgentGraphsClient {
  const nodes = [
    { id: 'n1', key: 'a', status: 'pending' },
    { id: 'n2', key: 'b', status: 'running' },
  ];
  const detail = (key: string) => ({
    key,
    kind: 'task',
    status: key === 'a' ? 'done' : 'running',
    aimMode: 'all',
    acceptedWithDeviation: false,
    manual: false,
    countedAttempts: key === 'a' ? 5 : 0,
    maxAttempts: 3,
    aims: [{ key: 'tests', terminating: true, status: 'unmet' }],
    attempts:
      key === 'b'
        ? [
            { id: 'at1', status: 'running', sessionId: 's1' },
            { id: 'at2', status: 'submitted', sessionId: 's1' },
          ]
        : [{ id: 'at3', status: 'passed', sessionId: 's9' }],
    evaluations:
      key === 'b'
        ? [{ attemptId: 'at2', evaluatorKind: 'agent', actor: { kind: 'agent', sessionId: 's1' } }]
        : [],
    needs: key === 'b' ? [{ kind: 'requires', fromNodeId: 'n1', toNodeId: 'n2' }] : [],
  });
  return {
    getGraph: async () => ({
      graph: {
        status: 'completed',
        policy: { skippedSatisfiesDeps: true, evaluation: { independent: true } },
      },
      nodes,
      edges: [{ id: 'e1', kind: 'requires', fromNodeId: 'n1', toNodeId: 'n2' }],
      loops: [{ key: 'l', iteration: 5, maxIterations: 3, grantedIterations: 1 }],
    }),
    getNode: async (_g: string, key: string) => detail(key),
    events: async () => ({
      items: [{ seq: 1, type: 'graph.created', actor: {} }],
      nextCursor: null,
    }),
    verifyAudit: async () => ({ ok: false, events: 1, firstMismatch: 1 }),
  } as unknown as AgentGraphsClient;
}

describe('invariant checks', () => {
  it('detect every class of violation', async () => {
    const problems = (await checkInvariants(corrupted(), 'g')).join('\n');
    expect(problems).toContain('b: 2 open attempts');
    expect(problems).toContain('b is running but prerequisite a is pending');
    expect(problems).toContain('a: 5 counted attempts > 3');
    expect(problems).toContain('a is done but its terminating aims are not satisfied');
    expect(problems).toContain("verdict on at2 from the executor's own session");
    expect(problems).toContain('loop l: iteration 5 > 4');
    expect(problems).toContain('graph completed with nodes a:pending, b:running');
    expect(problems).toContain('event 1 (graph.created) has no actor');
    expect(problems).toContain('audit chain broken at seq 1');
  });
});

describe('simulated metric values', () => {
  const cases = [
    ['gte', 1, undefined],
    ['gt', 0.8, undefined],
    ['lte', 200, undefined],
    ['lt', 40, undefined],
    ['eq', 0, undefined],
    ['neq', 3, undefined],
    ['between', 100, 250],
  ] as const;
  const holds = (c: string, v: number, t: number, max?: number) =>
    c === 'gte'
      ? v >= t
      : c === 'gt'
        ? v > t
        : c === 'lte'
          ? v <= t
          : c === 'lt'
            ? v < t
            : c === 'eq'
              ? Math.abs(v - t) <= 1e-9
              : c === 'neq'
                ? Math.abs(v - t) > 1e-9
                : v >= t && v <= (max as number);
  for (const [comparator, target, targetMax] of cases) {
    it(`${comparator} ${target}`, () => {
      const aim = { comparator, target, ...(targetMax ? { targetMax } : {}) };
      expect(holds(comparator, satisfying(aim), target, targetMax)).toBe(true);
      expect(holds(comparator, violating(aim), target, targetMax)).toBe(false);
    });
  }
});
