import { describe, expect, it } from 'vitest';
import * as E from '../src/engine/index';
import { EVENT_TYPES } from '../src/vocabulary';
import { codeOf, gate, Harness, JUDGE, spec, task, WORKER } from './harness';

const MIN = 60_000;

describe('lifecycle', () => {
  it('runs a linear graph to completion through verification', () => {
    const h = new Harness(spec([task('a'), task('b', ['a'])]));
    expect(h.state.graph.status).toBe('active');
    expect(h.statuses()).toEqual({ a: 'ready', b: 'pending' });
    expect(h.pass('a').outcome).toBe('passed');
    expect(h.statuses()).toEqual({ a: 'done', b: 'ready' });
    h.pass('b');
    // Default graph aim nodes_done_ratio >= 1 is derived, so verification completes at once.
    expect(h.state.graph.status).toBe('completed');
    expect(h.types(h.events)).toContain('graph.verifying');
    expect(h.types(h.events)).toContain('graph.completed');
  });

  it('only emits cataloged event types', () => {
    const h = new Harness(spec([task('a'), gate('g', ['a'])]));
    h.pass('a');
    h.resolve(h.openRequests('gate')[0] as E.HumanRequest, 'approve');
    for (const e of h.events) expect(EVENT_TYPES).toContain(e.type);
  });

  it('requires plan approval for agent starts', () => {
    const h = new Harness(spec([task('a')], { policy: { requirePlanApproval: true } }), {
      start: false,
    });
    const out = h.run((s, t) => E.startGraph(s, t), WORKER);
    expect(out.started).toBe(false);
    expect(h.state.graph.pendingApproval).toBe(true);
    h.resolve(h.openRequests('plan')[0] as E.HumanRequest, 'approve');
    expect(h.state.graph.status).toBe('active');
    expect(h.status('a')).toBe('ready');
  });

  it('cancels open attempts and non-terminal nodes', () => {
    const h = new Harness(spec([task('a'), task('b', ['a'])]));
    const at = h.claim('a');
    h.run((s, t) => E.cancel(s, t));
    expect(h.state.attempts.get(at.id)?.status).toBe('cancelled');
    expect(h.statuses()).toEqual({ a: 'cancelled', b: 'cancelled' });
    expect(codeOf(() => h.heartbeatFor(at))).toBe('ATTEMPT_CLOSED');
  });
});

describe('claim', () => {
  it('rejects non-ready nodes, double claims, skills, and maxParallel', () => {
    const h = new Harness(
      spec(
        [
          task('a'),
          task('b'),
          task('c', [], { executor: { requires: ['repo-write'] } }),
          task('d', ['a']),
        ],
        { policy: { maxParallel: 1 } },
      ),
    );
    expect(codeOf(() => h.claim('d'))).toBe('INVALID_TRANSITION');
    expect(codeOf(() => h.claim('c'))).toBe('POLICY_DENIED');
    h.claim('a');
    expect(codeOf(() => h.claim('a'))).toBe('ALREADY_CLAIMED');
    expect(codeOf(() => h.claim('b'))).toBe('MAX_PARALLEL_REACHED');
  });

  it('picks the best ready node: priority, then critical path', () => {
    const h = new Harness(
      spec([
        task('short'),
        task('long'),
        task('long-2', ['long']),
        task('urgent', [], { priority: 'p0' }),
      ]),
    );
    const order = E.rankReadyNodes(h.state).map((n) => n.key);
    expect(order).toEqual(['urgent', 'long', 'short']);
    const next = E.pickNext(h.state, {});
    expect(next.kind === 'node' && next.node.key).toBe('urgent');
  });
});

