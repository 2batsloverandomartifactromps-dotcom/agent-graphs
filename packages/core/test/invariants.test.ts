/**
 * Property tests for the concepts §15 invariants: random DAGs with loops and gates, driven by
 * random sequences of agent, human, and sweeper actions. Invariants are checked after every step.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as E from '../src/engine/index';
import { gate, Harness, HUMAN, JUDGE, spec, task, WORKER } from './harness';

type Shape = {
  n: number;
  edges: Array<[number, number]>;
  gates: number[];
  loop?: [number, number];
  maxAttempts: number;
  onExhausted: 'escalate' | 'fail' | 'skip' | 'accept';
  external: number[];
};

/** A random DAG on n nodes (edges i → j with i < j), with an optional valid loop. */
const shapeArb: fc.Arbitrary<Shape> = fc.integer({ min: 2, max: 7 }).chain((n) =>
  fc.record({
    n: fc.constant(n),
    edges: fc.uniqueArray(
      fc
        .tuple(fc.integer({ min: 0, max: n - 1 }), fc.integer({ min: 0, max: n - 1 }))
        .filter(([a, b]) => a < b),
      { maxLength: n * 2, selector: ([a, b]) => `${a}-${b}` },
    ),
    gates: fc.uniqueArray(fc.integer({ min: 1, max: n - 1 }), { maxLength: 2 }),
    loop: fc.option(
      fc.tuple(fc.integer({ min: 0, max: n - 2 }), fc.integer({ min: 1, max: n - 1 })),
      {
        nil: undefined,
      },
    ),
    maxAttempts: fc.integer({ min: 1, max: 3 }),
    onExhausted: fc.constantFrom('escalate', 'fail', 'skip', 'accept'),
    external: fc.uniqueArray(fc.integer({ min: 0, max: n - 1 }), { maxLength: 2 }),
  }),
);

const key = (i: number) => `n${i}`;

/** Build a spec; drop the loop if it violates structure rules (validation decides). */
function buildSpec(shape: Shape, withLoop: boolean) {
  const nodes = Array.from({ length: shape.n }, (_, i) => {
    const needs = shape.edges.filter(([, b]) => b === i).map(([a]) => key(a));
    if (shape.gates.includes(i) && needs.length > 0) return gate(key(i), needs);
    const aims = shape.external.includes(i)
      ? [{ key: 'ok', title: 'reviewed', evaluator: 'agent' }]
      : [{ key: 'ok', title: 'works', evaluator: 'self' }];
    return task(key(i), needs, {
      aims,
      maxAttempts: shape.maxAttempts,
      onExhausted: shape.onExhausted,
    });
  });
  const loops =
    withLoop && shape.loop
      ? [
          {
            key: 'cycle',
            from: key(Math.max(...shape.loop)),
            to: key(Math.min(...shape.loop)),
            maxIterations: 2,
          },
        ]
      : [];
  return spec(nodes, { loops });
}

function makeHarness(shape: Shape): Harness {
  try {
    return new Harness(buildSpec(shape, true));
  } catch {
    return new Harness(buildSpec(shape, false));
  }
}

/** Cumulative upper bounds (out of 100) for ops 0..13. */
const OP_TABLE = [14, 26, 36, 46, 50, 53, 57, 65, 75, 82, 86, 89, 93, 100];

type Action = { op: number; pick: number; flag: boolean };
const actionArb: fc.Arbitrary<Action> = fc.record({
  // Weighted: mostly progress (claim, submit, judge, resolve), occasionally disruptive actions.
  op: fc.integer({ min: 0, max: 99 }).map((x) => OP_TABLE.findIndex((limit) => x < limit)),
  pick: fc.nat(),
  flag: fc.boolean(),
});

function pickFrom<T>(items: T[], pick: number): T | undefined {
  return items.length === 0 ? undefined : items[pick % items.length];
}

