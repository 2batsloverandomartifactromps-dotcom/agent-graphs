/** Table tests for the request option catalog (concepts §11.1) and remaining engine branches. */
import { describe, expect, it } from 'vitest';
import * as E from '../src/engine/index';
import { codeOf, gate, Harness, JUDGE, spec, task, WORKER } from './harness';

const MIN = 60_000;

function exhausted(policy = 'escalate', extra: Record<string, unknown> = {}) {
  const h = new Harness(
    spec([task('a', [], { maxAttempts: 1, onExhausted: policy, ...extra }), task('b', ['a'])]),
  );
  h.failAim('a');
  return h;
}

function loopExhausted() {
  const h = new Harness(
    spec([task('impl'), task('test', ['impl'])], {
      loops: [{ key: 'fix', from: 'test', to: 'impl', maxIterations: 1 }],
    }),
  );
  h.pass('impl');
  h.failAim('test');
  return h;
}

describe('aims math', () => {
  it.each([
    ['gte', 1, 1, true],
    ['gt', 1, 1, false],
    ['lte', 0.5, 1, true],
    ['lt', 1, 1, false],
    ['eq', 0.1 + 0.2, 0.3, true],
    ['neq', 1, 1, false],
  ] as const)('%s(%d, %d) = %s', (cmp, v, t, expected) => {
    expect(E.compare(cmp, v, t)).toBe(expected);
  });

  it('handles between and aggregations', () => {
    expect(E.compare('between', 150, 100, 200)).toBe(true);
    expect(E.compare('between', 250, 100, 200)).toBe(false);
    const xs = [3, 1, 2];
    expect(E.aggregate(xs, 'latest')).toBe(2);
    expect(E.aggregate(xs, 'min')).toBe(1);
    expect(E.aggregate(xs, 'max')).toBe(3);
    expect(E.aggregate(xs, 'avg')).toBe(2);
    expect(E.aggregate(xs, 'sum')).toBe(6);
    expect(E.aggregate([], 'sum')).toBeUndefined();
  });

  it('computes derived metrics', () => {
    const h = new Harness(spec([task('a'), task('b')]));
    h.submit(h.claim('a'), {
      usage: {
        costUsd: 2,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 1,
        cacheWriteTokens: 1,
      },
    });
    h.advance(90 * MIN);
    expect(E.derivedMetric(h.state, 'nodes_done_ratio')).toBe(0.5);
    expect(E.derivedMetric(h.state, 'cost_usd')).toBe(2);
    expect(E.derivedMetric(h.state, 'tokens_total')).toBe(17);
    expect(E.derivedMetric(h.state, 'failed_attempts')).toBe(0);
    expect(E.derivedMetric(h.state, 'open_findings_high')).toBe(0);
    expect(E.derivedMetric(h.state, 'children_done_ratio')).toBeUndefined();
    expect(E.derivedMetric(h.state, 'unknown')).toBeUndefined();
    expect(
      E.describeTarget({ metric: 'x', comparator: 'between', target: 1, targetMax: 2 } as E.Aim),
    ).toBe('x in [1, 2]');
  });

  it('aggregates attempt metric series', () => {
    const h = new Harness(
      spec([
        task('a', [], {
          aims: [{ metric: 'p95_ms', comparator: 'lt', target: 200, aggregation: 'max' }],
        }),
      ]),
    );
    const at = h.claim('a');
    h.run(
      (s, t) =>
        E.reportMetrics(s, t, { attemptId: at.id, metrics: [{ name: 'p95_ms', value: 150 }] }),
      WORKER,
    );
    h.advance(1000);
    h.run(
      (s, t) =>
        E.reportMetrics(s, t, { attemptId: at.id, metrics: [{ name: 'p95_ms', value: 250 }] }),
      WORKER,
    );
    h.advance(1000);
    expect(
      h.submit(at, { evaluations: [], metrics: [{ name: 'p95_ms', value: 120 }] }).outcome,
    ).toBe('failed');
    expect(
      codeOf(() =>
        h.run((s, t) => E.reportMetrics(s, t, { metrics: [{ name: 'x', value: Number.NaN }] })),
      ),
    ).toBe('BAD_REQUEST');
  });
});