describe('submit and aims', () => {
  const quant = () =>
    spec([
      task('a', [], {
        aims: [
          { check: 'test_pass_rate >= 1' },
          { key: 'ok', title: 'works', evaluator: 'self' },
          { check: 'bundle_kb < 200', terminating: false },
        ],
      }),
    ]);

  it('rejects incomplete submissions with a hint naming the metric', () => {
    const h = new Harness(quant());
    const at = h.claim('a');
    let error: unknown;
    try {
      h.submit(at);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(E.EngineError);
    expect((error as E.EngineError).code).toBe('AIM_EVIDENCE_MISSING');
    expect((error as E.EngineError).hint).toContain('test_pass_rate');
    expect(h.state.attempts.get(at.id)?.status).toBe('running');
  });

  it('judges quantitative aims automatically', () => {
    const h = new Harness(quant());
    const result = h.submit(h.claim('a'), { metrics: [{ name: 'test_pass_rate', value: 1 }] });
    expect(result.outcome).toBe('passed');
    const low = new Harness(quant());
    const failed = low.submit(low.claim('a'), {
      metrics: [{ name: 'test_pass_rate', value: 0.9 }],
    });
    expect(failed.outcome).toBe('failed');
    expect(low.node('a').feedback?.unmetAims?.[0]).toMatchObject({ value: 0.9, target: 1 });
  });

  it('accepts a single decidable aim in aimMode any', () => {
    const h = new Harness(
      spec([
        task('a', [], {
          aimMode: 'any',
          aims: [{ check: 'x >= 1' }, { key: 'ok', title: 'works', evaluator: 'self' }],
        }),
      ]),
    );
    expect(h.submit(h.claim('a')).outcome).toBe('passed');
  });

  it('refuses verdicts for aims the worker does not judge', () => {
    const h = new Harness(
      spec([task('a', [], { aims: [{ key: 'ok', title: 'reviewed', evaluator: 'agent' }] })]),
    );
    expect(codeOf(() => h.submit(h.claim('a')))).toBe('POLICY_DENIED');
  });

  it('enforces required checklist items and proof notes', () => {
    const h = new Harness(
      spec(
        [task('a', [], { checklist: [{ key: 'tests', title: 'tests first', required: true }] })],
        {
          policy: { requireProofForDone: true },
        },
      ),
    );
    const at = h.claim('a');
    expect(codeOf(() => h.submit(at))).toBe('CHECKLIST_INCOMPLETE');
    h.run((s, t) => E.updateChecklist(s, t, at.id, { tests: { done: true } }), WORKER);
    expect(codeOf(() => h.submit(at))).toBe('PROOF_REQUIRED');
    expect(h.submit(at, { proofNotes: 1 }).outcome).toBe('passed');
  });

  it('waits for an independent agent judge', () => {
    const h = new Harness(
      spec([task('a', [], { aims: [{ key: 'ok', title: 'reviewed', evaluator: 'agent' }] })]),
    );
    const at = h.claim('a');
    const result = h.submit(at, { evaluations: [] });
    expect(result.outcome).toBe('evaluating');
    expect(h.status('a')).toBe('evaluating');
    expect(at.leaseExpiresAt).toBeUndefined();
    expect(E.pendingAgentEvaluations(h.state, WORKER)).toHaveLength(0);
    expect(E.pendingAgentEvaluations(h.state, JUDGE)).toHaveLength(1);
    const evaluate = (actor: typeof JUDGE) =>
      h.run((s, t) => E.evaluate(s, t, { attemptId: at.id, aim: 'ok', verdict: 'met' }), actor);
    expect(codeOf(() => evaluate(WORKER))).toBe('POLICY_DENIED');
    evaluate(JUDGE);
    expect(h.status('a')).toBe('done');
  });

  it('routes human-judged aims through the inbox', () => {
    const h = new Harness(
      spec([task('a', [], { aims: [{ key: 'ok', title: 'looks right', evaluator: 'human' }] })]),
    );
    h.submit(h.claim('a'), { evaluations: [] });
    const [request] = h.openRequests('aim');
    expect(request?.kind).toBe('approval');
    expect(codeOf(() => h.resolve(request as E.HumanRequest, 'reject'))).toBe('BAD_REQUEST');
    h.resolve(request as E.HumanRequest, 'reject', { comment: 'colours are off' });
    expect(h.status('a')).toBe('ready');
    expect(h.node('a').feedback?.unmetAims?.[0]?.rationale).toBe('colours are off');
  });

  it('waives an aim on a submitted attempt', () => {
    const h = new Harness(
      spec(
        [task('a', [], { aims: [{ key: 'ok', title: 'reviewed', evaluator: 'orchestrator' }] })],
        {
          orchestrators: [{ key: 'reviewer', name: 'Reviewer', capabilities: ['evaluate'] }],
        },
      ),
    );
    h.submit(h.claim('a'), { evaluations: [] });
    const aim = E.aimByKey(h.state, 'node', h.node('a').id, 'ok');
    h.run((s, t) => E.waiveAim(s, t, aim, 'reviewer unavailable; covered by e2e'));
    expect(h.status('a')).toBe('done');
    expect(h.types(h.events)).toContain('aim.waived');
  });
});

describe('self-iteration (§7.1)', () => {
  it('retries with feedback, then escalates on exhaustion', () => {
    const h = new Harness(spec([task('a', [], { maxAttempts: 2 })]));
    h.failAim('a');
    expect(h.status('a')).toBe('ready');
    expect(h.node('a').countedAttempts).toBe(1);
    const second = h.claim('a');
    expect(second.feedbackIn?.unmetAims?.[0]?.rationale).toBe('broken');
    h.submit(second, { evaluations: [{ aim: 'ok', verdict: 'unmet', rationale: 'still' }] });
    expect(h.status('a')).toBe('needs_input');
    const [request] = h.openRequests('exhaustion');
    expect(request?.options.map((o) => o.id)).toEqual([
      'retry',
      'accept',
      'skip',
      'fail',
      'edit_retry',
    ]);
    h.resolve(request as E.HumanRequest, 'retry', { data: { extraAttempts: 1 } });
    expect(h.status('a')).toBe('ready');
    expect(h.node('a').grantedAttempts).toBe(1);
    h.pass('a');
    expect(h.status('a')).toBe('done');
  });

  it.each([
    ['fail', 'failed', false],
    ['skip', 'skipped', false],
    ['accept', 'done', true],
  ] as const)('onExhausted %s → %s', (policy, status, deviation) => {
    const h = new Harness(
      spec([task('a', [], { maxAttempts: 1, onExhausted: policy }), task('b')]),
    );
    h.failAim('a');
    expect(h.status('a')).toBe(status);
    expect(h.node('a').acceptedWithDeviation).toBe(deviation);
  });

  it('exhausts at once on a non-retryable failure', () => {
    const h = new Harness(
      spec([task('a', [], { maxAttempts: 5, onExhausted: 'fail' }), task('b')]),
    );
    const at = h.claim('a');
    h.run(
      (s, t) => E.failAttempt(s, t, { attemptId: at.id, reason: 'API removed', retryable: false }),
      WORKER,
    );
    expect(h.status('a')).toBe('failed');
    expect(h.state.attempts.get(at.id)?.status).toBe('errored');
  });

  it('does not count blocked or released attempts', () => {
    const h = new Harness(spec([task('a', [], { maxAttempts: 1 })]));
    const blocked = h.claim('a');
    h.run(
      (s, t) =>
        E.blockAttempt(s, t, {
          attemptId: blocked.id,
          reason: 'no creds',
          request: { title: 'Need staging creds' },
        }),
      WORKER,
    );
    expect(h.status('a')).toBe('blocked');
    h.resolve(h.openRequests('blocker')[0] as E.HumanRequest, 'unblock', {
      data: { info: 'in vault' },
    });
    expect(h.status('a')).toBe('ready');
    const released = h.claim('a');
    h.run(
      (s, t) =>
        E.releaseAttempt(s, t, {
          attemptId: released.id,
          reason: 'context full',
          handoff: 'half done',
        }),
      WORKER,
    );
    expect(h.status('a')).toBe('ready');
    expect(h.node('a').countedAttempts).toBe(0);
    expect(h.types()).toContain('note.created');
  });

  it('expires leases (counted) except while paused', () => {
    const h = new Harness(spec([task('a', [], { leaseTtl: '10m' })]));
    h.claim('a');
    h.advance(11 * MIN);
    h.run((s, t) => E.sweep(s, t));
    expect(h.status('a')).toBe('ready');
    expect(h.node('a').countedAttempts).toBe(1);
    h.claim('a');
    h.run((s, t) => E.pauseNode(s, t, h.node('a').id));
    h.advance(11 * MIN);
    h.run((s, t) => E.sweep(s, t));
    expect(h.node('a').countedAttempts).toBe(1);
    expect(h.status('a')).toBe('paused');
    h.run((s, t) => E.resumeNode(s, t, h.node('a').id));
    expect(h.status('a')).toBe('ready');
  });

  it('defers a failure decision submitted while paused', () => {
    const h = new Harness(spec([task('a')]));
    const at = h.claim('a');
    h.run((s, t) => E.pauseNode(s, t, h.node('a').id));
    expect(h.heartbeatFor(at).pauseRequested).toBe(true);
    h.submit(at, { evaluations: [{ aim: 'ok', verdict: 'unmet' }] });
    expect(h.status('a')).toBe('paused');
    expect(h.node('a').deferredFailure).toBeDefined();
    h.run((s, t) => E.resumeNode(s, t, h.node('a').id));
    expect(h.status('a')).toBe('ready');
  });
});

describe('loops (§7.2)', () => {
  const fixLoop = (max = 3) =>
    spec(
      [task('design'), task('impl', ['design']), task('test', ['impl']), task('ship', ['test'])],
      {
        loops: [{ key: 'fix', from: 'test', to: 'impl', maxIterations: max }],
      },
    );

  it('fires on trigger failure, resetting exactly the body', () => {
    const h = new Harness(fixLoop());
    h.pass('design');
    h.pass('impl');
    h.failAim('test');
    const loop = E.loopByKey(h.state, 'fix');
    expect(loop.iteration).toBe(2);
    expect(h.statuses()).toEqual({
      design: 'done',
      impl: 'ready',
      test: 'pending',
      ship: 'pending',
    });
    expect(h.node('impl').activation).toBe(2);
    expect(h.node('test').countedAttempts).toBe(0);
    expect(h.node('impl').feedback?.source).toBe('loop');
    const changed = h.last
      .filter((e) => e.type === 'node.status_changed')
      .map((e) => e.payload.key);
    expect(new Set(changed)).toEqual(new Set(['impl', 'test']));
    const superseded = [...h.state.attempts.values()].filter((a) => a.status === 'superseded');
    expect(superseded).toHaveLength(1);
  });

  it('never consumes self-retries for trigger aim failures', () => {
    const h = new Harness(
      spec([task('impl'), task('test', ['impl'], { maxAttempts: 1 })], {
        loops: [{ key: 'fix', from: 'test', to: 'impl', maxIterations: 3 }],
      }),
    );
    h.pass('impl');
    h.failAim('test');
    h.pass('impl');
    h.failAim('test');
    expect(E.loopByKey(h.state, 'fix').iteration).toBe(3);
  });

  it('exhausts, escalates, and extends', () => {
    const h = new Harness(fixLoop(2));
    h.pass('design');
    h.pass('impl');
    h.failAim('test');
    h.pass('impl');
    h.failAim('test');
    const loop = E.loopByKey(h.state, 'fix');
    expect(loop.status).toBe('exhausted');
    expect(h.status('test')).toBe('needs_input');
    const [request] = h.openRequests('loop');
    h.resolve(request as E.HumanRequest, 'extend', { data: { extraIterations: 1 } });
    expect(loop.iteration).toBe(3);
    expect(loop.status).toBe('active');
    expect(h.status('impl')).toBe('ready');
    h.pass('impl');
    h.pass('test');
    expect(loop.status).toBe('satisfied');
    expect(h.status('ship')).toBe('ready');
  });

  it('resets nested loops when an outer loop fires', () => {
    const h = new Harness(
      spec(
        [
          task('design'),
          task('impl', ['design']),
          task('test', ['impl']),
          gate('review', ['test']),
        ],
        {
          loops: [
            { key: 'inner', from: 'test', to: 'impl', maxIterations: 4 },
            { key: 'outer', from: 'review', to: 'design', maxIterations: 2 },
          ],
        },
      ),
    );
    h.pass('design');
    h.pass('impl');
    h.failAim('test');
    h.pass('impl');
    h.pass('test');
    expect(E.loopByKey(h.state, 'inner').iteration).toBe(2);
    expect(h.status('review')).toBe('needs_input');
    const [request] = h.openRequests('gate');
    h.resolve(request as E.HumanRequest, 'reject', { comment: 'wrong approach' });
    expect(E.loopByKey(h.state, 'outer').iteration).toBe(2);
    expect(E.loopByKey(h.state, 'inner')).toMatchObject({ iteration: 1, status: 'idle' });
    expect(h.statuses()).toEqual({
      design: 'ready',
      impl: 'pending',
      test: 'pending',
      review: 'pending',
    });
    expect(h.node('design').feedback?.comment).toBe('wrong approach');
  });
});

describe('gates, milestones, and node actions', () => {
  it('opens an approval request when a gate becomes ready', () => {
    const h = new Harness(spec([task('a'), gate('g', ['a']), task('b', ['g'])]));
    h.pass('a');
    expect(h.status('g')).toBe('needs_input');
    const [request] = h.openRequests('gate');
    expect(request?.assignee).toBe('human');
    h.resolve(request as E.HumanRequest, 'approve');
    expect(h.statuses()).toEqual({ a: 'done', g: 'done', b: 'ready' });
  });

  it('fails a rejected gate that triggers no loop', () => {
    const h = new Harness(spec([task('a'), gate('g', ['a']), task('b', ['g'])]));
    h.pass('a');
    h.resolve(h.openRequests('gate')[0] as E.HumanRequest, 'reject', { comment: 'no' });
    expect(h.status('g')).toBe('failed');
    expect(h.state.graph.stalled).toBe(true);
    expect(h.openRequests('stall')).toHaveLength(1);
  });

  it('completes milestones on derived aims', () => {
    const h = new Harness(
      spec([
        task('a'),
        {
          key: 'm',
          title: 'Milestone',
          kind: 'milestone',
          needs: ['a'],
          aims: [
            { title: 'cheap', metric: 'cost_usd', comparator: 'lte', target: 5, source: 'derived' },
          ],
        },
      ]),
    );
    h.submit(h.claim('a'), { usage: { costUsd: 2 } });
    expect(h.status('m')).toBe('done');
  });

  it('skips with a reason and lets dependents proceed', () => {
    const h = new Harness(spec([task('a'), task('b', ['a'])]));
    expect(codeOf(() => h.run((s, t) => E.skip(s, t, h.node('a').id, '')))).toBe('BAD_REQUEST');
    h.run((s, t) => E.skip(s, t, h.node('a').id, 'out of scope'));
    expect(h.statuses()).toEqual({ a: 'skipped', b: 'ready' });
  });

  it('reopens with a cascade to started descendants', () => {
    const h = new Harness(spec([task('a'), task('b', ['a']), task('c', ['b']), task('d')]));
    h.pass('a');
    h.pass('b');
    const at = h.claim('c');
    h.pass('d');
    h.run((s, t) => E.reopenNode(s, t, h.node('a').id));
    expect(h.statuses()).toEqual({ a: 'ready', b: 'pending', c: 'pending', d: 'done' });
    expect(h.state.attempts.get(at.id)?.status).toBe('superseded');
    expect(h.node('b').activation).toBe(2);
  });

  it('completes manually, waiving unjudged terminating aims', () => {
    const h = new Harness(spec([task('a'), task('b', ['a'])]));
    expect(
      codeOf(() =>
        h.run((s, t) =>
          E.completeManually(s, t, { nodeId: h.node('b').id, summary: 'done before' }),
        ),
      ),
    ).toBe('INVALID_TRANSITION');
    h.run((s, t) => E.completeManually(s, t, { nodeId: h.node('a').id, summary: 'done before' }));
    expect(h.node('a')).toMatchObject({ status: 'done', manual: true });
    expect(E.aimByKey(h.state, 'node', h.node('a').id, 'ok').status).toBe('waived');
  });
});

describe('graph aims, guards, and verification', () => {
  it('pauses the graph when a guard is violated', () => {
    const h = new Harness(
      spec([task('a'), task('b')], {
        aims: [
          {
            key: 'done',
            check: 'nodes_done_ratio >= 1',
            source: 'derived',
            evaluator: 'orchestrator',
          },
          {
            key: 'budget',
            check: 'cost_usd <= 10',
            source: 'derived',
            guard: true,
            terminating: false,
            evaluator: 'orchestrator',
          },
        ],
      }),
    );
    h.submit(h.claim('a'), { usage: { costUsd: 12 } });
    expect(h.state.graph.status).toBe('paused');
    expect(codeOf(() => h.run((s, t) => E.resume(s, t)))).toBe('INVALID_TRANSITION');
    const [request] = h.openRequests('guard');
    expect(
      codeOf(() =>
        h.resolve(request as E.HumanRequest, 'raise_target', { data: { target: 20 } }, JUDGE),
      ),
    ).toBe('POLICY_DENIED');
    h.resolve(request as E.HumanRequest, 'raise_target', { data: { target: 20 } });
    expect(h.state.graph.status).toBe('active');
  });

  it('escalates unmet graph aims and accepts with deviation', () => {
    const h = new Harness(spec([task('a')], { aims: ['The app feels fast'] }));
    h.pass('a');
    expect(h.state.graph.status).toBe('verifying');
    const [judge] = h.openRequests('aim');
    h.resolve(judge as E.HumanRequest, 'reject', { comment: 'sluggish' });
    const [verification] = h.openRequests('verification');
    expect(verification).toBeDefined();
    h.resolve(verification as E.HumanRequest, 'accept', { data: { justification: 'ship anyway' } });
    expect(h.state.graph).toMatchObject({ status: 'completed', acceptedWithDeviation: true });
  });

  it('returns to active for more work', () => {
    const h = new Harness(spec([task('a')], { aims: ['Good'] }));
    h.pass('a');
    h.resolve(h.openRequests('aim')[0] as E.HumanRequest, 'reject', { comment: 'missing docs' });
    h.resolve(h.openRequests('verification')[0] as E.HumanRequest, 'add_work');
    expect(h.state.graph.status).toBe('active');
  });
});

describe('directives', () => {
  it('delivers node guidance once per attempt and tracks acks', () => {
    const h = new Harness(spec([task('a')]));
    const at = h.claim('a');
    const d = h.run((s, t) =>
      E.createDirective(s, t, {
        targetType: 'node',
        targetId: h.node('a').id,
        kind: 'guidance',
        title: 'Use argon2id',
      }),
    );
    expect(h.heartbeatFor(at).directives.map((x) => x.id)).toEqual([d.id]);
    expect(h.heartbeatFor(at).directives).toHaveLength(0);
    h.run(
      (s, t) => E.ackDirective(s, t, { directiveId: d.id, recipient: at.id, note: 'switched' }),
      WORKER,
    );
    expect(h.state.directives.get(d.id)?.status).toBe('acknowledged');
  });

  it('sends a change directive when a running node is patched', () => {
    const h = new Harness(spec([task('a')]));
    const at = h.claim('a');
    h.run((s, t) => E.patchNode(s, t, h.node('a'), { prompt: 'New instructions' }));
    expect(h.heartbeatFor(at).briefingChanged).toBe(true);
    expect(codeOf(() => h.run((s, t) => E.patchNode(s, t, h.node('a'), { aims: [] })))).toBe(
      'BAD_REQUEST',
    );
  });
});

describe('learn mode', () => {
  it('opens a lesson duty when a node passes after failures', () => {
    const h = new Harness(spec([task('a')], { evolution: { mode: 'learn' } }));
    h.failAim('a');
    h.pass('a');
    const duties = [...h.state.lessonDuties.values()];
    expect(duties).toHaveLength(1);
    expect(duties[0]?.failedAttemptIds).toHaveLength(1);
  });

  it('does nothing when evolution is off', () => {
    const h = new Harness(spec([task('a')]));
    h.failAim('a');
    h.pass('a');
    expect(h.state.lessonDuties.size).toBe(0);
  });
});
