import { readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readClientSession } from '@agent-graphs/mcp';
import { AgentGraphsClient } from '@agent-graphs/sdk';
import { describe, expect, it } from 'vitest';
import { throttleFile } from '../src/hooks';
import { harness, MINIMAL } from './helpers';

const SPEC = MINIMAL.replace(
  'title: Add dark mode',
  'title: Add dark mode\nslug: dark-mode',
).replace(
  'nodes:',
  'orchestrators:\n  - { key: lead, name: Lead, role: lead, capabilities: [dispatch, resolve] }\nnodes:',
);

async function setup(clientSessionId = 'cc-session-1') {
  const h = harness();
  const sdk = new AgentGraphsClient({ baseUrl: 'http://test.local', fetch: h.fetch });
  await sdk.createGraph(SPEC, { start: true });
  return { h, sdk, clientSessionId };
}

function hookInput(event: string, extra: Record<string, unknown> = {}, session = 'cc-session-1') {
  return JSON.stringify({
    session_id: session,
    transcript_path: '/tmp/t.jsonl',
    cwd: '/tmp/project',
    hook_event_name: event,
    ...extra,
  });
}

async function claimAs(sdk: AgentGraphsClient, clientSessionId: string) {
  return sdk.claim('dark-mode', 'implement', {
    actor: { agent: 'dev', model: 'claude-opus-5-5', mechanism: 'claude-code', clientSessionId },
  });
}

