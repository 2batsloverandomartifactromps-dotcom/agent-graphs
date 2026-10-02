import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { harness, MINIMAL } from './helpers';

const WITH_LEAD = MINIMAL.replace(
  'nodes:',
  'orchestrators:\n  - { key: lead, name: Lead, role: lead, capabilities: [dispatch, resolve, approve, mutate] }\nnodes:',
);

describe('agraph command set', () => {
  it('has every documented command (docs/agent-protocol.md §7.2)', async () => {
    const h = harness();
    const help = await h.run(['--help']);
    expect(help.code).toBe(0);
    for (const cmd of [
      'serve',
      'health',
      'mcp',
      'login',
      'graphs',
      'graph',
      'sitrep',
      'next',
      'work',
      'claim',
      'brief',
      'node',
      'hb',
      'note',
      'metric',
      'submit',
      'fail',
      'block',
      'release',
      'attempt',
      'ask',
      'inbox',
      'resolve',
      'directive',
      'ack',
      'orch|orchestrator',
      'token',
      'hook',
      'claude',
      'db',
      'simulate',
    ])
      expect(help.stdout).toMatch(new RegExp(`\\n  ${cmd.replace('|', '\\|')}\\b`));
    const sub = async (args: string[], names: string[]) => {
      const r = await h.run([...args, '--help']);
      for (const n of names)
        expect(r.stdout, `${args.join(' ')} ${n}`).toMatch(new RegExp(`\\n  ${n}\\b`));
    };
    await sub(
      ['graph'],
      ['list', 'create', 'validate', 'show', 'start', 'pause', 'resume', 'cancel', 'export'],
    );
    await sub(['node'], ['show', 'claim', 'briefing']);
    await sub(['work'], ['next']);
    await sub(['attempt'], ['heartbeat', 'note', 'metrics', 'submit', 'fail', 'block', 'release']);
    await sub(['inbox'], ['list', 'resolve']);
    await sub(['directive'], ['send', 'ack']);
    await sub(['orch'], ['attach', 'queue', 'detach']);
    await sub(['token'], ['create', 'list', 'revoke']);
    await sub(['db'], ['backup', 'export']);
    await sub(['claude'], ['install']);
    const hb = await h.run(['hb', '--help']);
    for (const flag of ['--progress', '--step', '--checkpoint']) expect(hb.stdout).toContain(flag);
  });

  it('drives a worker loop with human output, --json, and error hints', async () => {
    const h = harness();
    const spec = h.file(
      'spec.yaml',
      MINIMAL.replace('title: Add dark mode', 'title: Add dark mode\nslug: dark-mode'),
    );
    const created = await h.run(['graph', 'create', '-f', spec, '--start']);
    expect(created.code, created.stderr).toBe(0);
    expect(created.stdout).toContain('Created dark-mode');

    const graphs = await h.run(['graphs', '--json']);
    expect(graphs.json().items[0].slug).toBe('dark-mode');
    expect((await h.run(['graphs'])).stdout).toContain('**dark-mode** · Add dark mode · active');

    const peek = await h.run(['next', 'dark-mode']);
    expect(peek.stdout).toContain('Next: implement');
    const claim = await h.run(['work', 'next', 'dark-mode', '--claim', '--json'], {
      env: {
        AGENT_GRAPHS_ACTOR: 'model=claude-opus-5-5,thinking=high',
        AGENT_GRAPHS_CLIENT_SESSION: 'cc-1',
      },
    });
    expect(claim.code, claim.stderr).toBe(0);
    const attempt = claim.json().attempt.id as string;
    expect(claim.json().attempt.executor).toMatchObject({
      model: 'claude-opus-5-5',
      thinking: 'high',
      mechanism: 'cli',
      clientSessionId: 'cc-1',
    });

    const hb = await h.run([
      'hb',
      attempt,
      '--progress',
      '60',
      '--step',
      'tests',
      '--checkpoint',
      '{"done":["toggle"]}',
    ]);
    expect(hb.stdout).toContain('Lease renewed until');

    const missing = await h.run(['submit', attempt, '--summary', 'done']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('AIM_EVIDENCE_MISSING');
    expect(missing.stderr).toContain('Hint:');
    const missingJson = await h.run(['submit', attempt, '--summary', 'done', '--json']);
    expect(missingJson.json().error.code).toBe('AIM_EVIDENCE_MISSING');

    const note = await h.run([
      'note',
      attempt,
      '--type',
      'proof',
      '--title',
      'Tests 12/12',
      '--evidence',
      'cmd:pnpm test=0',
      '--evidence',
      'commit:3f9a2c1',
    ]);
    expect(note.stdout).toMatch(/Recorded proof note nt_/);
    expect(
      (await h.run(['metric', attempt, 'test_pass_rate=1', 'coverage=0.91'])).stdout,
    ).toContain('Recorded 2 metric(s)');
    const submit = await h.run(['attempt', 'submit', attempt, '--summary', 'Toggle shipped']);
    expect(submit.code, submit.stderr).toBe(0);
    expect(submit.stdout).toContain('Outcome: **evaluating**');

    const detail = await h.run(['node', 'show', 'dark-mode', 'implement']);
    expect(detail.stdout).toContain('# Implement dark mode (implement)');
    const brief = await h.run(['brief', 'dark-mode', 'implement', '--budget', '1500']);
    expect(brief.stdout).toContain('Briefing');
    const sitrep = await h.run(['sitrep', 'dark-mode', '--budget', '1000']);
    expect(sitrep.code).toBe(0);
    const show = await h.run(['graph', 'show', 'dark-mode']);
    expect(show.stdout).toContain('- implement · evaluating');
  });

  it('orchestrates: attach, dispatch, ask/resolve, directives and acks, mutate', async () => {
    const h = harness();
    const spec = h.file(
      'spec.yaml',
      WITH_LEAD.replace('title: Add dark mode', 'title: Add dark mode\nslug: dark-mode'),
    );
    await h.run(['graph', 'create', '-f', spec, '--start']);
    const token = (
      await h.run(['token', 'create', '--name', 'lead-agent', '--role', 'agent', '--json'])
    ).json().token as string;
    const asAgent = { AGENT_GRAPHS_TOKEN: token };
    const attach = await h.run(['orch', 'attach', 'dark-mode', 'lead', '--json'], { env: asAgent });
    expect(attach.code, attach.stderr).toBe(0);
    const session = attach.json().session as string;
    expect(attach.json().queue.map((q: { kind: string }) => q.kind)).toContain('dispatch');
    const lead = { ...asAgent, AGENT_GRAPHS_SESSION: session };

    const denied = await h.run(['claim', 'dark-mode', 'implement', '--dispatched-by', 'lead'], {
      env: asAgent,
    });
    expect(denied.code).toBe(1);
    expect(denied.stderr).toContain('POLICY_DENIED');
    const dispatched = await h.run(
      [
        'claim',
        'dark-mode',
        'implement',
        '--dispatched-by',
        'lead',
        '--actor',
        'agent=sub-1,model=claude-haiku-4-5',
        '--json',
      ],
      { env: lead },
    );
    expect(dispatched.code, dispatched.stderr).toBe(0);
    const attempt = dispatched.json().attempt.id as string;
    expect(dispatched.json().attempt.executor.parentSessionId).toBe(session);

    const ask = await h.run(
      ['ask', 'dark-mode', '--attempt', attempt, 'Which', 'storage', 'key?', '--json'],
      {
        env: asAgent,
      },
    );
    const requestId = ask.json().id as string;
    expect((await h.run(['inbox'])).stdout).toContain(requestId);
    const resolved = await h.run(
      ['resolve', requestId, '--choice', 'answer', '--data', '{"text":"theme"}'],
      {
        env: lead,
      },
    );
    expect(resolved.code, resolved.stderr).toBe(0);

    const sent = await h.run(
      [
        'directive',
        'dark-mode',
        '--node',
        'implement',
        'Respect',
        'prefers-color-scheme',
        '--json',
      ],
      {
        env: lead,
      },
    );
    expect(sent.code, sent.stderr).toBe(0);
    const hb = await h.run(['attempt', 'hb', attempt, '--json'], { env: asAgent });
    const directives = hb.json().directives as Array<{ id: string; title: string }>;
    expect(directives.map((d) => d.title)).toEqual(
      expect.arrayContaining(['Answer: Which storage key?', 'Respect prefers-color-scheme']),
    );
    for (const d of directives) {
      const ack = await h.run(['ack', d.id, '--attempt', attempt, '--note', 'applied'], {
        env: asAgent,
      });
      expect(ack.code, ack.stderr).toBe(0);
    }

    const batch = h.file(
      'batch.yaml',
      'addNodes:\n  - { key: docs, title: Docs, aim: Docs, purpose: Users, prompt: Write docs, needs: [review], aims: ["Docs exist"] }\n',
    );
    const mutate = await h.run(['graph', 'mutate', 'dark-mode', '-f', batch], { env: lead });
    expect(mutate.stdout, mutate.stderr).toContain('Revision 2');
    const queue = await h.run(['orch', 'queue', 'dark-mode', 'lead']);
    expect(queue.code).toBe(0);
    expect(
      (
        await h.run(['orch', 'detach', 'dark-mode', 'lead', '--handoff', 'all dispatched'], {
          env: lead,
        })
      ).code,
    ).toBe(0);
  });

  it('manages tokens, validates specs, exports, and fails clearly when unreachable', async () => {
    const h = harness();
    const created = await h.run(['token', 'create', '--name', 'ci', '--json']);
    expect(created.json()).toMatchObject({ name: 'ci', role: 'agent' });
    expect((await h.run(['token', 'list'])).stdout).toContain('· ci · agent');
    expect((await h.run(['token', 'revoke', created.json().id])).stdout).toContain('Revoked');

    const bad = h.file(
      'bad.yaml',
      'schema: agent-graphs/v1\ntitle: x\nnodes:\n  - key: a\n    title: A\n    promt: x\n',
    );
    const invalid = await h.run(['graph', 'validate', '-f', bad]);
    expect(invalid.code).toBe(1);
    expect(invalid.stdout).toContain('hint:');
    const good = h.file('good.yaml', MINIMAL);
    expect((await h.run(['graph', 'validate', '-f', good])).stdout).toContain('Valid.');

    const g = (await h.run(['graph', 'create', '-f', good, '--json'])).json().graph.id as string;
    expect((await h.run(['graph', 'export', g])).stdout).toContain('schema: agent-graphs/v1');
    expect((await h.run(['graph', 'export', g, '--json'])).json().schema).toBe('agent-graphs/v1');
    expect((await h.run(['graph', 'start', g])).stdout).toContain('is active');

    const out = join(h.dir, 'export');
    const exported = await h.run(['db', 'export', '--out', out]);
    expect(exported.code, exported.stderr).toBe(0);
    expect(readdirSync(out)).toHaveLength(1);

    const unreachable = await h.run(['health'], {
      fetch: (async () => {
        throw new Error('connect ECONNREFUSED');
      }) as typeof fetch,
    });
    expect(unreachable.code).toBe(1);
    expect(unreachable.stderr).toContain('UNREACHABLE');
    expect(unreachable.stderr).toContain('agraph serve');

    const usage = await h.run(['submit']);
    expect(usage.code).toBe(2);
    expect(usage.stderr).toContain('AGENT_GRAPHS_ATTEMPT');
  });

  it('saves a login used by later commands', async () => {
    const h = harness();
    const login = await h.run(['login', '--url', 'http://saved.local', '--token', 'ag_x'], {
      env: { AGENT_GRAPHS_URL: undefined },
    });
    expect(login.code).toBe(0);
    expect(JSON.parse(readFileSync(h.env.AGENT_GRAPHS_CONFIG as string, 'utf8'))).toEqual({
      url: 'http://saved.local',
      token: 'ag_x',
    });
    const seen: string[] = [];
    await h.run(['health'], {
      env: { AGENT_GRAPHS_URL: undefined },
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        seen.push(
          `${String(input)} ${(init?.headers as Record<string, string> | undefined)?.authorization}`,
        );
        return new Response(JSON.stringify({ ok: true, version: '1', spec: 's' }));
      }) as typeof fetch,
    });
    expect(seen[0]).toBe('http://saved.local/health Bearer ag_x');
  });

  it('runs a live simulation in-process', async () => {
    const h = harness();
    const { createApp } = await import('@agent-graphs/server');
    const app = createApp();
    const spec = h.file('demo.yaml', MINIMAL);
    const r = await h.run(
      ['simulate', spec, '--speed', '1000000', '--workers', '2', '--seed', '3', '--json'],
      {
        fetch: ((input: string | URL | Request, init?: RequestInit) =>
          app.request(String(input), init)) as typeof fetch,
      },
    );
    expect(r.code, r.stderr).toBe(0);
    expect(r.json()).toMatchObject({ status: 'completed' });
    expect(existsSync(h.dir)).toBe(true);
  }, 30_000);
});
