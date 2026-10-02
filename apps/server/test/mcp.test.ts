import { createMcpServer } from '@agent-graphs/mcp';
import { connectHttp, connectInMemory, resultText } from '@agent-graphs/mcp/testing';
import { AgentGraphsClient } from '@agent-graphs/sdk';
import { describe, expect, it } from 'vitest';
import { MINIMAL_YAML, makeServer, WORKER } from './helpers';

// biome-ignore lint/suspicious/noExplicitAny: structured tool results are loosely typed in tests
type Obj = Record<string, any>;

function sdk(s: ReturnType<typeof makeServer>) {
  return new AgentGraphsClient({
    baseUrl: 'http://test.local',
    fetch: ((input: string | URL | Request, init?: RequestInit) =>
      s.app.request(String(input), init)) as typeof fetch,
  });
}

async function call(client: Awaited<ReturnType<typeof connectInMemory>>, name: string, args: Obj) {
  const r = await client.callTool({ name, arguments: args });
  return { r, text: resultText(r), data: r.structuredContent as Obj, isError: r.isError };
}

describe('MCP tools against an in-memory server', () => {
  it('runs a full worker loop with error hints', async () => {
    const s = makeServer();
    const mcp = await connectInMemory({
      client: sdk(s),
      profile: 'all',
      actor: { model: 'claude-sonnet-5-5', mechanism: 'claude-code' },
      clientSessionId: () => 'cc-mcp-1',
    });
    const created = await call(mcp, 'graph_create', { spec: MINIMAL_YAML, start: true });
    expect(created.text).toContain('Created graph **dark-mode**');
    expect((await call(mcp, 'graphs_list', {})).text).toContain('dark-mode');

    const next = await call(mcp, 'work_next', { graph: 'dark-mode', actor: { agent: 'dev' } });
    expect(next.isError).toBeFalsy();
    const attemptId = next.data.attempt.id as string;
    expect(next.text).toContain(`attempt \`${attemptId}\``);
    expect(next.text).toContain('# Briefing · implement');
    expect(next.data.attempt.executor).toMatchObject({
      model: 'claude-sonnet-5-5',
      clientSessionId: 'cc-mcp-1',
      agent: 'dev',
    });

    const hb = await call(mcp, 'attempt_heartbeat', {
      attemptId,
      progress: 40,
      step: 'tests',
      checkpoint: { done: ['toggle'] },
    });
    expect(hb.text).toContain('Lease renewed');

    const early = await call(mcp, 'attempt_submit', { attemptId, summary: 'done' });
    expect(early.isError).toBe(true);
    expect(early.text).toContain('CHECKLIST_INCOMPLETE');
    expect(early.text).toContain('Hint:');

    await call(mcp, 'attempt_heartbeat', { attemptId, checklist: { tests: { done: true } } });
    const noMetric = await call(mcp, 'attempt_submit', { attemptId, summary: 'done' });
    expect(noMetric.data.error.code).toBe('AIM_EVIDENCE_MISSING');
    expect(noMetric.text).toContain('test_pass_rate');

    expect(
      (await call(mcp, 'metrics_report', { attemptId, metrics: { test_pass_rate: 1 } })).text,
    ).toContain('Recorded 1 metric');
    const proof = await call(mcp, 'note_add', {
      attemptId,
      type: 'proof',
      title: 'Tests 12/12',
      evidence: [{ kind: 'command', value: 'pnpm test', meta: { exitCode: 0 } }],
    });
    expect(proof.text).toMatch(/Recorded proof note `nt_/);

    const submit = await call(mcp, 'attempt_submit', { attemptId, summary: 'Toggle shipped.' });
    expect(submit.data.outcome).toBe('evaluating');
    expect(submit.text).toContain('Outcome: **evaluating**');

    // The worker's own session cannot judge its work; a distinct judge identity can.
    const self = await call(mcp, 'aim_evaluate', { attemptId, aim: 'a11y', verdict: 'met' });
    expect(self.isError).toBe(true);
    expect(self.data.error.code).toBe('POLICY_DENIED');
    const pending = await call(mcp, 'evaluations_pending', { graph: 'dark-mode' });
    expect(pending.text).toContain('No evaluations pending');
    const judged = await call(mcp, 'aim_evaluate', {
      attemptId,
      aim: 'a11y',
      verdict: 'met',
      rationale: 'Labelled and focusable',
      actor: { agent: 'judge', model: 'claude-opus-5-5' },
    });
    expect(judged.text).toContain('node implement is done');

    const sitrep = await call(mcp, 'graph_sitrep', { graph: 'dark-mode', budget: 1500 });
    expect(sitrep.text).toContain('dark-mode');
    const gaps = await call(mcp, 'audit_gaps', { graph: 'dark-mode' });
    expect(gaps.text).toContain('Done without proof: none');
    await mcp.close();
  });

  it('dispatches on behalf through an attached lead and resolves requests', async () => {
    const s = makeServer();
    const spec = MINIMAL_YAML.replace(
      'nodes:',
      'orchestrators:\n  - key: lead\n    name: Lead\n    capabilities: [dispatch, resolve, approve, mutate]\nnodes:',
    );
    await sdk(s).createGraph(spec, { start: true });
    const mcp = await connectInMemory({
      client: sdk(s),
      profile: 'orchestrator',
      actor: { model: 'claude-opus-5-5', mechanism: 'claude-code' },
      clientSessionId: () => 'cc-lead',
    });
    const attach = await call(mcp, 'orchestrator_attach', {
      graph: 'dark-mode',
      orchestrator: 'lead',
    });
    expect(attach.text).toContain('Attached as **lead**');
    expect(attach.text).toContain('dispatch');
    const leadSession = attach.data.session as string;

    const claim = await call(mcp, 'node_claim', {
      graph: 'dark-mode',
      node: 'implement',
      dispatchedBy: 'lead',
      actor: { agent: 'sub-1', model: 'claude-haiku-4-5' },
    });
    expect(claim.isError, claim.text).toBeFalsy();
    expect(claim.text).toContain('You are executing Agent Graphs attempt');
    expect(claim.data.attempt.executor.parentSessionId).toBe(leadSession);
    expect(claim.data.attempt.executor.clientSessionId).toBeUndefined();

    const question = await call(mcp, 'request_create', {
      graph: 'dark-mode',
      kind: 'question',
      title: 'Which storage key?',
      attemptId: claim.data.attempt.id,
    });
    const resolved = await call(mcp, 'request_resolve', {
      requestId: question.data.id,
      choice: 'answer',
      data: { text: 'Use "theme".' },
    });
    expect(resolved.isError, resolved.text).toBeFalsy();
    const hb = await call(mcp, 'attempt_heartbeat', { attemptId: claim.data.attempt.id });
    expect(hb.text).toContain('Answer: Which storage key?');

    const directive = await call(mcp, 'directive_send', {
      graph: 'dark-mode',
      target: { type: 'node', key: 'implement' },
      kind: 'guidance',
      title: 'Respect prefers-color-scheme',
    });
    expect(directive.text).toMatch(/Sent directive `dr_/);
    const mutate = await call(mcp, 'graph_mutate', {
      graph: 'dark-mode',
      addNodes: [
        {
          key: 'docs',
          title: 'Docs',
          aim: 'Docs exist',
          purpose: 'Users',
          prompt: 'Write docs',
          needs: ['review'],
          aims: ['Docs exist'],
        },
      ],
    });
    expect(mutate.text).toContain('Applied revision 2');
    const detach = await call(mcp, 'orchestrator_detach', {
      graph: 'dark-mode',
      orchestrator: 'lead',
      handoff: 'Dispatched implement to sub-1.',
    });
    expect(detach.text).toContain('Detached');
    await mcp.close();
  });

  it('serves the same tools over Streamable HTTP at /mcp', async () => {
    const s = makeServer();
    await sdk(s).createGraph(MINIMAL_YAML, { start: true });
    const fetchApp = ((input: string | URL | Request, init?: RequestInit) =>
      s.app.request(input instanceof Request ? input : String(input), init)) as typeof fetch;
    const mcp = await connectHttp('http://test.local/mcp?profile=worker', { fetch: fetchApp });
    const { tools } = await mcp.listTools();
    expect(tools.some((t) => t.name === 'work_next')).toBe(true);
    expect(tools.some((t) => t.name === 'graph_mutate')).toBe(false);
    const r = await mcp.callTool({
      name: 'work_next',
      arguments: { graph: 'dark-mode', actor: WORKER },
    });
    expect(resultText(r)).toContain('Claimed **implement**');
    const err = await mcp.callTool({
      name: 'attempt_heartbeat',
      arguments: { attemptId: 'at_missing' },
    });
    expect(err.isError).toBe(true);
    expect(resultText(err)).toContain('NOT_FOUND');
    await mcp.close();
  });

  it('requires a token on /mcp in token mode', async () => {
    const s = makeServer({ authMode: 'token' });
    const res = await s.app.request('/mcp', { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    expect(typeof createMcpServer).toBe('function');
  });
});
