import { AgentGraphsClient } from '@agent-graphs/sdk';
import { describe, expect, it } from 'vitest';
import { MCP_PROFILES, TOOLS, toolsFor } from '../src/index';
import { connectInMemory, resultText } from '../src/testing';

/** A client whose server always answers with the given error envelope. */
function failingClient(status: number, error: Record<string, unknown>) {
  return new AgentGraphsClient({
    baseUrl: 'http://stub.local',
    fetch: (async () =>
      new Response(JSON.stringify({ error }), {
        status,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch,
  });
}

const DOC_TOOLS = {
  any: ['graphs_list', 'graph_sitrep'],
  worker: [
    'node_briefing',
    'work_next',
    'node_claim',
    'attempt_heartbeat',
    'note_add',
    'metrics_report',
    'attempt_submit',
    'attempt_fail',
    'attempt_block',
    'attempt_release',
    'request_create',
    'directive_ack',
    'evaluations_pending',
    'aim_evaluate',
    'lesson_add',
    'lessons_search',
  ],
  orchestrator: [
    'graph_validate',
    'graph_create',
    'graph_mutate',
    'node_update',
    'node_control',
    'orchestrator_attach',
    'orchestrator_heartbeat',
    'orchestrator_detach',
    'orchestrator_queue',
    'request_resolve',
    'directive_send',
    'aim_waive',
    'audit_gaps',
  ],
  evolver: [
    'evolution_queue',
    'lessons_curate',
    'proposal_create',
    'proposal_validate',
    'eval_report',
  ],
};

describe('tool catalog', () => {
  it('matches docs/agent-protocol.md §7.1 exactly', () => {
    const all = Object.values(DOC_TOOLS).flat().sort();
    expect(TOOLS.map((t) => t.name).sort()).toEqual(all);
    for (const [group, names] of Object.entries(DOC_TOOLS))
      for (const name of names) expect(TOOLS.find((t) => t.name === name)?.group).toBe(group);
  });

  it('has LLM-friendly descriptions', () => {
    for (const t of TOOLS) {
      expect(t.description.length, t.name).toBeGreaterThan(40);
      expect(t.name).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });

  it('builds each profile from the documented groups', () => {
    const names = (p: (typeof MCP_PROFILES)[number]) => toolsFor(p).map((t) => t.name);
    expect(names('worker').sort()).toEqual([...DOC_TOOLS.any, ...DOC_TOOLS.worker].sort());
    expect(names('orchestrator').sort()).toEqual(
      [...DOC_TOOLS.any, ...DOC_TOOLS.worker, ...DOC_TOOLS.orchestrator].sort(),
    );
    expect(names('evolver').sort()).toEqual(
      [...DOC_TOOLS.any, ...DOC_TOOLS.worker, ...DOC_TOOLS.evolver].sort(),
    );
    expect(names('all')).toHaveLength(TOOLS.length);
  });
});

describe('MCP server over an in-memory transport', () => {
  it('lists tools per profile with JSON-schema inputs', async () => {
    for (const profile of MCP_PROFILES) {
      const client = await connectInMemory({
        client: failingClient(500, { code: 'X', message: 'x' }),
        profile,
      });
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(
        toolsFor(profile)
          .map((t) => t.name)
          .sort(),
      );
      const submit = tools.find((t) => t.name === 'attempt_submit');
      expect(submit?.inputSchema.required).toEqual(
        expect.arrayContaining(['attemptId', 'summary']),
      );
      await client.close();
    }
  });

  it('returns isError with the server code and hint', async () => {
    const client = await connectInMemory({
      client: failingClient(422, {
        code: 'AIM_EVIDENCE_MISSING',
        message: "Aim 'unit-tests' requires metric 'unit_test_pass_rate' before submit.",
        hint: 'Report it with POST /attempts/at_1/metrics.',
      }),
      profile: 'worker',
    });
    const r = await client.callTool({
      name: 'attempt_submit',
      arguments: { attemptId: 'at_1', summary: 'done' },
    });
    expect(r.isError).toBe(true);
    expect(resultText(r)).toContain('AIM_EVIDENCE_MISSING');
    expect(resultText(r)).toContain('Hint: Report it with');
    expect(r.structuredContent).toMatchObject({ error: { code: 'AIM_EVIDENCE_MISSING' } });
    await client.close();
  });

  it('explains endpoints this server does not implement yet', async () => {
    const client = await connectInMemory({
      client: failingClient(404, { code: 'NOT_FOUND', message: 'No route for GET /x.' }),
    });
    const r = await client.callTool({ name: 'evolution_queue', arguments: { graph: 'g' } });
    expect(r.isError).toBe(true);
    expect(resultText(r)).toContain('does not implement that endpoint yet');
    await client.close();
  });

  it('rejects incomplete argument combinations with a hint', async () => {
    const client = await connectInMemory({
      client: failingClient(500, { code: 'X', message: 'x' }),
    });
    const r = await client.callTool({ name: 'node_briefing', arguments: {} });
    expect(r.isError).toBe(true);
    expect(resultText(r)).toContain('BAD_REQUEST');
    await client.close();
  });

  it('serves prompts and the protocol resource', async () => {
    const client = await connectInMemory({
      client: failingClient(500, { code: 'X', message: 'x' }),
    });
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(['orchestrate', 'plan', 'review', 'work']);
    const work = await client.getPrompt({ name: 'work', arguments: { graph: 'notes-mvp' } });
    expect(JSON.stringify(work.messages)).toContain('work_next');
    const doc = await client.readResource({ uri: 'agent-graphs://docs/protocol' });
    expect(JSON.stringify(doc.contents)).toContain('Worker loop');
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate).sort()).toEqual([
      'agent-graphs://graphs/{id}/nodes/{key}/briefing',
      'agent-graphs://graphs/{id}/sitrep',
    ]);
    await client.close();
  });
});
