import { createApp } from '../src/app';
import type { Config } from '../src/config';

export type TestServer = ReturnType<typeof makeServer>;

/** An in-memory server with a controllable clock and a JSON request helper. */
export function makeServer(config: Partial<Config> = {}) {
  const clock = { now: Date.UTC(2026, 9, 2, 12) };
  const app = createApp({ config, now: () => clock.now });
  async function call<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: T; headers: Headers; text: string }> {
    const res = await app.request(
      path.startsWith('/api') || path.startsWith('/health') ? path : `/api/v1${path}`,
      {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        ...(body !== undefined
          ? { body: typeof body === 'string' ? body : JSON.stringify(body) }
          : {}),
      },
    );
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // markdown, yaml, ndjson
    }
    return { status: res.status, body: parsed as T, headers: res.headers, text };
  }
  return {
    app,
    clock,
    call,
    advance(ms: number) {
      clock.now += ms;
    },
  };
}

export const WORKER = {
  kind: 'agent',
  agent: 'backend-dev',
  model: 'claude-sonnet-5-5',
  thinking: 'medium',
  provider: 'anthropic',
  mechanism: 'claude-code',
  clientSessionId: 'cc-worker-1',
};

export const JUDGE = {
  kind: 'agent',
  agent: 'judge',
  model: 'claude-opus-5-5',
  mechanism: 'claude-code',
  clientSessionId: 'cc-judge-1',
};

export const MINIMAL_YAML = `
schema: agent-graphs/v1
title: Add dark mode
slug: dark-mode
aims:
  - key: shipped
    title: Dark mode ships
    evaluator: human
nodes:
  - key: implement
    title: Implement dark mode
    aim: Theme toggle with persisted preference
    purpose: Users asked for it
    prompt: Add a toggle and persist it.
    checklist:
      - { key: tests, title: Write tests, required: true }
    aims:
      - check: "test_pass_rate >= 1"
      - key: a11y
        title: Toggle is accessible
        evaluator: agent
  - key: review
    title: Design review
    kind: gate
    aim: A human approves both themes
    purpose: Visual quality
    needs: [implement]
    gate: { approver: human, instructions: Check contrast. }
loops:
  - key: review-cycle
    from: review
    to: implement
    maxIterations: 3
`;
