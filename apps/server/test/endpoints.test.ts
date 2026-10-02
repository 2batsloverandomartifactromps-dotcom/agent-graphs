/** Broad endpoint coverage: every route group, the happy path plus key refusals. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sweepOnce } from '../src/jobs';
import { JUDGE, makeServer, WORKER } from './helpers';

// biome-ignore lint/suspicious/noExplicitAny: response payloads are loosely typed in tests
type Obj = Record<string, any>;

const notesApp = readFileSync(
  resolve(import.meta.dirname, '../../../examples/graphs/notes-app.yaml'),
  'utf8',
);

async function notes(s: ReturnType<typeof makeServer>) {
  const res = await s.call<Obj>('POST', '/graphs?start=true', { format: 'yaml', spec: notesApp });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

describe('graph endpoints', () => {
  it('lists, filters, sorts, and summarizes', async () => {
    const s = makeServer();
    await notes(s);
    await s.call('POST', '/graphs', {
      spec: {
        schema: 'agent-graphs/v1',
        title: 'Second',
        nodes: [{ key: 'a', title: 'A', aim: 'a', purpose: 'p', prompt: 'x', aims: ['A works'] }],
      },
    });
    expect((await s.call<Obj>('GET', '/graphs')).body.items).toHaveLength(2);
    expect((await s.call<Obj>('GET', '/graphs?status=active')).body.items).toHaveLength(1);
    expect((await s.call<Obj>('GET', '/graphs?q=notes')).body.items[0].slug).toBe('notes-mvp');
    expect((await s.call<Obj>('GET', '/graphs?sort=title')).body.items[0].title).toBe(
      'Notes app — MVP build',
    );
    for (const sort of ['created', 'progress'])
      expect((await s.call<Obj>('GET', `/graphs?sort=${sort}`)).status).toBe(200);
    const stats = await s.call<Obj>('GET', '/graphs/notes-mvp/stats');
    expect(stats.body.counts.ready).toBe(1);
    const sitrep = await s.call<Obj>('GET', '/graphs/notes-mvp/sitrep?format=json');
    expect(sitrep.body.suggestions[0]).toMatch(/^Dispatch/);
    const nodes = await s.call<Obj>('GET', '/graphs/notes-mvp/nodes?status=pending&kind=gate');
    expect(nodes.body.items.every((n: Obj) => n.kind === 'gate')).toBe(true);
    const node = await s.call<Obj>('GET', '/graphs/notes-mvp/nodes/implement-api');
    expect(node.body.needs[0].guidance).toContain('Import entity types');
    expect((await s.call<Obj>('GET', '/graphs/notes-mvp/aims')).body.graph).toHaveLength(3);
    expect((await s.call<Obj>('GET', '/graphs/notes-mvp/loops')).body.items).toHaveLength(2);
    const preview = await s.call(
      'GET',
      '/graphs/notes-mvp/nodes/implement-api/briefing?budget=3000&protocol=false',
    );
    expect(preview.text).not.toContain('## Protocol');
    expect(
      (await s.call<Obj>('GET', '/graphs/notes-mvp/nodes/implement-api/briefing?format=json')).body
        .sections.length,
    ).toBeGreaterThan(5);
    const json = await s.call<Obj>('GET', '/graphs/notes-mvp/spec?format=json');
    expect(json.body.nodes).toHaveLength(16);
    const audit = await s.call('GET', '/graphs/notes-mvp/audit/export');
    expect(audit.text.split('\n')[0]).toContain('"kind":"spec"');
  });

  it('runs lifecycle actions, deletes drafts, and archives', async () => {
    const s = makeServer();
    await notes(s);
    for (const action of ['pause', 'resume', 'cancel']) {
      const res = await s.call<Obj>('POST', `/graphs/notes-mvp/${action}`, { reason: 'test' });
      expect(res.status, `${action}: ${JSON.stringify(res.body)}`).toBe(200);
    }
    expect(
      (await s.call<Obj>('POST', '/graphs/notes-mvp/archive', {})).body.graph.archivedAt,
    ).toBeTruthy();
    expect((await s.call<Obj>('GET', '/graphs')).body.items).toHaveLength(0);
    expect((await s.call<Obj>('GET', '/graphs?archived=true')).body.items).toHaveLength(1);
    await s.call('POST', '/graphs/notes-mvp/unarchive', {});
    expect((await s.call<Obj>('DELETE', '/graphs/notes-mvp')).status).toBe(409);
    const draft = await s.call<Obj>('POST', '/graphs/notes-mvp/clone', {});
    expect((await s.call<Obj>('DELETE', `/graphs/${draft.body.graph.id}`)).status).toBe(200);
    const patched = await s.call<Obj>(
      'PATCH',
      '/graphs/notes-mvp',
      { description: 'Updated' },
      { 'if-match': '"999"' },
    );
    expect(patched.status).toBe(409);
  });

  it('records graph metrics, notes, and events', async () => {
    const s = makeServer();
    await notes(s);
    await s.call('POST', '/graphs/notes-mvp/metrics', { metrics: { e2e_pass_rate: 0.5 } });
    expect(
      (await s.call<Obj>('GET', '/graphs/notes-mvp/metrics?name=e2e_pass_rate')).body.items[0]
        .value,
    ).toBe(0.5);
    const note = await s.call<Obj>('POST', '/graphs/notes-mvp/notes', {
      type: 'decision',
      title: 'Use SQLite',
      body: 'Simple to run.',
    });
    expect(note.status).toBe(201);
    expect(
      (await s.call<Obj>('GET', '/graphs/notes-mvp/notes?type=decision')).body.items,
    ).toHaveLength(1);
    const nodeNote = await s.call<Obj>('POST', '/graphs/notes-mvp/nodes/requirements/notes', {
      type: 'comment',
      title: 'Remember mobile',
    });
    expect(nodeNote.body.nodeId).toMatch(/^nd_/);
    expect(
      (await s.call<Obj>('GET', '/graphs/notes-mvp/nodes/requirements/notes')).body.items,
    ).toHaveLength(1);
    const ev = await s.call<Obj>('GET', '/graphs/notes-mvp/events?limit=5');
    expect(ev.body.items).toHaveLength(5);
    const after = await s.call<Obj>('GET', `/graphs/notes-mvp/events?after=${ev.body.nextCursor}`);
    expect(after.body.items[0].seq).toBeGreaterThan(ev.body.nextCursor);
  });
});

describe('node and attempt endpoints', () => {
  it('covers node actions and attempt calls', async () => {
    const s = makeServer();
    await notes(s);
    const claim = await s.call<Obj>('POST', '/graphs/notes-mvp/nodes/requirements/claim', {
      actor: WORKER,
    });
    const id = claim.body.attempt.id;
    expect((await s.call<Obj>('GET', `/attempts/${id}`)).body.lease.active).toBe(true);
    expect((await s.call('GET', `/attempts/${id}/briefing`)).text).toContain(`attempt id ${id}`);
    expect((await s.call<Obj>('GET', `/attempts/${id}/briefing?format=json`)).body.format).toBe(
      'json',
    );
    expect(
      (await s.call<Obj>('POST', `/attempts/${id}/metrics`, { metrics: { words: 1200 } })).body
        .recorded,
    ).toBe(1);
    expect(
      (await s.call<Obj>('POST', `/attempts/${id}/metrics`, [{ name: 'pages', value: 3 }])).body
        .recorded,
    ).toBe(1);
    const q = await s.call<Obj>('POST', `/attempts/${id}/notes`, {
      type: 'question',
      title: 'Include offline mode?',
      assignee: 'human',
    });
    expect(q.status).toBe(201);
    const question = (await s.call<Obj>('GET', '/requests?kind=question')).body.items[0];
    await s.call('POST', `/requests/${question.id}/resolve`, {
      choice: 'answer',
      data: { text: 'No, out of scope.' },
    });
    const directives = await s.call<Obj>('GET', `/attempts/${id}/directives`);
    expect(directives.body.items[0]).toMatchObject({ kind: 'answer', body: 'No, out of scope.' });
    const hb = await s.call<Obj>('POST', `/attempts/${id}/heartbeat`, {});
    expect(hb.body.directives).toHaveLength(1);
    await s.call('POST', `/directives/${directives.body.items[0].id}/ack`, {
      attemptId: id,
      note: 'dropped offline mode',
    });
    expect((await s.call<Obj>('GET', '/graphs/notes-mvp/directives')).body.items[0].status).toBe(
      'acknowledged',
    );
    await s.call('POST', `/attempts/${id}/release`, {
      reason: 'context full',
      handoff: 'Half done',
    });
    const again = await s.call<Obj>('POST', '/graphs/notes-mvp/nodes/requirements/claim', {
      actor: WORKER,
    });
    await s.call('POST', `/attempts/${again.body.attempt.id}/fail`, { reason: 'tooling broken' });
    const third = await s.call<Obj>('POST', '/graphs/notes-mvp/nodes/requirements/claim', {
      actor: WORKER,
    });
    const blocked = await s.call<Obj>('POST', `/attempts/${third.body.attempt.id}/block`, {
      reason: 'need access',
      request: { title: 'Need repo access' },
    });
    expect(blocked.body.node.status).toBe('blocked');
    await s.call('POST', `/requests/${blocked.body.request.id}/resolve`, {
      choice: 'unblock',
      data: { info: 'granted' },
    });
    for (const [action, body] of [
      ['pause', {}],
      ['resume', {}],
      ['skip', { reason: 'covered elsewhere' }],
      ['reopen', {}],
    ] as const) {
      const res = await s.call<Obj>('POST', `/graphs/notes-mvp/nodes/requirements/${action}`, body);
      expect(res.status, `${action}: ${JSON.stringify(res.body)}`).toBe(200);
    }
    const manual = await s.call<Obj>(
      'POST',
      '/graphs/notes-mvp/nodes/requirements/complete-manually',
      {
        summary: 'Written by a human',
        notes: [{ type: 'proof', title: 'docs/requirements.md' }],
      },
    );
    expect(manual.status, JSON.stringify(manual.body)).toBe(200);
    expect(manual.body.node.manual).toBe(true);
    expect(
      (await s.call<Obj>('GET', '/graphs/notes-mvp/nodes/requirements/attempts')).body.items.length,
    ).toBeGreaterThan(3);
    const archClaim = await s.call<Obj>('POST', '/graphs/notes-mvp/nodes/architecture/claim', {
      actor: WORKER,
    });
    await s.call('POST', `/attempts/${archClaim.body.attempt.id}/submit`, {
      summary: 'doc',
      evaluations: [{ aim: 'every-major-choice-has-a-decision-note', verdict: 'met' }],
    });
    const arch = await s.call<Obj>('GET', '/graphs/notes-mvp/nodes/architecture');
    const reviewAim = arch.body.aims.find((a: Obj) => a.evaluator === 'orchestrator').key;
    const waive = await s.call<Obj>(
      'POST',
      `/graphs/notes-mvp/nodes/architecture/aims/${reviewAim}/waive`,
      { justification: 'Reviewed live' },
    );
    expect(waive.body.node.status).toBe('done');
    const retry = await s.call<Obj>('POST', '/graphs/notes-mvp/nodes/architecture/retry', {
      extraAttempts: 1,
    });
    expect(retry.status).toBe(409);
    expect(
      (await s.call<Obj>('POST', '/graphs/notes-mvp/nodes/architecture/fail', { reason: 'x' }))
        .status,
    ).toBe(409);
  });

  it('lets reviewers pick work with next and judges graph aims', async () => {
    const s = makeServer();
    await notes(s);
    const claim = await s.call<Obj>('POST', '/graphs/notes-mvp/next', {
      actor: WORKER,
      claim: true,
    });
    expect(claim.body.node.key).toBe('requirements');
    const none = await s.call<Obj>('POST', '/graphs/notes-mvp/next', { actor: WORKER });
    expect(none.body.node).toBeNull();
    expect(none.body.running[0].key).toBe('requirements');
    const judge = await s.call<Obj>('POST', '/graphs/notes-mvp/next', {
      actor: JUDGE,
      role: 'reviewer',
    });
    expect(judge.body.attempt).toBeNull();
  });
});

describe('structure, orchestrators, inbox, notes, sessions, tokens', () => {
  it('edits edges and loops, runs orchestrators, and manages the inbox', async () => {
    const s = makeServer();
    const g = await notes(s);
    const edge = g.edges.find((e: Obj) => e.from === 'db-schema' && e.to === 'implement-api');
    expect(
      (
        await s.call<Obj>('PATCH', `/graphs/notes-mvp/edges/${edge.id}`, {
          pitfalls: 'Keep column names',
          label: null,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await s.call<Obj>('POST', '/graphs/notes-mvp/edges', {
          from: 'docs',
          to: 'security-audit',
          kind: 'informs',
        })
      ).status,
    ).toBe(201);
    const informs = (await s.call<Obj>('GET', '/graphs/notes-mvp')).body.edges.find(
      (e: Obj) => e.from === 'docs' && e.to === 'security-audit',
    );
    expect((await s.call<Obj>('DELETE', `/graphs/notes-mvp/edges/${informs.id}`)).status).toBe(200);
    expect(
      (await s.call<Obj>('PATCH', '/graphs/notes-mvp/loops/api-fix-cycle', { maxIterations: 5 }))
        .body.changes,
    ).toContain('updated loop api-fix-cycle');
    expect(
      (
        await s.call<Obj>('POST', '/graphs/notes-mvp/loops/api-fix-cycle/extend', {
          extraIterations: 1,
        })
      ).body.loop.grantedIterations,
    ).toBe(1);
    expect((await s.call<Obj>('GET', '/graphs/notes-mvp/orchestrators')).body.items).toHaveLength(
      3,
    );
    const attach = await s.call<Obj>('POST', '/graphs/notes-mvp/orchestrators/lead/attach', {
      actor: { agent: 'lead', clientSessionId: 'cc-lead' },
    });
    const lead = { 'x-agent-session': attach.body.session };
    expect(
      (await s.call<Obj>('POST', '/graphs/notes-mvp/orchestrators/lead/heartbeat', {}, lead)).body
        .leaseExpiresAt,
    ).toBeTruthy();
    expect(
      (await s.call<Obj>('GET', '/graphs/notes-mvp/orchestrators/lead/queue')).body.items.length,
    ).toBeGreaterThan(0);
    expect(
      (
        await s.call<Obj>(
          'POST',
          '/graphs/notes-mvp/orchestrators/lead/notes',
          { type: 'decision', title: 'Parallelize UI' },
          lead,
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await s.call<Obj>(
          'POST',
          '/graphs/notes-mvp/orchestrators/lead/detach',
          { handoff: 'Dispatched requirements' },
          lead,
        )
      ).body.orchestrator.status,
    ).toBe('idle');
    for (const action of ['pause', 'resume', 'stop']) {
      expect(
        (await s.call<Obj>('POST', `/graphs/notes-mvp/orchestrators/reviewer/${action}`)).status,
      ).toBe(200);
    }
    expect(
      (
        await s.call<Obj>('POST', '/graphs/notes-mvp/orchestrators', {
          key: 'qa',
          name: 'QA',
          capabilities: ['evaluate'],
        })
      ).status,
    ).toBe(201);
    expect(
      (await s.call<Obj>('PATCH', '/graphs/notes-mvp/orchestrators/qa', { name: 'QA bot' })).body
        .changes,
    ).toContain('updated orchestrator qa');
    const dir = await s.call<Obj>('POST', '/graphs/notes-mvp/directives', {
      target: { type: 'node', key: 'requirements' },
      kind: 'guidance',
      title: 'Mention GDPR',
    });
    expect(dir.status).toBe(201);
    expect(
      (
        await s.call<Obj>('POST', '/graphs/notes-mvp/directives', {
          target: { type: 'attempt' },
          kind: 'guidance',
          title: 'x',
        })
      ).status,
    ).toBe(400);
    const raised = await s.call<Obj>('POST', '/graphs/notes-mvp/requests', {
      kind: 'question',
      title: 'Which region?',
      node: 'deploy',
    });
    expect(raised.status).toBe(201);
    expect(
      (await s.call<Obj>('POST', `/requests/${raised.body.id}/dismiss`, { reason: 'duplicate' }))
        .body.request.status,
    ).toBe('dismissed');
    expect((await s.call<Obj>('GET', '/requests?status=dismissed')).body.items).toHaveLength(1);
  });

  it('searches, retracts, and resolves notes; manages sessions and tokens; sweeps', async () => {
    const s = makeServer();
    await notes(s);
    const claim = await s.call<Obj>('POST', '/graphs/notes-mvp/nodes/requirements/claim', {
      actor: WORKER,
    });
    const id = claim.body.attempt.id;
    const finding = await s.call<Obj>('POST', `/attempts/${id}/notes`, {
      type: 'finding',
      severity: 'high',
      title: 'Refresh tokens are not rotated',
      body: 'Security risk in auth flow',
    });
    expect((await s.call<Obj>('GET', '/notes?q=rotated')).body.items.map((n: Obj) => n.id)).toEqual(
      [finding.body.id],
    );
    expect(
      (await s.call<Obj>('GET', '/notes?graph=notes-mvp&severity=high&model=claude-sonnet-5-5'))
        .body.items,
    ).toHaveLength(1);
    expect(
      (await s.call<Obj>('GET', '/notes?graph=notes-mvp&node=requirements&type=finding')).body
        .items,
    ).toHaveLength(1);
    expect(
      (await s.call<Obj>('GET', '/graphs/notes-mvp/audit/gaps')).body.openHighFindings,
    ).toHaveLength(1);
    const resolved = await s.call<Obj>('POST', `/notes/${finding.body.id}/resolve`, {
      comment: 'Rotation added in auth.ts',
    });
    expect(resolved.body.finding.resolvedAt).toBeTruthy();
    expect(
      (await s.call<Obj>('POST', `/notes/${finding.body.id}/resolve`, { comment: 'again' })).status,
    ).toBe(409);
    const progress = await s.call<Obj>('POST', `/attempts/${id}/notes`, {
      type: 'progress',
      title: 'Halfway',
    });
    expect(
      (await s.call<Obj>('POST', `/notes/${progress.body.id}/retract`, { reason: 'wrong attempt' }))
        .body.retractedReason,
    ).toBe('wrong attempt');
    expect(
      (await s.call<Obj>('POST', `/notes/${progress.body.id}/retract`, { reason: 'again' })).status,
    ).toBe(409);

    const sessions = await s.call<Obj>('GET', '/sessions?status=active');
    expect(sessions.body.items.length).toBeGreaterThan(0);
    const sid = claim.body.session;
    expect(
      (await s.call<Obj>('GET', '/sessions?graph=notes-mvp')).body.items.map((x: Obj) => x.id),
    ).toContain(sid);
    expect(
      (await s.call<Obj>('PATCH', `/sessions/${sid}`, { model: 'claude-opus-5-5' })).body.session
        .model,
    ).toBe('claude-opus-5-5');
    expect(
      (await s.call<Obj>('POST', '/sessions/by-client/cc-worker-1/heartbeat', {})).body.attempts,
    ).toHaveLength(1);
    expect(
      (await s.call<Obj>('POST', '/sessions/by-client/unknown/heartbeat', {})).body.session,
    ).toBeNull();
    expect(
      (await s.call<Obj>('POST', `/sessions/${sid}/events`, { type: 'compacted' })).body.ok,
    ).toBe(true);
    expect((await s.call<Obj>('POST', `/sessions/${sid}/end`, {})).body.ok).toBe(true);

    const token = await s.call<Obj>('POST', '/tokens', { name: 'ci', role: 'viewer' });
    expect(token.body.token).toMatch(/^ag_/);
    expect((await s.call<Obj>('GET', '/tokens')).body.items).toHaveLength(1);
    expect(
      (await s.call<Obj>('GET', '/me', undefined, { authorization: `Bearer ${token.body.token}` }))
        .body.role,
    ).toBe('viewer');
    expect(
      (
        await s.call<Obj>(
          'POST',
          '/graphs/notes-mvp/pause',
          {},
          { authorization: `Bearer ${token.body.token}` },
        )
      ).status,
    ).toBe(403);
    expect((await s.call<Obj>('DELETE', `/tokens/${token.body.id}`)).status).toBe(200);
    expect(
      (await s.call<Obj>('GET', '/me', undefined, { authorization: `Bearer ${token.body.token}` }))
        .status,
    ).toBe(401);
    expect(
      (await s.call<Obj>('PUT', '/vocab', { models: { 'my-model': { name: 'Mine' } } })).body
        .overrides.models,
    ).toBeTruthy();

    s.advance(31 * 60_000);
    const swept = sweepOnce(s.app.ctx);
    expect(swept.expired).toBe(1);
    expect((await s.call<Obj>('GET', `/attempts/${id}`)).body.attempt.status).toBe('abandoned');
  });
});
