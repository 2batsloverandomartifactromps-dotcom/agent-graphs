import { AgentGraphsClient, AgentGraphsError, type LiveEvent } from '@agent-graphs/sdk';
import { describe, expect, it } from 'vitest';
import { MINIMAL_YAML, makeServer, WORKER } from './helpers';

function client(s: ReturnType<typeof makeServer>, extra: Record<string, string> = {}) {
  return new AgentGraphsClient({
    baseUrl: 'http://test.local',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
      s.app.request(String(input), init)) as typeof fetch,
    ...extra,
  });
}

describe('sdk against the server', () => {
  it('drives a worker loop and surfaces hints in errors', async () => {
    const s = makeServer();
    const c = client(s);
    expect((await c.health()).ok).toBe(true);
    const g = await c.createGraph(MINIMAL_YAML, { start: true });
    expect(g.graph.slug).toBe('dark-mode');
    const next = await c.next('dark-mode', {
      actor: WORKER,
      claim: true,
      briefing: { budget: 3000 },
    });
    expect(next.node?.key).toBe('implement');
    const attempt = next.attempt?.id as string;
    expect(typeof next.briefing).toBe('string');
    await c.heartbeat(attempt, { progress: 10 });
    try {
      await c.submit(attempt, { summary: 'x' });
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(AgentGraphsError);
      expect((error as AgentGraphsError).code).toBe('CHECKLIST_INCOMPLETE');
      expect((error as AgentGraphsError).describe()).toContain('Hint:');
    }
    await c.checklist(attempt, { tests: { done: true } });
    const out = await c.submit(attempt, { summary: 'done', metrics: { test_pass_rate: 1 } });
    expect(out.outcome).toBe('evaluating');
    const spec = await c.exportSpec('dark-mode');
    expect(spec).toContain('review-cycle');
  });

  it('subscribes to live events', async () => {
    const s = makeServer();
    const c = client(s);
    await c.createGraph(MINIMAL_YAML);
    const seen: LiveEvent[] = [];
    const stop = c.subscribe({ graph: 'dark-mode', onEvent: (e) => seen.push(e) });
    await new Promise((r) => setTimeout(r, 50));
    await c.graphAction('dark-mode', 'start');
    for (let i = 0; i < 50 && !seen.some((e) => e.type === 'graph.started'); i++)
      await new Promise((r) => setTimeout(r, 20));
    stop();
    const started = seen.find((e) => e.type === 'graph.started');
    expect(started?.snapshot).toMatchObject({ status: 'active' });
  });
});