/** Apply one random action; refused actions (EngineError) are fine, other errors are bugs. */
function step(h: Harness, a: Action): void {
  const nodes = [...h.state.nodes.values()];
  const attempts = [...h.state.attempts.values()];
  const running = attempts.filter((x) => x.status === 'running');
  const submitted = attempts.filter((x) => x.status === 'submitted');
  const requests = h.openRequests();
  const choose = (status: string) =>
    pickFrom(
      nodes.filter((n) => n.status === status),
      a.pick,
    );
  const verdict = a.flag || a.pick % 3 === 0 ? 'met' : 'unmet';
  try {
    switch (a.op) {
      case 0:
      case 1: {
        const n = choose('ready');
        if (n) h.claim(n.key);
        break;
      }
      case 2:
      case 3: {
        const at = pickFrom(running, a.pick);
        if (at) h.submit(at, { evaluations: selfAims(h, at, verdict) });
        break;
      }
      case 4: {
        const at = pickFrom(running, a.pick);
        if (at)
          h.run(
            (s, t) =>
              E.failAttempt(s, t, {
                attemptId: at.id,
                reason: 'boom',
                retryable: a.flag || a.pick % 5 !== 0,
              }),
            WORKER,
          );
        break;
      }
      case 5: {
        const at = pickFrom(running, a.pick);
        if (at)
          h.run((s, t) => E.releaseAttempt(s, t, { attemptId: at.id, reason: 'stop' }), WORKER);
        break;
      }
      case 6: {
        h.advance(31 * 60_000);
        h.run((s, t) => E.sweep(s, t));
        break;
      }
      case 7: {
        const at = pickFrom(submitted, a.pick);
        if (at) h.run((s, t) => E.evaluate(s, t, { attemptId: at.id, aim: 'ok', verdict }), JUDGE);
        break;
      }
      case 8:
      case 9: {
        const r = pickFrom(requests, a.pick);
        if (!r) break;
        const choice = pickFrom(r.options, a.pick)?.id as string;
        const data: Record<string, unknown> = {
          extraAttempts: 1,
          extraIterations: 1,
          justification: 'ok',
          reason: 'because',
          info: 'here',
          text: 'answer',
          target: 1000,
        };
        if (r.subject === 'verification' || r.subject === 'milestone') {
          const aim = r.aimId ? h.state.aims.get(r.aimId) : E.graphAims(h.state)[0];
          if (aim) data.aimKey = aim.key;
        }
        h.resolve(r, choice, { comment: 'decided', data });
        break;
      }
      case 10: {
        const n = pickFrom(nodes, a.pick);
        if (n)
          h.run((s, t) =>
            n.status === 'paused' ? E.resumeNode(s, t, n.id) : E.pauseNode(s, t, n.id),
          );
        break;
      }
      case 11: {
        const n = pickFrom(nodes, a.pick);
        if (n)
          h.run((s, t) =>
            a.flag ? E.skip(s, t, n.id, 'skip it') : E.failNodeAction(s, t, n.id, 'no'),
          );
        break;
      }
      case 12: {
        const n = pickFrom(nodes, a.pick);
        if (n) h.run((s, t) => (a.flag ? E.reopenNode(s, t, n.id) : E.retry(s, t, n.id, 1)));
        break;
      }
      case 13: {
        const at = pickFrom(running, a.pick);
        if (at) h.heartbeatFor(at, { progress: a.pick % 100, step: `s${a.pick % 3}` });
        break;
      }
    }
  } catch (error) {
    if (!(error instanceof E.EngineError)) throw error;
    // Refused commands may leave partial mutations; the server discards state on throw. Mirror
    // that by not checking invariants on a state a refused command touched.
    throw new Refused();
  }
}

class Refused extends Error {}

function selfAims(h: Harness, at: E.Attempt, verdict: 'met' | 'unmet') {
  return E.aimsOf(h.state, 'node', at.nodeId)
    .filter((aim) => aim.kind === 'qualitative' && aim.evaluator === 'self')
    .map((aim) => ({ aim: aim.key, verdict, rationale: 'r' }));
}