describe('exhaustion escalation options', () => {
  it.each([
    ['accept', { justification: 'good enough' }, 'done'],
    ['skip', { reason: 'not needed' }, 'skipped'],
    ['fail', { reason: 'impossible' }, 'failed'],
  ])('%s → %s', (choice, data, status) => {
    const h = exhausted();
    h.resolve(h.openRequests('exhaustion')[0] as E.HumanRequest, choice, { data });
    expect(h.status('a')).toBe(status);
  });

  it('edit_retry patches the node and grants an attempt', () => {
    const h = exhausted();
    h.resolve(h.openRequests('exhaustion')[0] as E.HumanRequest, 'edit_retry', {
      data: { patch: { prompt: 'Try X' } },
    });
    expect(h.node('a').prompt).toBe('Try X');
    expect(h.status('a')).toBe('ready');
    expect(codeOf(() => h.run((s, t) => E.patchNode(s, t, h.node('a'), { bogus: 1 })))).toBe(
      'BAD_REQUEST',
    );
  });

  it('validates resolution input', () => {
    const h = exhausted();
    const r = h.openRequests('exhaustion')[0] as E.HumanRequest;
    expect(codeOf(() => h.resolve(r, 'nope'))).toBe('BAD_REQUEST');
    expect(codeOf(() => h.resolve(r, 'retry', { data: {} }))).toBe('BAD_REQUEST');
    expect(codeOf(() => h.resolve(r, 'skip', { data: {} }))).toBe('BAD_REQUEST');
    h.resolve(r, 'skip', { comment: 'fine' });
    expect(codeOf(() => h.resolve(r, 'skip', { comment: 'again' }))).toBe('INVALID_TRANSITION');
    expect(
      codeOf(() => h.run((s, t) => E.resolveRequest(s, t, 'rq_missing', { choice: 'x' }))),
    ).toBe('NOT_FOUND');
  });
});

describe('loop escalation options', () => {
  it('accept completes the trigger with deviation', () => {
    const h = loopExhausted();
    h.resolve(h.openRequests('loop')[0] as E.HumanRequest, 'accept', { comment: 'ship it' });
    expect(h.node('test')).toMatchObject({ status: 'done', acceptedWithDeviation: true });
  });

  it('fail fails the trigger', () => {
    const h = loopExhausted();
    h.resolve(h.openRequests('loop')[0] as E.HumanRequest, 'fail', { comment: 'give up' });
    expect(h.status('test')).toBe('failed');
  });

  it('edit_retry patches the entry and fires again', () => {
    const h = loopExhausted();
    h.resolve(h.openRequests('loop')[0] as E.HumanRequest, 'edit_retry', {
      data: { patch: { prompt: 'New approach' } },
    });
    expect(h.node('impl')).toMatchObject({
      prompt: 'New approach',
      status: 'ready',
      activation: 2,
    });
    expect(E.loopByKey(h.state, 'fix').iteration).toBe(2);
    expect(codeOf(() => h.run((s, t) => E.extendLoop(s, t, 'fix', 0)))).toBe('BAD_REQUEST');
  });

  it.each([
    ['fail', 'failed'],
    ['accept', 'done'],
  ])('loop onExhausted %s', (policy, status) => {
    const h = new Harness(
      spec([task('impl'), task('test', ['impl'])], {
        loops: [{ key: 'fix', from: 'test', to: 'impl', maxIterations: 1, onExhausted: policy }],
      }),
    );
    h.pass('impl');
    h.failAim('test');
    expect(h.status('test')).toBe(status);
  });
});

