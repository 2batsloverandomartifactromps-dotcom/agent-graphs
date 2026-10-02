import { describe, expect, it } from 'vitest';
import { JUDGE, MINIMAL_YAML, makeServer, WORKER } from './helpers';

// biome-ignore lint/suspicious/noExplicitAny: response payloads are loosely typed in tests
type Obj = Record<string, any>;

async function created(s: ReturnType<typeof makeServer>, start = true) {
  const res = await s.call<Obj>('POST', `/graphs${start ? '?start=true' : ''}`, {
    format: 'yaml',
    spec: MINIMAL_YAML,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

describe('graph lifecycle over HTTP', () => {
  it('creates, claims, submits, judges, approves, verifies, and completes', async () => {
    const s = makeServer();
    const g = await created(s);
    expect(g.graph.status).toBe('active');
    expect(g.nodes.find((n: Obj) => n.key === 'implement').status).toBe('ready');

    const claim = await s.call<Obj>('POST', '/graphs/dark-mode/nodes/implement/claim', {
      actor: WORKER,
      briefing: { budget: 4000 },
    });
    expect(claim.status).toBe(201);
    const attemptId = claim.body.attempt.id as string;
    expect(claim.body.lease.ttlSeconds).toBe(1800);
    expect(claim.body.briefing).toContain(
      '# Briefing · implement · attempt 1 · loop review-cycle ↺ 1/3',
    );
    expect(claim.body.attempt.executor.model).toBe('claude-sonnet-5-5');
    expect(claim.body.attempt.startedAt).toMatch(/^2026-10-02T12:00/);

    const hb = await s.call<Obj>('POST', `/attempts/${attemptId}/heartbeat`, {
      progress: 50,
      step: 'tests',
      usage: { costUsd: 0.5 },
    });
    expect(hb.status).toBe(200);
    expect(hb.body.pauseRequested).toBe(false);

    const missing = await s.call<Obj>('POST', `/attempts/${attemptId}/submit`, { summary: 'done' });
    expect(missing.status).toBe(422);
    expect(missing.body.error.code).toBe('CHECKLIST_INCOMPLETE');
    expect(missing.body.error.hint).toContain('/checklist');

    await s.call('POST', `/attempts/${attemptId}/checklist`, { items: { tests: { done: true } } });
    const noMetric = await s.call<Obj>('POST', `/attempts/${attemptId}/submit`, {
      summary: 'done',
    });
    expect(noMetric.body.error.code).toBe('AIM_EVIDENCE_MISSING');
    expect(noMetric.body.error.hint).toContain('test_pass_rate');

    const submit = await s.call<Obj>('POST', `/attempts/${attemptId}/submit`, {
      summary: 'Toggle with persisted preference; tests pass.',
      metrics: { test_pass_rate: 1 },
      notes: [
        {
          type: 'proof',
          title: 'Tests 12/12',
          evidence: [{ kind: 'command', value: 'pnpm test', meta: { exitCode: 0 } }],
        },
      ],
    });
    expect(submit.status).toBe(200);
    expect(submit.body.outcome).toBe('evaluating');
    expect(submit.body.next).toContain("'a11y'");

    const selfJudge = await s.call<Obj>(
      'POST',
      `/attempts/${attemptId}/evaluations`,
      { aim: 'a11y', verdict: 'met' },
      { 'x-agent-session': claim.body.session },
    );
    expect(selfJudge.status).toBe(403);
    expect(selfJudge.body.error.code).toBe('POLICY_DENIED');

    const pending = await s.call<Obj>('GET', '/evaluations/pending', undefined, {});
    expect(pending.body.items).toHaveLength(1);

    const judge = await s.call<Obj>('POST', '/sessions', JUDGE);
    const verdict = await s.call<Obj>(
      'POST',
      `/attempts/${attemptId}/evaluations`,
      { aim: 'a11y', verdict: 'met', rationale: 'labelled, focusable' },
      { 'x-agent-session': judge.body.session.id },
    );
    expect(verdict.status).toBe(201);
    expect(verdict.body.node.status).toBe('done');

    const inbox = await s.call<Obj>('GET', '/requests?status=open');
    const gate = inbox.body.items.find((r: Obj) => r.subject === 'gate');
    expect(gate.graph.slug).toBe('dark-mode');
    const approve = await s.call<Obj>(
      'POST',
      `/requests/${gate.id}/resolve`,
      { choice: 'approve' },
      { 'x-actor-name': 'Maintainer' },
    );
    expect(approve.status).toBe(200);
    expect(approve.body.graph.status).toBe('verifying');

    const aimReq = (await s.call<Obj>('GET', '/requests')).body.items.find(
      (r: Obj) => r.subject === 'aim',
    );
    await s.call('POST', `/requests/${aimReq.id}/resolve`, { choice: 'approve' });
    const view = await s.call<Obj>('GET', '/graphs/dark-mode');
    expect(view.body.graph.status).toBe('completed');
    expect(view.headers.get('etag')).toMatch(/^"\d+"$/);

    const verify = await s.call<Obj>('GET', '/graphs/dark-mode/audit/verify');
    expect(verify.body.ok).toBe(true);
    expect(verify.body.events).toBeGreaterThan(15);

    const gaps = await s.call<Obj>('GET', '/graphs/dark-mode/audit/gaps');
    expect(gaps.body.doneWithoutProof).toEqual([]);

    const events = await s.call<Obj>('GET', '/graphs/dark-mode/events?types=attempt.*');
    expect(events.body.items.every((e: Obj) => e.type.startsWith('attempt.'))).toBe(true);
    const approval = (await s.call<Obj>('GET', '/graphs/dark-mode/events?types=request.resolved'))
      .body.items[0];
    expect(approval.actor).toMatchObject({ kind: 'human', agent: 'Maintainer' });
  });

  it('fires the loop when the gate is rejected and feeds the comment back', async () => {
    const s = makeServer();
    await created(s);
    const judge = (await s.call<Obj>('POST', '/sessions', JUDGE)).body.session.id;
    const pass = async () => {
      const claim = await s.call<Obj>('POST', '/graphs/dark-mode/nodes/implement/claim', {
        actor: WORKER,
      });
      const id = claim.body.attempt.id;
      await s.call('POST', `/attempts/${id}/checklist`, { items: { tests: { done: true } } });
      await s.call('POST', `/attempts/${id}/submit`, {
        summary: 's',
        metrics: { test_pass_rate: 1 },
      });
      await s.call(
        'POST',
        `/attempts/${id}/evaluations`,
        { aim: 'a11y', verdict: 'met' },
        { 'x-agent-session': judge },
      );
    };
    await pass();
    const gate = (await s.call<Obj>('GET', '/requests')).body.items.find(
      (r: Obj) => r.subject === 'gate',
    );
    const missingComment = await s.call<Obj>('POST', `/requests/${gate.id}/resolve`, {
      choice: 'reject',
    });
    expect(missingComment.status).toBe(400);
    await s.call('POST', `/requests/${gate.id}/resolve`, {
      choice: 'reject',
      comment: 'Contrast too low in dark mode',
    });
    const node = await s.call<Obj>('GET', '/graphs/dark-mode/nodes/implement');
    expect(node.body.status).toBe('ready');
    expect(node.body.activation).toBe(2);
    expect(node.body.loop).toEqual({ key: 'review-cycle', iteration: 2, max: 3 });
    const briefing = await s.call('GET', '/graphs/dark-mode/nodes/implement/briefing');
    expect(briefing.text).toContain('reviewer comment: Contrast too low in dark mode');
  });

  it('exports the spec, validates, clones, and mutates', async () => {
    const s = makeServer();
    await created(s, false);
    const yaml = await s.call('GET', '/graphs/dark-mode/spec');
    expect(yaml.headers.get('content-type')).toContain('yaml');
    expect(yaml.text).toContain('key: review-cycle');
    const bad = await s.call<Obj>('POST', '/graphs/validate', {
      format: 'yaml',
      spec: 'schema: agent-graphs/v1\ntitle: x\nnodes:\n  - key: a\n    title: A\n    promt: x',
    });
    expect(bad.body.ok).toBe(false);
    expect(bad.body.errors[0].hint).toContain('prompt');
    const clone = await s.call<Obj>('POST', '/graphs/dark-mode/clone', { title: 'Copy' });
    expect(clone.status).toBe(201);
    expect(clone.body.graph.slug).toBeUndefined();
    const mut = await s.call<Obj>('POST', '/graphs/dark-mode/mutations', {
      addNodes: [
        {
          key: 'docs',
          title: 'Docs',
          aim: 'Docs',
          purpose: 'p',
          prompt: 'Write docs',
          needs: ['review'],
          aims: ['Docs exist'],
        },
      ],
    });
    expect(mut.status, JSON.stringify(mut.body)).toBe(200);
    expect(mut.body.revision).toBe(2);
    const cycle = await s.call<Obj>('POST', '/graphs/dark-mode/mutations', {
      addEdges: [{ from: 'docs', to: 'implement' }],
    });
    expect(cycle.status).toBe(400);
    expect(cycle.body.error.code).toBe('VALIDATION_FAILED');
    const patch = await s.call<Obj>(
      'PATCH',
      '/graphs/dark-mode/nodes/implement',
      { prompt: 'New prompt' },
      { 'if-match': '"999"' },
    );
    expect(patch.status).toBe(409);
    const ok = await s.call<Obj>(
      'PATCH',
      '/graphs/dark-mode/nodes/implement',
      { prompt: 'New prompt' },
      { 'if-match': '"1"' },
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.node.prompt).toBe('New prompt');
    expect(ok.headers.get('etag')).toBe('"2"');
  });

  it('dispatches on behalf of a subagent through an attached orchestrator', async () => {
    const s = makeServer({ authMode: 'token' });
    const admin = s.app.ctx;
    const { issueToken } = await import('../src/auth');
    const adminToken = issueToken(admin, 'admin', 'admin').token;
    const agentToken = issueToken(admin, 'lead-agent', 'agent').token;
    const asAdmin = { authorization: `Bearer ${adminToken}` };
    const asAgent = { authorization: `Bearer ${agentToken}` };
    const spec = MINIMAL_YAML.replace(
      'nodes:',
      'orchestrators:\n  - key: lead\n    name: Lead\n    capabilities: [dispatch, resolve]\nnodes:',
    );
    const res = await s.call<Obj>('POST', '/graphs?start=true', { format: 'yaml', spec }, asAdmin);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await s.call<Obj>('GET', '/graphs')).status).toBe(401);
    const denied = await s.call<Obj>(
      'POST',
      '/graphs/dark-mode/nodes/implement/claim',
      { actor: WORKER, dispatchedBy: 'lead' },
      asAgent,
    );
    expect(denied.status).toBe(403);
    expect(denied.body.error.hint).toContain('attach');
    const attach = await s.call<Obj>(
      'POST',
      '/graphs/dark-mode/orchestrators/lead/attach',
      { actor: { agent: 'lead', model: 'claude-opus-5-5', clientSessionId: 'cc-lead' } },
      asAgent,
    );
    expect(attach.status, JSON.stringify(attach.body)).toBe(200);
    const leadSession = attach.body.session;
    expect(attach.body.queue.map((q: Obj) => q.kind)).toContain('dispatch');
    const claim = await s.call<Obj>(
      'POST',
      '/graphs/dark-mode/nodes/implement/claim',
      { actor: { agent: 'sub-1', model: 'claude-haiku-4-5' }, dispatchedBy: 'lead' },
      { ...asAgent, 'x-agent-session': leadSession },
    );
    expect(claim.status, JSON.stringify(claim.body)).toBe(201);
    expect(claim.body.attempt.dispatchedBy.orchestratorKey).toBe('lead');
    expect(claim.body.attempt.executor.parentSessionId).toBe(leadSession);
    // A session heartbeat from the lead renews the subagent's lease.
    s.advance(20 * 60_000);
    const hb = await s.call<Obj>('POST', `/sessions/${leadSession}/heartbeat`, {}, asAgent);
    expect(hb.body.attempts).toHaveLength(1);
    expect(hb.body.attempts[0].leaseExpiresAt).toBe(new Date(s.clock.now + 1800_000).toISOString());
    const second = await s.call<Obj>(
      'POST',
      '/graphs/dark-mode/orchestrators/lead/attach',
      { actor: { agent: 'other', clientSessionId: 'cc-other' } },
      asAgent,
    );
    expect(second.status).toBe(409);
  });
});

describe('errors, idempotency, SSE, and meta', () => {
  it('uses the error envelope with hints', async () => {
    const s = makeServer();
    const missing = await s.call<Obj>('GET', '/graphs/nope');
    expect(missing.status).toBe(404);
    expect(missing.body.error).toMatchObject({ code: 'NOT_FOUND' });
    expect(missing.body.error.hint).toBeTruthy();
    const invalid = await s.call<Obj>('POST', '/graphs', { spec: 42 });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('VALIDATION_FAILED');
    const route = await s.call<Obj>('GET', '/nothing-here');
    expect(route.status).toBe(404);
    const closed = await s.call<Obj>('POST', '/attempts/at_missing/heartbeat', {});
    expect(closed.status).toBe(404);
  });

  it('replays idempotent POSTs and rejects key reuse with a different body', async () => {
    const s = makeServer();
    await created(s);
    const headers = { 'idempotency-key': 'k-1' };
    const body = { actor: WORKER };
    const first = await s.call<Obj>(
      'POST',
      '/graphs/dark-mode/nodes/implement/claim',
      body,
      headers,
    );
    const again = await s.call<Obj>(
      'POST',
      '/graphs/dark-mode/nodes/implement/claim',
      body,
      headers,
    );
    expect(again.status).toBe(201);
    expect(again.headers.get('idempotent-replay')).toBe('true');
    expect(again.body.attempt.id).toBe(first.body.attempt.id);
    const mismatch = await s.call<Obj>(
      'POST',
      '/graphs/dark-mode/nodes/implement/claim',
      { actor: JUDGE },
      headers,
    );
    expect(mismatch.status).toBe(422);
  });

  it('streams events and replays from Last-Event-ID', async () => {
    const s = makeServer();
    await created(s);
    const controller = new AbortController();
    const res = await s.app.request('/api/v1/graphs/dark-mode/events/stream', {
      headers: { 'last-event-id': '1' },
      signal: controller.signal,
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let text = '';
    while (!text.includes('graph.started'))
      text += new TextDecoder().decode((await reader.read()).value);
    expect(text).toMatch(/event: graph\.started\ndata: .*\nid: \d+/);
    expect(text).not.toContain('id: 1\n');
    controller.abort();
    await reader.cancel().catch(() => {});
  });

  it('serves health, OpenAPI, vocab, and the spec schema', async () => {
    const s = makeServer();
    expect((await s.call<Obj>('GET', '/health')).body.ok).toBe(true);
    const doc = await s.call<Obj>('GET', '/openapi.json');
    expect(doc.body.openapi).toBe('3.1.0');
    expect(Object.keys(doc.body.paths).length).toBeGreaterThan(60);
    expect(doc.body.paths['/api/v1/attempts/{attempt}/submit'].post.requestBody).toBeDefined();
    expect((await s.call<Obj>('GET', '/vocab')).body.models.length).toBeGreaterThan(3);
    expect((await s.call<Obj>('GET', '/schema/graph-spec.json')).body.title).toContain(
      'agent-graphs/v1',
    );
    expect((await s.call<Obj>('GET', '/me')).body).toMatchObject({
      role: 'admin',
      authMode: 'local',
    });
  });
});