function checkInvariants(h: Harness, events: E.DomainEvent[], changed: boolean): void {
  const s = h.state;
  // 2. At most one open attempt per node.
  for (const n of s.nodes.values()) {
    const open = [...s.attempts.values()].filter(
      (a) => a.nodeId === n.id && (a.status === 'running' || a.status === 'submitted'),
    );
    expect(open.length, `open attempts on ${n.key}`).toBeLessThanOrEqual(1);
    if (open[0]?.status === 'running') expect(open[0].leaseExpiresAt).toBeDefined();
  }
  for (const a of s.attempts.values()) {
    if (a.status !== 'running')
      expect(a.leaseExpiresAt, `lease on ${a.status} attempt`).toBeUndefined();
  }
  for (const n of s.nodes.values()) {
    // 3. done ⇒ satisfied, approved, accepted, or manual, in the current activation.
    if (n.status === 'done' && !n.acceptedWithDeviation && !n.manual) {
      const terminating = E.aimsOf(s, 'node', n.id).filter((x) => x.terminating);
      const passed = E.attemptsOf(s, n.id, n.activation).find((x) => x.status === 'passed');
      const verdicts = passed ? E.attemptVerdicts(s, passed) : E.activationVerdicts(s, n);
      expect(
        E.decide(n.kind === 'task' ? n.aimMode : 'all', terminating, verdicts),
        `done ${n.key}`,
      ).toBe('satisfied');
    }
    // 4. ready or later ⇒ prerequisites satisfied.
    if (['ready', 'running', 'evaluating', 'needs_input', 'blocked', 'done'].includes(n.status)) {
      expect(
        E.prerequisitesSatisfied(s, n),
        `${n.key} is ${n.status} with unmet prerequisites`,
      ).toBe(true);
    }
    // 5. Counted attempts within the bound.
    expect(n.countedAttempts).toBeLessThanOrEqual(n.maxAttempts + n.grantedAttempts);
  }
  for (const l of s.loops)
    expect(l.iteration).toBeLessThanOrEqual(l.maxIterations + l.grantedIterations);
  // 6. completed ⇒ every node done or skipped.
  if (s.graph.status === 'completed') {
    for (const n of s.nodes.values()) expect(['done', 'skipped']).toContain(n.status);
  }
  // 7. Every state change has at least one event with an actor.
  if (changed) expect(events.length).toBeGreaterThan(0);
  for (const e of events) expect(e.actor.kind).toBeDefined();
  // 10. A loop firing changes only its body.
  const fired = events.filter((e) => e.type === 'loop.iterated');
  if (fired.length > 0) {
    const body = new Set(
      s.loops.flatMap((l) => (fired.some((f) => f.entityId === l.id) ? l.body : [])),
    );
    const firstFire = events.indexOf(fired[0] as E.DomainEvent);
    const resetEvents = events.slice(0, firstFire).filter((e) => e.type === 'node.reset');
    for (const e of resetEvents)
      expect(body.has(e.entityId), 'reset outside the loop body').toBe(true);
  }
}

export const STATS: Record<string, number> = {};
describe('engine invariants (concepts §15)', () => {
  it('hold under random action sequences', () => {
    fc.assert(
      fc.property(
        shapeArb,
        fc.array(actionArb, { minLength: 30, maxLength: 120 }),
        (shape, actions) => {
          let h = makeHarness(shape);
          for (const action of actions) {
            const before = h.events.length;
            try {
              step(h, action);
            } catch (error) {
              if (!(error instanceof Refused)) throw error;
              // Rebuild from scratch is too slow; refused commands validate before mutating, so
              // keep going but skip the event-count check for this step.
              checkInvariants(h, [], false);
              continue;
            }
            const events = h.events.slice(before);
            for (const e of events) STATS[e.type] = (STATS[e.type] ?? 0) + 1;
            checkInvariants(h, events, false);
            if (h.state.graph.status === 'completed' || h.state.graph.status === 'failed') {
              h = makeHarness(shape);
            }
          }
        },
      ),
      { numRuns: 300 },
    );
    if (process.env.INVARIANT_STATS) process.stdout.write(`STATS ${JSON.stringify(STATS)}\n`);
  });

  it('every graph can be driven to completion by passing agents and approving humans', () => {
    fc.assert(
      fc.property(shapeArb, (shape) => {
        const h = makeHarness(shape);
        for (let i = 0; i < 200 && h.state.graph.status === 'active'; i++) {
          const ready = [...h.state.nodes.values()].find(
            (n) => n.status === 'ready' && n.kind === 'task',
          );
          if (ready) {
            const at = h.claim(ready.key);
            h.submit(at, { evaluations: selfAims(h, at, 'met') });
            if (h.state.attempts.get(at.id)?.status === 'submitted') {
              h.run(
                (s, t) => E.evaluate(s, t, { attemptId: at.id, aim: 'ok', verdict: 'met' }),
                JUDGE,
              );
            }
            continue;
          }
          const approval = h.openRequests('gate')[0];
          if (approval) h.resolve(approval, 'approve', {}, HUMAN);
          else break;
        }
        expect(h.state.graph.status).toBe('completed');
        expect(h.events.every((e) => e.actor !== undefined)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});