describe('other request subjects', () => {
  it('answers questions with a directive', () => {
    const h = new Harness(spec([task('a')]));
    const at = h.claim('a');
    const r = h.run((s, t) =>
      E.openRequest(s, t, {
        kind: 'question',
        subject: 'question',
        title: 'Which DB?',
        nodeId: at.nodeId,
        attemptId: at.id,
        blocking: false,
      }),
    );
    h.resolve(r, 'answer', { data: { text: 'SQLite' } });
    const d = [...h.state.directives.values()].find((x) => x.kind === 'answer');
    expect(d).toMatchObject({ targetType: 'attempt', targetId: at.id, body: 'SQLite' });
  });

  it.each([
    ['skip', 'skipped'],
    ['fail', 'failed'],
  ])('blocker %s → %s', (choice, status) => {
    const h = new Harness(spec([task('a'), task('b')]));
    const at = h.claim('a');
    h.run(
      (s, t) =>
        E.blockAttempt(s, t, { attemptId: at.id, reason: 'x', request: { title: 'Need access' } }),
      WORKER,
    );
    h.resolve(h.openRequests('blocker')[0] as E.HumanRequest, choice, { data: { reason: 'r' } });
    expect(h.status('a')).toBe(status);
  });

  it('handles timeouts: escalate, extend, fail_attempt, ignore', () => {
    const h = new Harness(spec([task('a', [], { timeout: '10m', leaseTtl: '2h' })]));
    const at = h.claim('a');
    h.advance(11 * MIN);
    h.run((s, t) => E.sweep(s, t));
    const r1 = h.openRequests('timeout')[0] as E.HumanRequest;
    expect(r1.blocking).toBe(false);
    h.resolve(r1, 'extend', { data: { duration: '30m' } });
    expect(h.node('a').timeoutSec).toBe(40 * 60);
    h.advance(30 * MIN);
    h.run((s, t) => E.sweep(s, t));
    h.resolve(h.openRequests('timeout')[0] as E.HumanRequest, 'ignore');
    h.advance(30 * MIN);
    h.run((s, t) => E.sweep(s, t));
    expect(h.openRequests('timeout')).toHaveLength(0);
    expect(h.state.attempts.get(at.id)?.timeoutEscalated).toBe(true);
    const h2 = new Harness(spec([task('a', [], { timeout: '10m', leaseTtl: '2h' })]));
    const at2 = h2.claim('a');
    h2.advance(11 * MIN);
    h2.run((s, t) => E.sweep(s, t));
    h2.resolve(h2.openRequests('timeout')[0] as E.HumanRequest, 'fail_attempt');
    expect(h2.state.attempts.get(at2.id)).toMatchObject({ status: 'errored', counted: true });
  });

  it('handles stall escalations', () => {
    const h = new Harness(
      spec([task('a', [], { maxAttempts: 1, onExhausted: 'fail' }), task('b', ['a'])]),
    );
    h.failAim('a');
    const r = h.openRequests('stall')[0] as E.HumanRequest;
    h.resolve(r, 'retry', { data: { nodeKey: 'a' } });
    expect(h.status('a')).toBe('ready');
    h.failAim('a');
    h.resolve(h.openRequests('stall')[0] as E.HumanRequest, 'skip', { data: { reason: 'later' } });
    expect(h.statuses()).toEqual({ a: 'skipped', b: 'ready' });
    const h2 = new Harness(
      spec([task('a', [], { maxAttempts: 1, onExhausted: 'fail' }), task('b', ['a'])]),
    );
    h2.failAim('a');
    h2.resolve(h2.openRequests('stall')[0] as E.HumanRequest, 'fail_graph', { comment: 'abandon' });
    expect(h2.state.graph.status).toBe('failed');
  });

  it('retries a rejected gate with a fresh approval request', () => {
    const h = new Harness(spec([task('a'), gate('g', ['a']), task('b', ['g'])]));
    h.pass('a');
    h.resolve(h.openRequests('gate')[0] as E.HumanRequest, 'reject', { comment: 'not yet' });
    expect(h.status('g')).toBe('failed');
    h.resolve(h.openRequests('stall')[0] as E.HumanRequest, 'retry', { data: { nodeKey: 'g' } });
    expect(h.node('g')).toMatchObject({ status: 'needs_input', activation: 2 });
    h.resolve(h.openRequests('gate')[0] as E.HumanRequest, 'approve');
    expect(h.status('b')).toBe('ready');
  });

  it('handles milestone escalations', () => {
    const milestone = (target: number) =>
      new Harness(
        spec([
          task('a'),
          {
            key: 'm',
            title: 'M',
            kind: 'milestone',
            needs: ['a'],
            aims: [
              { key: 'cheap', metric: 'cost_usd', comparator: 'lte', target, source: 'derived' },
            ],
          },
        ]),
      );
    const h = milestone(1);
    h.submit(h.claim('a'), { usage: { costUsd: 5 } });
    expect(h.status('m')).toBe('needs_input');
    h.resolve(h.openRequests('milestone')[0] as E.HumanRequest, 'waive', {
      data: { aimKey: 'cheap', justification: 'one-off' },
    });
    expect(h.status('m')).toBe('done');
    const h2 = milestone(1);
    h2.submit(h2.claim('a'), { usage: { costUsd: 5 } });
    h2.resolve(h2.openRequests('milestone')[0] as E.HumanRequest, 'fail', {
      comment: 'over budget',
    });
    expect(h2.status('m')).toBe('failed');
  });

  it('judges qualitative milestone aims through the inbox', () => {
    const h = new Harness(
      spec([
        task('a'),
        {
          key: 'm',
          title: 'M',
          kind: 'milestone',
          needs: ['a'],
          aims: ['Stakeholders signed off'],
        },
      ]),
    );
    h.pass('a');
    expect(h.status('m')).toBe('evaluating');
    h.resolve(h.openRequests('aim')[0] as E.HumanRequest, 'approve');
    expect(h.status('m')).toBe('done');
  });

  it('handles guard waivers and graph failure', () => {
    const guarded = () =>
      new Harness(
        spec([task('a'), task('b')], {
          aims: [
            {
              key: 'budget',
              check: 'cost_usd <= 1',
              source: 'derived',
              guard: true,
              terminating: false,
              evaluator: 'human',
            },
          ],
        }),
      );
    const h = guarded();
    h.submit(h.claim('a'), { usage: { costUsd: 2 } });
    h.resolve(h.openRequests('guard')[0] as E.HumanRequest, 'waive', {
      data: { justification: 'approved overspend' },
    });
    expect(h.state.graph.status).toBe('active');
    h.pass('b');
    expect(h.state.graph.status).toBe('completed');
    const h2 = guarded();
    h2.submit(h2.claim('a'), { usage: { costUsd: 2 } });
    h2.resolve(h2.openRequests('guard')[0] as E.HumanRequest, 'fail');
    expect(h2.state.graph.status).toBe('failed');
  });

  it('handles verification waive and fail', () => {
    const h = new Harness(
      spec([task('a')], { aims: [{ key: 'fast', title: 'Fast', evaluator: 'human' }] }),
    );
    h.pass('a');
    h.resolve(h.openRequests('aim')[0] as E.HumanRequest, 'reject', { comment: 'slow' });
    h.resolve(h.openRequests('verification')[0] as E.HumanRequest, 'waive', {
      data: { aimKey: 'fast', justification: 'later' },
    });
    expect(h.state.graph.status).toBe('completed');
    const h2 = new Harness(
      spec([task('a')], { aims: [{ key: 'fast', title: 'Fast', evaluator: 'human' }] }),
    );
    h2.pass('a');
    h2.resolve(h2.openRequests('aim')[0] as E.HumanRequest, 'reject', { comment: 'slow' });
    h2.resolve(h2.openRequests('verification')[0] as E.HumanRequest, 'fail', { comment: 'no' });
    expect(h2.state.graph.status).toBe('failed');
  });

  it('judges graph aims directly and rejects plan approvals', () => {
    const h = new Harness(
      spec([task('a')], {
        aims: [{ key: 'fast', title: 'Fast', evaluator: 'orchestrator' }],
        orchestrators: [{ key: 'reviewer', name: 'R', capabilities: ['evaluate'] }],
      }),
    );
    expect(
      codeOf(() =>
        h.run((s, t) => E.evaluateGraphAim(s, t, { aim: 'fast', verdict: 'met' }), JUDGE),
      ),
    ).toBe('INVALID_TRANSITION');
    h.pass('a');
    const reviewer = [...h.state.orchestrators.values()][0] as E.Orchestrator;
    expect(E.dutyQueue(h.state, reviewer.id, h.ctx.now).map((d) => d.kind)).toContain(
      'judge_graph_aim',
    );
    h.run(
      (s, t) => E.evaluateGraphAim(s, t, { aim: 'fast', verdict: 'met', rationale: 'p95 120ms' }),
      JUDGE,
    );
    expect(h.state.graph.status).toBe('completed');

    const p = new Harness(spec([task('a')], { policy: { requirePlanApproval: true } }), {
      start: false,
    });
    p.run((s, t) => E.startGraph(s, t), WORKER);
    const again = p.run((s, t) => E.startGraph(s, t), WORKER);
    expect(again.request?.subject).toBe('plan');
    p.resolve(p.openRequests('plan')[0] as E.HumanRequest, 'reject', {
      comment: 'Split the API node',
    });
    expect(p.state.graph).toMatchObject({ status: 'draft', pendingApproval: false });
    expect([...p.state.directives.values()][0]?.body).toBe('Split the API node');
  });
});

