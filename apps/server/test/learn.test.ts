import { describe, expect, it } from 'vitest';
import { makeServer, WORKER } from './helpers';

// biome-ignore lint/suspicious/noExplicitAny: response payloads are loosely typed in tests
type Obj = Record<string, any>;

const SPEC = `
schema: agent-graphs/v1
title: Learn demo
slug: learn
evolution: { mode: learn }
nodes:
  - key: schema
    title: Schema
    aim: Tables exist
    purpose: p
    prompt: Create tables.
    aims: [{ key: ok, title: Works, evaluator: self }]
  - key: api
    title: API
    aim: Endpoints exist
    purpose: p
    prompt: Build the API.
    needs: [schema]
    aims: [{ key: ok, title: Works, evaluator: self }]
`;

describe('learn mode (E1)', () => {
  it('turns a fail→pass contrast into a lesson that later briefings apply', async () => {
    const s = makeServer();
    await s.call('POST', '/graphs?start=true', { format: 'yaml', spec: SPEC });
    const attempt = async (verdict: 'met' | 'unmet') => {
      const claim = await s.call<Obj>('POST', '/graphs/learn/nodes/schema/claim', {
        actor: WORKER,
      });
      return s.call<Obj>('POST', `/attempts/${claim.body.attempt.id}/submit`, {
        summary: verdict === 'met' ? 'Added the missing index' : 'Tables created',
        evaluations: [
          { aim: 'ok', verdict, rationale: verdict === 'met' ? 'ok' : 'missing index' },
        ],
      });
    };
    expect((await attempt('unmet')).body.outcome).toBe('failed');
    const passed = await attempt('met');
    expect(passed.body.outcome).toBe('passed');
    const dutyId = passed.body.lessonDuty?.id as string;
    expect(passed.body.lessonDuty.ask).toContain('lesson_add');

    const lesson = await s.call<Obj>(
      'POST',
      '/lessons',
      {
        scope: { nodeKey: 'api' },
        kind: 'pitfall',
        content: 'Check indexes on foreign keys before submitting.',
        dutyId,
      },
      { 'x-agent-session': passed.body.attempt.executor.sessionId },
    );
    expect(lesson.status, JSON.stringify(lesson.body)).toBe(201);
    expect(lesson.body.evidence.failedAttempts).toHaveLength(1);
    expect(lesson.body.scope.graph).toMatch(/^gr_/);

    const status = await s.call<Obj>('GET', '/graphs/learn/evolution');
    expect(status.body.duties[0].status).toBe('fulfilled');
    expect(status.body.lessons).toHaveLength(1);
    expect(status.body.metrics.firstPassYield).toBeLessThan(1);

    const claim = await s.call<Obj>('POST', '/graphs/learn/nodes/api/claim', {
      actor: WORKER,
      briefing: { budget: 6000 },
    });
    expect(claim.body.briefing).toContain('## Lessons & pitfalls');
    expect(claim.body.briefing).toContain('Check indexes on foreign keys');
    const applied = await s.call<Obj>('GET', '/lessons?graph=learn&node=api');
    expect(applied.body.items[0].counters.applied).toBe(1);

    await s.call('POST', `/attempts/${claim.body.attempt.id}/submit`, {
      summary: 'done',
      evaluations: [{ aim: 'ok', verdict: 'met' }],
    });
    const tagged = await s.call<Obj>('POST', `/lessons/${lesson.body.id}/tag`, {
      tag: 'helpful',
      attemptId: claim.body.attempt.id,
    });
    expect(tagged.body.lesson.counters.helpful).toBe(1);
    const revised = await s.call<Obj>('POST', `/lessons/${lesson.body.id}/revise`, {
      content: 'Index every foreign key.',
    });
    expect(revised.body.lesson.supersedes).toBe(lesson.body.id);
    expect(
      (await s.call<Obj>('GET', '/lessons?status=retired')).body.items.map((l: Obj) => l.id),
    ).toContain(lesson.body.id);
  });

  it('appends edge guidance with provenance, only in learn mode', async () => {
    const s = makeServer();
    await s.call('POST', '/graphs', { format: 'yaml', spec: SPEC });
    const view = await s.call<Obj>('GET', '/graphs/learn');
    const edge = view.body.edges[0];
    const first = await s.call<Obj>('POST', `/graphs/learn/edges/${edge.id}/attributes`, {
      guidance: 'Import types from the schema module',
    });
    expect(first.status).toBe(200);
    const second = await s.call<Obj>('POST', `/graphs/learn/edges/${edge.id}/attributes`, {
      guidance: 'Run migrations first',
      pitfalls: 'Do not rename columns',
    });
    expect(second.body.guidance).toBe('Import types from the schema module; Run migrations first');
    expect(second.body.attrProvenance.history).toHaveLength(2);
    const off = makeServer();
    await off.call('POST', '/graphs', {
      format: 'yaml',
      spec: SPEC.replace('evolution: { mode: learn }\n', ''),
    });
    const offEdge = (await off.call<Obj>('GET', '/graphs/learn')).body.edges[0];
    const denied = await off.call<Obj>('POST', `/graphs/learn/edges/${offEdge.id}/attributes`, {
      guidance: 'x',
    });
    expect(denied.status).toBe(403);
  });
});