describe('agraph hook', () => {
  it('session-start: records the session, injects nothing without holdings, a sitrep with AGENT_GRAPHS_GRAPH', async () => {
    const { h } = await setup();
    const envFile = join(h.dir, 'claude.env');
    writeFileSync(envFile, '');
    const r = await h.run(['hook', 'session-start'], {
      stdin: hookInput('SessionStart', { source: 'startup', cwd: h.dir }),
      env: { CLAUDE_ENV_FILE: envFile },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(readFileSync(envFile, 'utf8')).toBe('export AGENT_GRAPHS_CLIENT_SESSION=cc-session-1\n');
    expect(
      readClientSession(h.dir, { env: { AGENT_GRAPHS_STATE_DIR: h.env.AGENT_GRAPHS_STATE_DIR } }),
    ).toBe('cc-session-1');
    // Idempotent env file.
    await h.run(['hook', 'session-start'], {
      stdin: hookInput('SessionStart', { source: 'startup', cwd: h.dir }),
      env: { CLAUDE_ENV_FILE: envFile },
    });
    expect(readFileSync(envFile, 'utf8').split('\n').filter(Boolean)).toHaveLength(1);

    const withGraph = await h.run(['hook', 'session-start'], {
      stdin: hookInput('SessionStart', { source: 'startup' }),
      env: { AGENT_GRAPHS_GRAPH: 'dark-mode' },
    });
    const out = JSON.parse(withGraph.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput.additionalContext).toContain('Agent Graphs: graph dark-mode');
  });

  it('session-start re-injects the briefing after compaction and on resume; a reminder on startup', async () => {
    const { h, sdk } = await setup();
    const claim = await claimAs(sdk, 'cc-session-1');
    const compact = await h.run(['hook', 'session-start'], {
      stdin: hookInput('SessionStart', { source: 'compact' }),
    });
    expect(compact.code).toBe(0);
    const ctx = JSON.parse(compact.stdout).hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain('your context was compacted');
    expect(ctx).toContain(`You hold attempt ${claim.attempt.id} on implement (graph dark-mode)`);
    expect(ctx).toContain('# Briefing · implement');
    const resume = await h.run(['hook', 'session-start'], {
      stdin: hookInput('SessionStart', { source: 'resume' }),
    });
    expect(JSON.parse(resume.stdout).hookSpecificOutput.additionalContext).toContain(
      '# Briefing · implement',
    );
    const startup = await h.run(['hook', 'session-start'], {
      stdin: hookInput('SessionStart', { source: 'startup' }),
    });
    const reminder = JSON.parse(startup.stdout).hookSpecificOutput.additionalContext as string;
    expect(reminder).toContain(`node_briefing {attemptId: "${claim.attempt.id}"}`);
    expect(reminder).not.toContain('# Briefing');
  });

  it('session-start injects the sitrep for orchestrator roles and lists dispatched attempts', async () => {
    const { h, sdk } = await setup();
    const attach = await sdk.attach('dark-mode', 'lead', {
      agent: 'lead',
      clientSessionId: 'cc-lead',
    });
    await sdk
      .withSession(attach.session)
      .claim('dark-mode', 'implement', { actor: { agent: 'sub-1' }, dispatchedBy: 'lead' });
    const r = await h.run(['hook', 'session-start'], {
      stdin: hookInput('SessionStart', { source: 'compact' }, 'cc-lead'),
    });
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain('You hold the orchestrator role lead on dark-mode');
    expect(ctx).toContain('Dispatched attempt');
    expect(ctx).not.toContain('# Briefing · implement');
  });

  it('post-tool-use heartbeats by client session, surfaces directives, and throttles', async () => {
    const { h, sdk } = await setup();
    const claim = await claimAs(sdk, 'cc-session-1');
    h.clock.now += 20 * 60_000;
    const first = await h.run(['hook', 'post-tool-use'], {
      stdin: hookInput('PostToolUse', { tool_name: 'Bash' }),
    });
    expect(first.code).toBe(0);
    expect(first.stdout).toBe('');
    expect(
      h.calls.some((c) => c.path === '/api/v1/sessions/by-client/cc-session-1/heartbeat'),
    ).toBe(true);
    const attempt = await sdk.getAttempt(claim.attempt.id);
    expect(attempt.attempt.leaseExpiresAt).toBe(new Date(h.clock.now + 1800_000).toISOString());

    await sdk.sendDirective('dark-mode', {
      target: { type: 'node', key: 'implement' },
      kind: 'guidance',
      title: 'Use argon2id',
    });
    const before = h.calls.length;
    const throttled = await h.run(['hook', 'post-tool-use'], { stdin: hookInput('PostToolUse') });
    expect(throttled.stdout).toBe('');
    expect(h.calls.length).toBe(before);

    h.clock.now += 61_000;
    const second = await h.run(['hook', 'post-tool-use'], { stdin: hookInput('PostToolUse') });
    const out = JSON.parse(second.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(out.hookSpecificOutput.additionalContext).toContain('Use argon2id');
    expect(out.hookSpecificOutput.additionalContext).toContain(`attemptId: "${claim.attempt.id}"`);
    // Delivered via the hook: not repeated.
    h.clock.now += 61_000;
    expect((await h.run(['hook', 'heartbeat'], { stdin: hookInput('PostToolUse') })).stdout).toBe(
      '',
    );
    const stamp = throttleFile(
      { AGENT_GRAPHS_STATE_DIR: h.env.AGENT_GRAPHS_STATE_DIR },
      'cc-session-1',
    );
    expect(readFileSync(stamp, 'utf8')).toBe('');
    utimesSync(stamp, new Date(0), new Date(0));
  });

  it('stop blocks while an attempt is open, respecting stop_hook_active and the policy', async () => {
    const { h, sdk } = await setup();
    const none = await h.run(['hook', 'stop'], {
      stdin: hookInput('Stop', { stop_hook_active: false }),
    });
    expect(none).toMatchObject({ code: 0, stdout: '' });

    const claim = await claimAs(sdk, 'cc-session-1');
    const blocked = await h.run(['hook', 'stop'], {
      stdin: hookInput('Stop', { stop_hook_active: false }),
    });
    expect(blocked.code).toBe(0);
    const decision = JSON.parse(blocked.stdout);
    expect(decision.decision).toBe('block');
    expect(decision.reason).toBe(
      `You hold attempt ${claim.attempt.id} on implement (graph dark-mode). Submit, fail, block, or release it (with a handoff) before stopping.`,
    );

    const looping = await h.run(['hook', 'stop'], {
      stdin: hookInput('Stop', { stop_hook_active: true }),
    });
    expect(JSON.parse(looping.stdout)).toEqual({
      systemMessage: `Agent Graphs: ${decision.reason}`,
    });
    const warn = await h.run(['hook', 'stop'], {
      stdin: hookInput('Stop'),
      env: { AGENT_GRAPHS_STOP_POLICY: 'warn' },
    });
    expect(JSON.parse(warn.stdout).decision).toBeUndefined();
    const off = await h.run(['hook', 'stop'], {
      stdin: hookInput('Stop'),
      env: { AGENT_GRAPHS_STOP_POLICY: 'off' },
    });
    expect(off.stdout).toBe('');

    await sdk.release(claim.attempt.id, 'stopping', 'Next: write the tests.');
    const released = await h.run(['hook', 'stop'], { stdin: hookInput('Stop') });
    expect(released.stdout).toBe('');
  });

  it('subagent-stop only warns about dispatched attempts', async () => {
    const { h, sdk } = await setup();
    const attach = await sdk.attach('dark-mode', 'lead', {
      agent: 'lead',
      clientSessionId: 'cc-lead',
    });
    const claim = await sdk
      .withSession(attach.session)
      .claim('dark-mode', 'implement', { actor: { agent: 'sub-1' }, dispatchedBy: 'lead' });
    for (const argv of [
      ['hook', 'subagent-stop'],
      ['hook', 'stop', '--subagent'],
    ]) {
      const r = await h.run(argv, {
        stdin: hookInput('SubagentStop', { agent_id: 'a1' }, 'cc-lead'),
      });
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.decision).toBeUndefined();
      expect(out.systemMessage).toContain(claim.attempt.id);
    }
    // The lead's own Stop blocks on the session tree.
    const stop = await h.run(['hook', 'stop'], { stdin: hookInput('Stop', {}, 'cc-lead') });
    expect(JSON.parse(stop.stdout).decision).toBe('block');
  });

  it('pre-compact records a compaction event for the session', async () => {
    const { h, sdk } = await setup();
    const claim = await claimAs(sdk, 'cc-session-1');
    const r = await h.run(['hook', 'pre-compact'], {
      stdin: hookInput('PreCompact', { trigger: 'auto' }),
    });
    expect(r).toMatchObject({ code: 0, stdout: '' });
    const session = (await sdk.getAttempt(claim.attempt.id)).attempt.sessionId;
    expect(h.calls).toContainEqual({ method: 'POST', path: `/api/v1/sessions/${session}/events` });
  });

  it('fails open: unreachable server, malformed stdin, unknown sessions', async () => {
    const { h } = await setup();
    const down = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    for (const event of [
      'session-start',
      'post-tool-use',
      'stop',
      'subagent-stop',
      'pre-compact',
    ]) {
      const r = await h.run(['hook', event], {
        stdin: hookInput('X', { source: 'compact' }),
        fetch: down,
      });
      expect(r, event).toMatchObject({ code: 0, stdout: '' });
    }
    expect(await h.run(['hook', 'stop'], { stdin: 'not json' })).toMatchObject({
      code: 0,
      stdout: '',
    });
    expect(
      await h.run(['hook', 'stop'], { stdin: hookInput('Stop', {}, 'unknown') }),
    ).toMatchObject({
      code: 0,
      stdout: '',
    });
    const bad = await h.run(['hook', 'nonsense'], { stdin: '{}' });
    expect(bad.code).toBe(2);
  });
});