describe('graph lifecycle edges', () => {
  it('pauses, resumes, archives, and refuses invalid transitions', () => {
    const h = new Harness(spec([task('a')]));
    expect(codeOf(() => h.run((s, t) => E.startGraph(s, t)))).toBe('INVALID_TRANSITION');
    expect(codeOf(() => h.run((s, t) => E.resume(s, t)))).toBe('INVALID_TRANSITION');
    expect(codeOf(() => h.run((s, t) => E.archive(s, t, true)))).toBe('INVALID_TRANSITION');
    h.run((s, t) => E.pause(s, t, 'lunch'));
    expect(codeOf(() => h.claim('a'))).toBe('INVALID_TRANSITION');
    expect(E.pickNext(h.state).kind).toBe('none');
    expect(codeOf(() => h.run((s, t) => E.pause(s, t)))).toBe('INVALID_TRANSITION');
    h.run((s, t) => E.archive(s, t, true));
    expect(h.state.graph.archivedAt).toBeDefined();
    h.run((s, t) => E.archive(s, t, false));
    h.run((s, t) => E.resume(s, t));
    h.run((s, t) => E.fail(s, t, 'scrapped'));
    expect(h.state.graph.status).toBe('failed');
    expect(codeOf(() => h.run((s, t) => E.cancel(s, t)))).toBe('INVALID_TRANSITION');
    expect(codeOf(() => h.run((s, t) => E.fail(s, t, 'again')))).toBe('INVALID_TRANSITION');
    h.run((s, t) => E.reopenGraph(s, t, 'try again'));
    expect(h.state.graph.status).toBe('active');
    expect(codeOf(() => h.run((s, t) => E.reopenGraph(s, t)))).toBe('INVALID_TRANSITION');
  });

  it('fails the graph on a terminal node failure with failFast', () => {
    const h = new Harness(
      spec([task('a', [], { maxAttempts: 1, onExhausted: 'fail' }), task('b')], {
        policy: { failFast: true },
      }),
    );
    const other = h.claim('b');
    h.failAim('a');
    expect(h.state.graph.status).toBe('failed');
    expect(h.state.attempts.get(other.id)?.status).toBe('cancelled');
  });

  it('enforces node action source statuses', () => {
    const h = new Harness(spec([task('a'), gate('g', ['a'])]));
    const id = h.node('a').id;
    expect(codeOf(() => h.run((s, t) => E.resumeNode(s, t, id)))).toBe('INVALID_TRANSITION');
    expect(codeOf(() => h.run((s, t) => E.retry(s, t, id, 1)))).toBe('INVALID_TRANSITION');
    expect(codeOf(() => h.run((s, t) => E.reopenNode(s, t, id)))).toBe('INVALID_TRANSITION');
    expect(codeOf(() => h.run((s, t) => E.failNodeAction(s, t, id, '')))).toBe('BAD_REQUEST');
    h.pass('a');
    expect(codeOf(() => h.run((s, t) => E.decideGate(s, t, h.node('a'), true)))).toBe(
      'INVALID_TRANSITION',
    );
    expect(codeOf(() => h.run((s, t) => E.decideGate(s, t, h.node('g'), false)))).toBe(
      'BAD_REQUEST',
    );
    h.run((s, t) => E.pauseNode(s, t, h.node('g').id));
    h.run((s, t) => E.resumeNode(s, t, h.node('g').id));
    expect(h.status('g')).toBe('needs_input');
    expect(h.openRequests('gate')).toHaveLength(1);
  });

  it('resumes a paused evaluating node and pauses a blocked one', () => {
    const h = new Harness(
      spec([task('a', [], { aims: [{ key: 'ok', title: 'r', evaluator: 'agent' }] }), task('b')]),
    );
    h.submit(h.claim('a'), { evaluations: [] });
    h.run((s, t) => E.pauseNode(s, t, h.node('a').id));
    h.run((s, t) => E.resumeNode(s, t, h.node('a').id));
    expect(h.status('a')).toBe('evaluating');
    const at = h.claim('b');
    h.run(
      (s, t) => E.blockAttempt(s, t, { attemptId: at.id, reason: 'x', request: { title: 't' } }),
      WORKER,
    );
    h.run((s, t) => E.pauseNode(s, t, h.node('b').id));
    h.run((s, t) => E.resumeNode(s, t, h.node('b').id));
    expect(h.status('b')).toBe('blocked');
  });

  it('refuses closed attempts with a helpful hint', () => {
    const h = new Harness(spec([task('a')]));
    const at = h.claim('a');
    h.submit(at);
    for (const call of [
      () => h.heartbeatFor(at),
      () => h.run((s, t) => E.failAttempt(s, t, { attemptId: at.id, reason: 'x' }), WORKER),
      () => h.run((s, t) => E.releaseAttempt(s, t, { attemptId: at.id, reason: 'x' }), WORKER),
      () =>
        h.run((s, t) => E.evaluate(s, t, { attemptId: at.id, aim: 'ok', verdict: 'met' }), JUDGE),
      () => h.run((s, t) => E.updateChecklist(s, t, at.id, {}), WORKER),
    ]) {
      expect(codeOf(call)).toBe('ATTEMPT_CLOSED');
    }
    expect(
      codeOf(() => h.run((s, t) => E.claim(s, t, { nodeId: 'nd_missing', actor: WORKER }))),
    ).toBe('NOT_FOUND');
  });

  it('expires orchestrator leases, directives, and requests in the sweeper', () => {
    const h = new Harness(
      spec([task('a')], {
        orchestrators: [{ key: 'lead', name: 'Lead', capabilities: ['dispatch'] }],
      }),
    );
    const orch = [...h.state.orchestrators.values()][0] as E.Orchestrator;
    orch.status = 'active';
    orch.leaseExpiresAt = h.ctx.now + MIN;
    const d = h.run((s, t) =>
      E.createDirective(s, t, {
        targetType: 'graph',
        targetId: s.graph.id,
        kind: 'guidance',
        title: 'x',
        expiresAt: h.ctx.now + MIN,
      }),
    );
    const r = h.run((s, t) =>
      E.openRequest(s, t, { kind: 'question', subject: 'question', title: 'q', blocking: false }),
    );
    r.expiresAt = h.ctx.now + MIN;
    h.advance(2 * MIN);
    h.run((s, t) => E.sweep(s, t));
    expect(orch.status).toBe('idle');
    expect(h.state.directives.get(d.id)?.status).toBe('expired');
    expect(h.state.requests.get(r.id)?.status).toBe('expired');
  });

  it('renews session leases and supersedes directives', () => {
    const h = new Harness(spec([task('a')]));
    const at = h.claim('a');
    h.advance(20 * MIN);
    const renewed = h.run((s, t) => E.renewSessionLeases(s, t, ['se_worker']));
    expect(renewed.map((a) => a.id)).toEqual([at.id]);
    expect(at.leaseExpiresAt).toBe(h.ctx.now + 30 * MIN);
    const first = h.run((s, t) =>
      E.createDirective(s, t, {
        targetType: 'node',
        targetId: at.nodeId,
        kind: 'guidance',
        title: 'v1',
      }),
    );
    h.run((s, t) =>
      E.createDirective(s, t, {
        targetType: 'node',
        targetId: at.nodeId,
        kind: 'guidance',
        title: 'v2',
        supersedes: first.id,
      }),
    );
    expect(h.state.directives.get(first.id)?.status).toBe('superseded');
    expect(h.heartbeatFor(at).directives.map((d) => d.title)).toEqual(['v2']);
  });
});

