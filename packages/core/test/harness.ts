/** A small driver for engine tests: build a graph from a spec object and run commands. */
import * as E from '../src/engine/index';
import type { ExecutionAnnotation } from '../src/schemas/common';
import { validateSpec } from '../src/spec/validate';

export const WORKER: ExecutionAnnotation = {
  kind: 'agent',
  agent: 'worker',
  model: 'claude-sonnet-5-5',
  sessionId: 'se_worker',
};
export const JUDGE: ExecutionAnnotation = { kind: 'agent', agent: 'judge', sessionId: 'se_judge' };
export const HUMAN: ExecutionAnnotation = { kind: 'human', agent: 'maintainer' };

type Obj = Record<string, unknown>;

/** A task node with a self-judged aim (override with `extra`). */
export function task(key: string, needs: string[] = [], extra: Obj = {}): Obj {
  return {
    key,
    title: `Task ${key}`,
    aim: `${key} is done`,
    purpose: 'test',
    prompt: `Do ${key}.`,
    needs,
    aims: [{ key: 'ok', title: `${key} works`, evaluator: 'self' }],
    ...extra,
  };
}

export function gate(key: string, needs: string[], extra: Obj = {}): Obj {
  return {
    key,
    title: `Gate ${key}`,
    kind: 'gate',
    aim: `${key} approved`,
    purpose: 'test',
    needs,
    gate: { approver: 'human', instructions: 'Look.' },
    ...extra,
  };
}

export function spec(nodes: Obj[], extra: Obj = {}): Obj {
  return { schema: 'agent-graphs/v1', title: 'Test graph', nodes, ...extra };
}

export class Harness {
  readonly ctx = E.testCtx();
  state: E.GraphState;
  events: E.DomainEvent[] = [];
  last: E.DomainEvent[] = [];

  constructor(value: Obj, options: { start?: boolean } = {}) {
    const result = validateSpec(value);
    if (!result.ok || !result.normalized) {
      throw new Error(`invalid spec: ${JSON.stringify(result.errors, null, 2)}`);
    }
    const tx = new E.Tx(this.ctx);
    this.state = E.buildGraph(result.normalized, tx);
    this.events.push(...tx.events);
    if (options.start !== false) this.run((s, t) => E.startGraph(s, t), HUMAN);
  }

  run<R>(fn: (state: E.GraphState, tx: E.Tx) => R, actor: ExecutionAnnotation = HUMAN): R {
    const out = E.run(this.state, { ...this.ctx, actor, now: this.ctx.now }, fn);
    this.last = out.events;
    this.events.push(...out.events);
    return out.result;
  }

  advance(ms: number): void {
    this.ctx.advance(ms);
  }

  node(key: string): E.Node {
    return E.nodeByKey(this.state, key);
  }

  status(key: string): string {
    return this.node(key).status;
  }

  statuses(): Record<string, string> {
    return Object.fromEntries([...this.state.nodes.values()].map((n) => [n.key, n.status]));
  }

  claim(key: string, actor: ExecutionAnnotation = WORKER, skills?: string[]): E.Attempt {
    return this.run(
      (s, t) => E.claim(s, t, { nodeId: this.node(key).id, actor, ...(skills ? { skills } : {}) }),
      actor,
    );
  }

  submit(attempt: E.Attempt, input: Partial<E.SubmitInput> = {}): E.SubmitResult {
    return this.run(
      (s, t) =>
        E.submit(s, t, {
          attemptId: attempt.id,
          summary: 'did it',
          evaluations: [{ aim: 'ok', verdict: 'met', rationale: 'works' }],
          ...input,
        }),
      attempt.executor,
    );
  }

  heartbeatFor(attempt: E.Attempt, input: Partial<E.HeartbeatInput> = {}): E.HeartbeatResult {
    return this.run(
      (s, t) => E.heartbeat(s, t, { attemptId: attempt.id, ...input }),
      attempt.executor,
    );
  }

  /** Claim and submit a passing self-judged attempt. */
  pass(key: string): E.SubmitResult {
    return this.submit(this.claim(key));
  }

  failAim(key: string): E.SubmitResult {
    return this.submit(this.claim(key), {
      evaluations: [{ aim: 'ok', verdict: 'unmet', rationale: 'broken' }],
    });
  }

  openRequests(subject?: string): E.HumanRequest[] {
    return [...this.state.requests.values()].filter(
      (r) => r.status === 'open' && (subject === undefined || r.subject === subject),
    );
  }

  resolve(
    request: E.HumanRequest,
    choice: string,
    extra: { comment?: string; data?: Obj } = {},
    actor = HUMAN,
  ): E.HumanRequest {
    return this.run((s, t) => E.resolveRequest(s, t, request.id, { choice, ...extra }), actor);
  }

  types(events = this.last): string[] {
    return events.map((e) => e.type);
  }
}

/** Assert an engine call throws an EngineError with this code. */
export function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof E.EngineError) return error.code;
    throw error;
  }
  return undefined;
}
