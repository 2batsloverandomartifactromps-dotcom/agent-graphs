import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BIN_PATH, SKILL_SOURCE, TOKEN_REFERENCE } from '../src/claude-install';
import { harness, REPO } from './helpers';

const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

describe('agraph claude install', () => {
  it('writes .mcp.json, hook settings, and the skill, idempotently', async () => {
    const h = harness();
    const repo = join(h.dir, 'repo');
    mkdirSync(repo);
    const first = await h.run(['claude', 'install', '--dir', repo, '--json'], {
      env: { AGENT_GRAPHS_URL: 'http://localhost:4747' },
    });
    expect(first.code, first.stderr).toBe(0);
    expect(first.json().files.map((f: { action: string }) => f.action)).toEqual([
      'created',
      'created',
      'created',
    ]);

    const mcp = read(join(repo, '.mcp.json'));
    expect(mcp.mcpServers['agent-graphs']).toEqual({
      command: 'node',
      args: [BIN_PATH, 'mcp'],
      env: {
        AGENT_GRAPHS_URL: 'http://localhost:4747',
        AGENT_GRAPHS_TOKEN: TOKEN_REFERENCE,
        AGENT_GRAPHS_ACTOR: 'mechanism=claude-code,provider=anthropic',
      },
    });
    const settings = read(join(repo, '.claude', 'settings.json'));
    expect(Object.keys(settings.hooks).sort()).toEqual([
      'PostToolUse',
      'PreCompact',
      'SessionStart',
      'Stop',
      'SubagentStop',
    ]);
    expect(settings.hooks.PostToolUse[0]).toMatchObject({ matcher: '*' });
    expect(settings.hooks.Stop[0].hooks[0]).toEqual({
      type: 'command',
      command: `node ${BIN_PATH} hook stop`,
      timeout: 15,
    });
    expect(settings.hooks.SubagentStop[0].hooks[0].command).toContain('hook stop --subagent');
    expect(settings.env.AGENT_GRAPHS_URL).toBe('http://localhost:4747');
    expect(readFileSync(join(repo, '.claude/skills/agent-graphs/SKILL.md'), 'utf8')).toBe(
      readFileSync(SKILL_SOURCE, 'utf8'),
    );

    const again = await h.run(['claude', 'install', '--dir', repo, '--json'], {
      env: { AGENT_GRAPHS_URL: 'http://localhost:4747' },
    });
    expect(again.json().files.map((f: { action: string }) => f.action)).toEqual([
      'unchanged',
      'unchanged',
      'unchanged',
    ]);
  });

  it('merges without clobbering unrelated settings and replaces only its own hooks', async () => {
    const h = harness();
    const repo = join(h.dir, 'repo');
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(
      join(repo, '.mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'other-mcp' } }, extra: true }),
    );
    writeFileSync(
      join(repo, '.claude', 'settings.json'),
      JSON.stringify({
        permissions: { allow: ['Bash(pnpm test)'] },
        env: { FOO: 'bar' },
        hooks: {
          PostToolUse: [
            { matcher: 'Edit', hooks: [{ type: 'command', command: 'pnpm lint:fix' }] },
            {
              matcher: '*',
              hooks: [
                { type: 'command', command: 'npx -y agent-graphs hook post-tool-use' },
                { type: 'command', command: 'echo keep-me' },
              ],
            },
          ],
          Stop: [{ hooks: [{ type: 'command', command: 'agraph hook stop' }] }],
        },
      }),
    );
    const r = await h.run(
      ['claude', 'install', '--dir', repo, '--command', 'agraph', '--profile', 'worker'],
      {
        env: { AGENT_GRAPHS_URL: 'http://agents.example:4747' },
      },
    );
    expect(r.code, r.stderr).toBe(0);
    const mcp = read(join(repo, '.mcp.json'));
    expect(mcp.extra).toBe(true);
    expect(mcp.mcpServers.other).toEqual({ command: 'other-mcp' });
    expect(mcp.mcpServers['agent-graphs']).toMatchObject({
      command: 'agraph',
      args: ['mcp', '--profile', 'worker'],
    });
    const settings = read(join(repo, '.claude', 'settings.json'));
    expect(settings.permissions).toEqual({ allow: ['Bash(pnpm test)'] });
    expect(settings.env).toEqual({ FOO: 'bar', AGENT_GRAPHS_URL: 'http://agents.example:4747' });
    const post = settings.hooks.PostToolUse;
    expect(post).toEqual([
      { matcher: 'Edit', hooks: [{ type: 'command', command: 'pnpm lint:fix' }] },
      { matcher: '*', hooks: [{ type: 'command', command: 'echo keep-me' }] },
      {
        matcher: '*',
        hooks: [{ type: 'command', command: 'agraph hook post-tool-use', timeout: 5 }],
      },
    ]);
    expect(settings.hooks.Stop).toEqual([
      { hooks: [{ type: 'command', command: 'agraph hook stop', timeout: 15 }] },
    ]);
    const twice = await h.run(
      ['claude', 'install', '--dir', repo, '--command', 'agraph', '--profile', 'worker', '--json'],
      {
        env: { AGENT_GRAPHS_URL: 'http://agents.example:4747' },
      },
    );
    expect(twice.json().files.every((f: { action: string }) => f.action === 'unchanged')).toBe(
      true,
    );
  });

  it('refuses to overwrite invalid JSON', async () => {
    const h = harness();
    const repo = join(h.dir, 'repo');
    mkdirSync(repo);
    writeFileSync(join(repo, '.mcp.json'), '{ not json');
    const r = await h.run(['claude', 'install', '--dir', repo]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('not valid JSON');
    expect(readFileSync(join(repo, '.mcp.json'), 'utf8')).toBe('{ not json');
  });

  it('keeps the shipped examples in sync with what install writes', () => {
    const example = read(join(REPO, 'integrations/claude-code/settings.json'));
    const commands = Object.values(
      example.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>,
    )
      .flat()
      .flatMap((g) =>
        g.hooks.map((x) =>
          x.command.replace('node /path/to/agent-graphs/packages/cli/bin/agraph.js ', ''),
        ),
      );
    expect(commands.sort()).toEqual(
      [
        'hook session-start',
        'hook post-tool-use',
        'hook stop',
        'hook stop --subagent',
        'hook pre-compact',
      ].sort(),
    );
  });
});