describe('work selection and duty queues', () => {
  it('explains why nothing is available', () => {
    const h = new Harness(
      spec([task('a', [], { executor: { requires: ['gpu'] } }), task('b', ['a'])], {
        policy: { maxParallel: 1 },
      }),
    );
    const none = E.pickNext(h.state, { skills: [] });
    expect(none.kind === 'none' && none.reason).toMatch(/skills/);
    h.claim('a', WORKER, ['gpu']);
    const busy = E.pickNext(h.state, {});
    expect(busy.kind === 'none' && busy.waitingOn).toEqual(['a (running)']);
    expect(E.pickNext(h.state, { role: 'reviewer', actor: JUDGE }).kind).toBe('none');
  });

  it('returns pending agent evaluations to reviewers', () => {
    const h = new Harness(
      spec([task('a', [], { aims: [{ key: 'ok', title: 'r', evaluator: 'agent' }] })]),
    );
    h.submit(h.claim('a'), { evaluations: [] });
    const next = E.pickNext(h.state, { role: 'reviewer', actor: JUDGE });
    expect(next.kind === 'evaluation' && next.aims.map((a) => a.key)).toEqual(['ok']);
  });

  it('builds queues per capability and scope', () => {
    const h = new Harness(
      spec([task('a', [], { tags: ['backend'] }), task('b', [], { tags: ['ui'] })], {
        orchestrators: [
          {
            key: 'lead',
            name: 'Lead',
            capabilities: ['dispatch', 'resolve', 'approve'],
            scope: { tags: ['backend'] },
          },
          {
            key: 'evolver',
            name: 'Evolver',
            role: 'evolver',
            capabilities: ['evolve'],
            scope: { nodes: ['a'] },
          },
        ],
        evolution: { mode: 'learn' },
      }),
    );
    const byKey = (k: string) =>
      [...h.state.orchestrators.values()].find((o) => o.key === k) as E.Orchestrator;
    expect(E.dutyQueue(h.state, byKey('lead').id, h.ctx.now).map((d) => d.nodeKey)).toEqual(['a']);
    h.failAim('a');
    h.pass('a');
    expect(E.dutyQueue(h.state, byKey('evolver').id, h.ctx.now).map((d) => d.kind)).toEqual([
      'lesson_duty',
    ]);
    h.claim('b');
    h.advance(20 * MIN);
    expect(
      E.dutyQueue(h.state, byKey('lead').id, h.ctx.now).some((d) => d.kind === 'stale_lease'),
    ).toBe(false);
    expect(E.dutyQueue(h.state, 'or_missing', h.ctx.now)).toEqual([]);
  });
});
