/**
 * The `agraph` command set (docs/agent-protocol.md §7.2): serve, MCP bridge, Claude Code hooks,
 * and client commands over the sdk. Human-friendly output by default, `--json` for machines.
 * The documented short forms (`next`, `claim`, `hb`, `submit`, …) and grouped forms
 * (`work next`, `node claim`, `attempt heartbeat`, …) share one implementation.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { format, isMcpProfile, MCP_PROFILES } from '@agent-graphs/mcp';
import type { AgentGraphsClient, GraphView, NodeDetail } from '@agent-graphs/sdk';
import { Command, CommanderError, Option } from 'commander';
import { installClaude } from './claude-install';
import { HOOK_EVENTS, type HookEvent, parseHookInput, runHook, timeoutFetch } from './hooks';
import {
  CliUsageError,
  clientFor,
  describeError,
  type GlobalOptions,
  type Io,
  readConfig,
  writeConfig,
} from './io';
import { actorFrom, collect, parseEval, parseEvidence, parseJsonArg, parseMetrics } from './parse';
import { CLI_VERSION } from './version';

type Opts = GlobalOptions & Record<string, unknown>;

type Ctx = {
  io: Io;
  opts: Opts;
  json: boolean;
  client: () => AgentGraphsClient;
  print: (data: unknown, human: () => string) => void;
  /** Exit code for the process (default 0). */
  setExit: (code: number) => void;
};

type Action = (ctx: Ctx, args: string[]) => Promise<void>;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (Number.isNaN(n)) throw new CliUsageError(`Expected a number, got '${String(v)}'.`);
  return n;
};
const list = (v: unknown): string[] | undefined =>
  typeof v === 'string'
    ? v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

function required(value: string | undefined, what: string): string {
  if (!value) throw new CliUsageError(`Missing ${what}.`);
  return value;
}

function defined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

export type CliState = { exitCode: number };

export function buildProgram(io: Io, state: CliState = { exitCode: 0 }): Command {
  const program = new Command('agraph')
    .description('Agent Graphs: execution graphs for agent-orchestrated builds')
    .version(CLI_VERSION)
    .option('--url <url>', 'server origin (AGENT_GRAPHS_URL)')
    .option('--token <token>', 'API token (AGENT_GRAPHS_TOKEN)')
    .option('--session <id>', 'act as this Agent Graphs session (AGENT_GRAPHS_SESSION)')
    .option(
      '--actor <annotation>',
      'execution annotation, e.g. model=claude-opus-5-5,thinking=high',
    )
    .option('--json', 'machine-readable JSON output')
    .exitOverride()
    .configureOutput({ writeOut: (s) => io.out(s), writeErr: (s) => io.err(s) })
    .showHelpAfterError(false);

  const act =
    (fn: Action) =>
    async (...raw: unknown[]): Promise<void> => {
      const cmd = raw.at(-1) as Command;
      const args = raw.slice(0, -2).flatMap((a) => (Array.isArray(a) ? a : [a])) as string[];
      const opts = cmd.optsWithGlobals() as Opts;
      const json = Boolean(opts.json);
      await fn(
        {
          io,
          opts,
          json,
          client: () => clientFor(io, opts),
          print: (data, human) => io.out(json ? JSON.stringify(data, null, 2) : human()),
          setExit: (code) => {
            state.exitCode = code;
          },
        },
        args.filter((a) => a !== undefined),
      );
    };

  const graphArg = (ctx: Ctx, value: string | undefined) =>
    required(value ?? ctx.io.env.AGENT_GRAPHS_GRAPH, 'graph (argument or AGENT_GRAPHS_GRAPH)');
  const attemptArg = (ctx: Ctx, value: string | undefined) =>
    required(
      value ?? ctx.io.env.AGENT_GRAPHS_ATTEMPT,
      'attempt id (argument or AGENT_GRAPHS_ATTEMPT)',
    );
  const readSpec = (ctx: Ctx, file: string | undefined): string => {
    const path = required(file, 'spec file (-f)');
    return readFileSync(resolve(ctx.io.cwd, path), 'utf8');
  };
  /** The session that exercises orchestrator capabilities (explicit, env, or the runtime's). */
  const capabilitySession = async (ctx: Ctx): Promise<string | undefined> => {
    if (ctx.opts.session) return ctx.opts.session;
    if (ctx.io.env.AGENT_GRAPHS_SESSION) return ctx.io.env.AGENT_GRAPHS_SESSION;
    const clientSessionId = ctx.io.env.AGENT_GRAPHS_CLIENT_SESSION;
    if (!clientSessionId) return undefined;
    const r = await ctx.client().registerSession(actorFrom(ctx.io, ctx.opts.actor));
    return r.session.id;
  };
  const asCapable = async (ctx: Ctx) => {
    const session = await capabilitySession(ctx);
    return session ? ctx.client().withSession(session) : ctx.client();
  };

  // ─── Server, MCP, login ────────────────────────────────────────────────────
  program
    .command('serve')
    .description('Start the Agent Graphs server (API, SSE, MCP over HTTP)')
    .option('--port <port>', 'port to listen on', io.env.PORT ?? '4747')
    .option('--host <host>', 'interface to bind', io.env.HOST ?? '127.0.0.1')
    .option('--data <dir>', 'data directory (DATA_DIR)')
    .addOption(new Option('--auth-mode <mode>', 'auth mode').choices(['local', 'token']))
    .action(
      act(async (ctx) => {
        const { startServer } = await import('@agent-graphs/server');
        startServer(
          defined({
            port: num(ctx.opts.port),
            host: str(ctx.opts.host),
            dataDir: str(ctx.opts.data)
              ? resolve(ctx.io.cwd, str(ctx.opts.data) as string)
              : undefined,
            authMode: str(ctx.opts.authMode) as 'local' | 'token' | undefined,
          }),
        );
      }),
    );

  program
    .command('health')
    .description('Check that a server is reachable')
    .action(
      act(async (ctx) => {
        const client = ctx.client();
        const h = await client.health();
        ctx.print(
          { ...h, url: client.baseUrl },
          () => `ok · ${client.baseUrl} · v${h.version} · ${h.spec}`,
        );
      }),
    );

  program
    .command('mcp')
    .description('Serve the MCP tools over stdio (for Claude Code and other MCP clients)')
    .addOption(
      new Option('--profile <profile>', 'tool profile').choices([...MCP_PROFILES]).default('all'),
    )
    .action(
      act(async (ctx) => {
        const profile = str(ctx.opts.profile);
        const { runStdioServer } = await import('@agent-graphs/mcp');
        const env = { ...ctx.io.env };
        const saved = readConfig(ctx.io.env);
        env.AGENT_GRAPHS_URL = ctx.opts.url ?? env.AGENT_GRAPHS_URL ?? saved.url;
        if (ctx.opts.token ?? env.AGENT_GRAPHS_TOKEN ?? saved.token)
          env.AGENT_GRAPHS_TOKEN = ctx.opts.token ?? env.AGENT_GRAPHS_TOKEN ?? saved.token;
        await runStdioServer({
          profile: isMcpProfile(profile) ? profile : 'all',
          env,
          cwd: ctx.io.cwd,
        });
      }),
    );

  program
    .command('login')
    .description('Save a server URL (--url) and token (--token) for later commands')
    .action(
      act(async (ctx) => {
        const config = defined({ url: required(ctx.opts.url, '--url'), token: ctx.opts.token });
        const path = writeConfig(ctx.io.env, config);
        let reachable = true;
        try {
          await clientFor(ctx.io, ctx.opts).health();
        } catch {
          reachable = false;
        }
        ctx.print({ saved: path, url: config.url, reachable }, () =>
          reachable
            ? `Saved ${path}. ${config.url} is reachable.`
            : `Saved ${path}. Warning: ${config.url} is not reachable right now.`,
        );
      }),
    );

  // ─── Graphs ────────────────────────────────────────────────────────────────
  const listGraphs: Action = async (ctx) => {
    const r = await ctx
      .client()
      .listGraphs(defined({ status: str(ctx.opts.status), q: str(ctx.opts.q) }));
    ctx.print(r, () => (r.items.length ? r.items.map(format.graphLine).join('\n') : 'No graphs.'));
  };
  const listOpts = (c: Command) =>
    c
      .option('--status <statuses>', 'filter, e.g. active,paused')
      .option('--q <text>', 'text filter');
  listOpts(program.command('graphs').description('List graphs')).action(act(listGraphs));

  const graph = program.command('graph').description('Create, inspect, and control graphs');
  listOpts(graph.command('list').description('List graphs')).action(act(listGraphs));
  graph
    .command('create')
    .description('Create a graph from a YAML/JSON spec')
    .requiredOption('-f, --file <path>', 'spec file')
    .option('--start', 'start it (or request plan approval)')
    .action(
      act(async (ctx) => {
        const r = await ctx
          .client()
          .createGraph(readSpec(ctx, str(ctx.opts.file)), { start: Boolean(ctx.opts.start) });
        const ref = r.graph.slug ?? r.graph.id;
        ctx.print(
          { graph: r.graph, started: r.started, requestId: r.requestId, nodes: r.nodes.length },
          () =>
            `Created ${ref} (${r.graph.id}) · ${r.nodes.length} nodes · ${
              r.requestId ? `awaiting plan approval (request ${r.requestId})` : r.graph.status
            }`,
        );
      }),
    );
  graph
    .command('validate')
    .description('Validate a spec')
    .requiredOption('-f, --file <path>', 'spec file')
    .action(
      act(async (ctx) => {
        const r = await ctx.client().validateSpec(readSpec(ctx, str(ctx.opts.file)));
        const { normalized: _n, ...rest } = r;
        ctx.print(rest, () => {
          const lines = [r.ok ? 'Valid.' : `Invalid: ${r.errors.length} error(s).`];
          for (const e of r.errors)
            lines.push(
              `  error   ${e.path}: ${e.message}${e.hint ? `\n          hint: ${e.hint}` : ''}`,
            );
          for (const w of r.warnings) lines.push(`  warning ${w.path}: ${w.message}`);
          return lines.join('\n');
        });
        if (!r.ok) ctx.setExit(1);
      }),
    );
  graph
    .command('show')
    .argument('[graph]')
    .description('Show a graph: nodes, loops, requests')
    .action(
      act(async (ctx, [g]) => {
        const v = await ctx.client().getGraph(graphArg(ctx, g));
        ctx.print(v, () => renderGraph(v));
      }),
    );
  for (const action of [
    'start',
    'pause',
    'resume',
    'cancel',
    'archive',
    'unarchive',
    'reopen',
  ] as const) {
    graph
      .command(action)
      .argument('[graph]')
      .option('--reason <text>', 'reason (recorded in the audit log)')
      .description(`${action[0]?.toUpperCase()}${action.slice(1)} a graph`)
      .action(
        act(async (ctx, [g]) => {
          const r = await ctx.client().graphAction(graphArg(ctx, g), action, str(ctx.opts.reason));
          ctx.print(
            r,
            () =>
              `${r.graph.slug ?? r.graph.id} is ${r.graph.status}${r.graph.pendingApproval ? ' (awaiting plan approval)' : ''}.`,
          );
        }),
      );
  }
  graph
    .command('export')
    .argument('[graph]')
    .description('Export the canonical spec (YAML, or JSON with --json)')
    .action(
      act(async (ctx, [g]) => {
        const ref = graphArg(ctx, g);
        if (ctx.json)
          ctx.io.out(JSON.stringify(await ctx.client().exportSpec(ref, 'json'), null, 2));
        else ctx.io.out(String(await ctx.client().exportSpec(ref, 'yaml')));
      }),
    );
  graph
    .command('mutate')
    .argument('<graph>')
    .requiredOption('-f, --file <path>', 'mutation batch (JSON or YAML)')
    .description('Apply a batch of structural changes (orchestrator with mutate, or admin)')
    .action(
      act(async (ctx, [g]) => {
        const { parse } = await import('yaml');
        const batch = parse(readSpec(ctx, str(ctx.opts.file))) as Record<string, unknown>;
        const r = await (await asCapable(ctx)).mutate(required(g, 'graph'), batch);
        ctx.print(
          { revision: r.revision, changes: r.changes },
          () => `Revision ${r.revision}: ${r.changes.join('; ')}`,
        );
      }),
    );

  program
    .command('sitrep')
    .argument('[graph]')
    .option('--budget <tokens>', 'token budget', '3000')
    .option('--as <orchestrator>', 'prepend this orchestrator role prompt and handoff')
    .description('Situation report for a graph')
    .action(
      act(async (ctx, [g]) => {
        const ref = graphArg(ctx, g);
        const text = await ctx
          .client()
          .sitrep(ref, defined({ budget: num(ctx.opts.budget), orchestrator: str(ctx.opts.as) }));
        ctx.print({ graph: ref, sitrep: text }, () => text);
      }),
    );

  // ─── Work: next, claim, briefings, nodes ────────────────────────────────────
  const next: Action = async (ctx, [g]) => {
    const ref = graphArg(ctx, g);
    const claim = Boolean(ctx.opts.claim);
    const role = str(ctx.opts.role) as 'worker' | 'reviewer' | undefined;
    const r = await ctx.client().next(
      ref,
      defined({
        actor: actorFrom(ctx.io, ctx.opts.actor),
        role,
        skills: list(ctx.opts.skills),
        claim: role === 'reviewer' ? undefined : claim,
        briefing: claim ? { budget: num(ctx.opts.budget) ?? 6000 } : undefined,
      }),
    );
    ctx.print(r, () => {
      if (role === 'reviewer')
        return r.attempt
          ? `Review attempt ${r.attempt.id} on ${r.node?.key}: aims ${(r.aims ?? []).map((a) => a.key).join(', ')}`
          : `Nothing to review (${r.reason || 'none pending'}).`;
      if (!r.node) return format.nothingReadyText(r);
      if (!r.attempt)
        return `Next: ${r.node.key} · ${r.node.title} · ${r.node.priority} (${r.node.reason}). Claim with: agraph claim ${ref} ${r.node.key}`;
      return format.claimText(r as never);
    });
  };
  const nextOpts = (c: Command) =>
    c
      .argument('[graph]')
      .option('--claim', 'claim the picked node')
      .addOption(new Option('--role <role>', 'worker or reviewer').choices(['worker', 'reviewer']))
      .option('--skills <list>', 'comma-separated skills you declare')
      .option('--budget <tokens>', 'briefing budget');
  nextOpts(
    program.command('next').description('Pick (and optionally claim) the best ready node'),
  ).action(act(next));
  const work = program.command('work').description('Get work');
  nextOpts(
    work.command('next').description('Pick (and optionally claim) the best ready node'),
  ).action(act(next));

  const claim: Action = async (ctx, [g, n]) => {
    const dispatchedBy = str(ctx.opts.dispatchedBy);
    const client = dispatchedBy ? await asCapable(ctx) : ctx.client();
    const r = await client.claim(
      required(g, 'graph'),
      required(n, 'node'),
      defined({
        actor: actorFrom(ctx.io, ctx.opts.actor, { clientSession: !dispatchedBy }),
        skills: list(ctx.opts.skills),
        dispatchedBy,
        briefing:
          ctx.opts.briefing === false ? undefined : { budget: num(ctx.opts.budget) ?? 6000 },
      }),
    );
    ctx.print(r, () =>
      format.claimText(r, { nodeKey: n as string, dispatched: Boolean(dispatchedBy) }),
    );
  };
  const claimOpts = (c: Command) =>
    c
      .argument('<graph>')
      .argument('<node>')
      .option(
        '--dispatched-by <orchestrator>',
        'claim on behalf of a subagent (attached orchestrator key)',
      )
      .option('--skills <list>', 'comma-separated skills you declare')
      .option('--budget <tokens>', 'briefing budget')
      .option('--no-briefing', 'omit the briefing');
  claimOpts(program.command('claim').description('Claim a specific ready node')).action(act(claim));

  const brief: Action = async (ctx, [g, n]) => {
    const attempt = str(ctx.opts.attempt);
    const budget = num(ctx.opts.budget);
    const text = attempt
      ? await ctx.client().attemptBriefing(attempt, budget)
      : await ctx.client().briefing(graphArg(ctx, g), required(n, 'node'), defined({ budget }));
    ctx.print({ briefing: text }, () => text);
  };
  const briefOpts = (c: Command) =>
    c
      .argument('[graph]')
      .argument('[node]')
      .option('--attempt <id>', 'the briefing of your attempt (marks directives delivered)')
      .option('--budget <tokens>', 'token budget');
  briefOpts(program.command('brief').description('Briefing for a node or an attempt')).action(
    act(brief),
  );

  const node = program.command('node').description('Inspect, claim, and control nodes');
  node
    .command('show')
    .argument('<graph>')
    .argument('<node>')
    .description('Node detail')
    .action(
      act(async (ctx, [g, n]) => {
        const d = await ctx.client().getNode(required(g, 'graph'), required(n, 'node'));
        ctx.print(d, () => renderNode(d));
      }),
    );
  claimOpts(node.command('claim').description('Claim a specific ready node')).action(act(claim));
  briefOpts(
    node.command('briefing').alias('brief').description('Briefing for a node or an attempt'),
  ).action(act(brief));
  for (const action of ['pause', 'resume', 'skip', 'fail', 'retry'] as const) {
    node
      .command(action)
      .argument('<graph>')
      .argument('<node>')
      .option('--reason <text>', 'reason (required for skip and fail)')
      .option('--extra <n>', 'extra attempts for retry', '1')
      .description(
        `${action[0]?.toUpperCase()}${action.slice(1)} a node (orchestrator with resolve, or admin)`,
      )
      .action(
        act(async (ctx, [g, n]) => {
          const body: Record<string, unknown> =
            action === 'retry'
              ? { extraAttempts: num(ctx.opts.extra) ?? 1 }
              : defined({ reason: str(ctx.opts.reason) });
          if ((action === 'skip' || action === 'fail') && !body.reason)
            throw new CliUsageError(`${action} needs --reason.`);
          const r = await (await asCapable(ctx)).nodeAction(
            required(g, 'graph'),
            required(n, 'node'),
            action,
            body,
          );
          ctx.print(r, () => `${r.node.key} is ${r.node.status}.`);
        }),
      );
  }

  // ─── Attempts ──────────────────────────────────────────────────────────────
  const heartbeat: Action = async (ctx, [a]) => {
    const id = attemptArg(ctx, a);
    const ticks = (ctx.opts.tick as string[] | undefined) ?? [];
    const r = await ctx.client().heartbeat(
      id,
      defined({
        progress: num(ctx.opts.progress),
        step: str(ctx.opts.step),
        checkpoint: str(ctx.opts.checkpoint)
          ? parseJsonArg(str(ctx.opts.checkpoint) as string, ctx.io)
          : undefined,
        usage: str(ctx.opts.usage)
          ? (parseJsonArg(str(ctx.opts.usage) as string, ctx.io) as never)
          : undefined,
        checklist: ticks.length
          ? Object.fromEntries(ticks.map((k) => [k, { done: true }]))
          : undefined,
      }),
    );
    ctx.print(r, () => format.heartbeatText(r, id));
  };
  const hbOpts = (c: Command) =>
    c
      .argument('[attempt]')
      .option('--progress <0-100>', 'progress percentage')
      .option('--step <text>', 'current step')
      .option('--checkpoint <json|@file>', 'small checkpoint: what is done, what is next')
      .option('--usage <json|@file>', 'cumulative usage, e.g. {"costUsd":1.2}')
      .option('--tick <key>', 'tick a checklist item (repeatable)', collect);
  hbOpts(
    program.command('hb').description('Heartbeat an attempt (renew the lease, report progress)'),
  ).action(act(heartbeat));

  const note: Action = async (ctx, [a]) => {
    const body = defined({
      type: required(str(ctx.opts.type), '--type') as never,
      title: required(str(ctx.opts.title), '--title'),
      body: str(ctx.opts.body),
      severity: str(ctx.opts.severity) as never,
      evidence: ((ctx.opts.evidence as string[] | undefined) ?? []).map(parseEvidence),
    });
    if (!body.evidence?.length) delete (body as { evidence?: unknown }).evidence;
    const g = str(ctx.opts.graph);
    const attempt = a ?? (g ? undefined : ctx.io.env.AGENT_GRAPHS_ATTEMPT);
    let r: { id: string; type: string; title: string };
    if (attempt) r = await ctx.client().addNote(attempt, body);
    else if (g && str(ctx.opts.node))
      r = await (await asCapable(ctx)).addNodeNote(g, str(ctx.opts.node) as string, body);
    else if (g) r = await (await asCapable(ctx)).addGraphNote(g, body);
    else
      throw new CliUsageError('Pass an attempt id (or AGENT_GRAPHS_ATTEMPT), or --graph [--node].');
    ctx.print(r, () => `Recorded ${r.type} note ${r.id}: ${r.title}`);
  };
  const noteOpts = (c: Command) =>
    c
      .argument('[attempt]')
      .addOption(
        new Option('--type <type>', 'note type').choices([
          'proof',
          'deliverable',
          'finding',
          'decision',
          'handoff',
          'progress',
          'question',
          'comment',
        ]),
      )
      .option('--title <text>', 'title')
      .option('--body <markdown>', 'body')
      .addOption(
        new Option('--severity <level>', 'finding severity').choices([
          'info',
          'low',
          'medium',
          'high',
          'critical',
        ]),
      )
      .option(
        '--evidence <kind:value>',
        "evidence, e.g. 'commit:3f9a2c1' or 'cmd:pnpm test=0' (repeatable)",
        collect,
      )
      .option('--graph <graph>', 'node- or graph-level note (without an attempt)')
      .option('--node <key>', 'node for a node-level note');
  noteOpts(
    program
      .command('note')
      .description('Add a note (proof, deliverable, finding, decision, handoff, …)'),
  ).action(act(note));

  const metric: Action = async (ctx, args) => {
    let [first, ...rest] = args;
    let attempt: string | undefined;
    if (first && !first.includes('=')) attempt = first;
    else rest = first ? [first, ...rest] : rest;
    first = undefined;
    const metrics = parseMetrics(rest);
    if (!Object.keys(metrics).length) throw new CliUsageError('Pass at least one name=value.');
    const g = str(ctx.opts.graph);
    if (!attempt && g) {
      const r = await (await asCapable(ctx)).reportGraphMetrics(g, metrics);
      ctx.print(r, () => `Recorded ${Object.keys(metrics).length} graph metric(s) on ${g}.`);
      return;
    }
    const id = attemptArg(ctx, attempt);
    const r = await ctx.client().reportMetrics(id, metrics);
    ctx.print(r, () => `Recorded ${r.recorded} metric(s) on ${id}.`);
  };
  const metricOpts = (c: Command) =>
    c
      .argument('[args...]', '[attempt] name=value …')
      .option('--graph <graph>', 'graph-level metrics (without an attempt)');
  metricOpts(
    program.command('metric').description('Report metrics, e.g. test_pass_rate=1 coverage=0.91'),
  ).action(act(metric));

  const submit: Action = async (ctx, [a]) => {
    const id = attemptArg(ctx, a);
    const evaluations = ((ctx.opts.eval as string[] | undefined) ?? []).map(parseEval);
    const metrics = parseMetrics((ctx.opts.metric as string[] | undefined) ?? []);
    const proofs = ((ctx.opts.proof as string[] | undefined) ?? []).map((p) => ({
      type: 'proof' as const,
      title: p.length > 120 ? `${p.slice(0, 117)}…` : p,
      evidence: [parseEvidence(p.includes(':') ? p : `text:${p}`)],
    }));
    const r = await ctx.client().submit(
      id,
      defined({
        summary: required(str(ctx.opts.summary), '--summary'),
        evaluations: evaluations.length ? evaluations : undefined,
        metrics: Object.keys(metrics).length ? metrics : undefined,
        notes: proofs.length ? proofs : undefined,
      }),
    );
    ctx.print(r, () => format.submitText(r));
  };
  const submitOpts = (c: Command) =>
    c
      .argument('[attempt]')
      .option('--summary <text>', 'what you did (required)')
      .option('--eval <aim=verdict:rationale>', 'self-evaluation (repeatable)', collect)
      .option('--metric <name=value>', 'metric value (repeatable)', collect)
      .option(
        '--proof <kind:value>',
        "inline proof note, e.g. 'cmd:pnpm test=0' (repeatable)",
        collect,
      );
  submitOpts(program.command('submit').description('Submit an attempt')).action(act(submit));

  const fail: Action = async (ctx, [a]) => {
    const r = await ctx
      .client()
      .fail(
        attemptArg(ctx, a),
        required(str(ctx.opts.reason), '--reason'),
        ctx.opts.retry === false ? false : undefined,
      );
    ctx.print(
      r,
      () =>
        `Attempt ${r.attempt.id} is ${r.attempt.status}; node ${r.node.key} is ${r.node.status}.`,
    );
  };
  const failOpts = (c: Command) =>
    c
      .argument('[attempt]')
      .option('--reason <text>', 'why (required)')
      .option('--no-retry', 'impossible as specified: escalate immediately');
  failOpts(program.command('fail').description('Fail an attempt (counted)')).action(act(fail));

  const block: Action = async (ctx, [a]) => {
    const reason = required(str(ctx.opts.reason), '--reason');
    const r = await ctx
      .client()
      .block(
        attemptArg(ctx, a),
        reason,
        defined({ title: str(ctx.opts.title) ?? reason.slice(0, 200), body: str(ctx.opts.body) }),
      );
    ctx.print(r, () => `Attempt ${r.attempt.id} is blocked; request ${r.request.id} is open.`);
  };
  const blockOpts = (c: Command) =>
    c
      .argument('[attempt]')
      .option('--reason <text>', 'the external blocker (required)')
      .option('--title <text>', 'request title (defaults to the reason)')
      .option('--body <text>', 'request details');
  blockOpts(
    program.command('block').description('Stop on an external blocker (not counted)'),
  ).action(act(block));

  const release: Action = async (ctx, [a]) => {
    const r = await ctx
      .client()
      .release(
        attemptArg(ctx, a),
        required(str(ctx.opts.reason), '--reason'),
        str(ctx.opts.handoff),
      );
    ctx.print(r, () => `Released ${r.attempt.id}; node ${r.node.key} is ${r.node.status}.`);
  };
  const releaseOpts = (c: Command) =>
    c
      .argument('[attempt]')
      .option('--reason <text>', 'why you stop (required)')
      .option('--handoff <text>', 'state, done, next, traps');
  releaseOpts(
    program.command('release').description('Release an attempt voluntarily (not counted)'),
  ).action(act(release));

  const attempt = program.command('attempt').description('Report on an attempt');
  attempt
    .command('show')
    .argument('[attempt]')
    .description('Attempt, node summary, and lease state')
    .action(
      act(async (ctx, [a]) => {
        const r = await ctx.client().getAttempt(attemptArg(ctx, a));
        ctx.print(r, () =>
          [
            `Attempt ${r.attempt.id} (#${r.attempt.number}) · ${r.attempt.status} · node ${r.node.key} (${r.node.status}) · graph ${r.graph.slug ?? r.graph.id}`,
            r.attempt.leaseExpiresAt ? `Lease until ${r.attempt.leaseExpiresAt}` : '',
            r.attempt.progress !== undefined
              ? `Progress ${r.attempt.progress}% · ${r.attempt.currentStep ?? ''}`
              : '',
          ]
            .filter(Boolean)
            .join('\n'),
        );
      }),
    );
  hbOpts(attempt.command('heartbeat').alias('hb').description('Heartbeat')).action(act(heartbeat));
  noteOpts(attempt.command('note').description('Add a note')).action(act(note));
  metricOpts(attempt.command('metrics').alias('metric').description('Report metrics')).action(
    act(metric),
  );
  submitOpts(attempt.command('submit').description('Submit')).action(act(submit));
  failOpts(attempt.command('fail').description('Fail (counted)')).action(act(fail));
  blockOpts(attempt.command('block').description('Block on an external blocker')).action(
    act(block),
  );
  releaseOpts(attempt.command('release').description('Release voluntarily')).action(act(release));

  // ─── Requests, inbox, directives ───────────────────────────────────────────
  program
    .command('ask')
    .argument('<graph>')
    .argument('<question...>')
    .option('--node <key>', 'the node it concerns')
    .option('--attempt <id>', 'your attempt (the answer arrives on it)')
    .option('--body <text>', 'details')
    .option('--approval', 'request an approval instead of asking a question')
    .addOption(
      new Option('--assignee <who>', 'who should answer').choices(['human', 'orchestrator', 'any']),
    )
    .option('--blocking', 'block until answered')
    .description('Ask a question (or request an approval)')
    .action(
      act(async (ctx, [g, ...words]) => {
        const r = await (await asCapable(ctx)).raiseRequest(
          required(g, 'graph'),
          defined({
            kind: ctx.opts.approval ? ('approval' as const) : ('question' as const),
            title: required(words.join(' ').trim() || undefined, 'question'),
            body: str(ctx.opts.body),
            node: str(ctx.opts.node),
            attempt: str(ctx.opts.attempt),
            assignee: str(ctx.opts.assignee) as never,
            blocking: ctx.opts.blocking ? true : undefined,
          }),
        );
        ctx.print(r, () => `Opened ${r.kind} request ${r.id} (${r.assignee}).`);
      }),
    );

  const inboxList: Action = async (ctx) => {
    const r = await ctx.client().requests(
      defined({
        graph: str(ctx.opts.graph),
        status: str(ctx.opts.status),
        kind: str(ctx.opts.kind),
      }),
    );
    ctx.print(r, () =>
      r.items.length ? r.items.map(format.requestLine).join('\n') : 'Inbox empty.',
    );
  };
  const inbox = program.command('inbox').description('Requests awaiting a decision');
  inbox
    .command('list', { isDefault: true })
    .description('List requests (default: open)')
    .option('--graph <graph>', 'one graph')
    .option('--status <status>', 'open, resolved, dismissed, expired')
    .option('--kind <kinds>', 'approval, question, escalation, blocker')
    .action(act(inboxList));
  const resolveRequest: Action = async (ctx, [id]) => {
    const r = await (await asCapable(ctx)).resolveRequest(
      required(id, 'request id'),
      defined({
        choice: required(str(ctx.opts.choice), '--choice'),
        comment: str(ctx.opts.comment),
        data: str(ctx.opts.data)
          ? (parseJsonArg(str(ctx.opts.data) as string, ctx.io) as Record<string, unknown>)
          : undefined,
      }),
    );
    ctx.print(
      r,
      () => `Resolved ${r.request.id} with ${str(ctx.opts.choice)}; graph is ${r.graph.status}.`,
    );
  };
  const resolveOpts = (c: Command) =>
    c
      .argument('<request>')
      .option(
        '--choice <option>',
        'option id, e.g. approve, reject, answer, retry, extend (required)',
      )
      .option('--comment <text>', 'comment (required for rejections)')
      .option('--data <json|@file>', 'option data, e.g. {"extraAttempts":1}');
  resolveOpts(program.command('resolve').description('Resolve a request')).action(
    act(resolveRequest),
  );
  resolveOpts(inbox.command('resolve').description('Resolve a request')).action(
    act(resolveRequest),
  );

  const directive = program.command('directive').description('Send and acknowledge directives');
  directive
    .command('send', { isDefault: true })
    .argument('<graph>')
    .argument('<text...>')
    .option('--node <key>', 'target a node (current and future attempts)')
    .option('--attempt <id>', 'target one attempt')
    .option('--orchestrator <key>', 'target an orchestrator role')
    .addOption(
      new Option('--kind <kind>', 'directive kind')
        .choices(['guidance', 'change', 'answer', 'pause', 'resume', 'cancel'])
        .default('guidance'),
    )
    .option('--body <text>', 'details (the text becomes the title)')
    .option('--no-ack', 'do not require an acknowledgment')
    .description('Send a directive (orchestrator with resolve, or admin)')
    .action(
      act(async (ctx, [g, ...words]) => {
        const target = str(ctx.opts.attempt)
          ? { type: 'attempt' as const, id: str(ctx.opts.attempt) }
          : str(ctx.opts.node)
            ? { type: 'node' as const, key: str(ctx.opts.node) }
            : str(ctx.opts.orchestrator)
              ? { type: 'orchestrator' as const, key: str(ctx.opts.orchestrator) }
              : { type: 'graph' as const };
        const r = await (await asCapable(ctx)).sendDirective(
          required(g, 'graph'),
          defined({
            target,
            kind: (str(ctx.opts.kind) ?? 'guidance') as 'guidance',
            title: required(words.join(' ').trim() || undefined, 'directive text').slice(0, 500),
            body: str(ctx.opts.body),
            requiresAck: ctx.opts.ack === false ? false : undefined,
          }),
        );
        ctx.print(r, () => `Sent directive ${r.id} (${r.kind}) to ${target.type}.`);
      }),
    );
  const ack: Action = async (ctx, [id]) => {
    const r = await (await asCapable(ctx)).ackDirective(
      required(id, 'directive id'),
      defined({
        note: str(ctx.opts.note),
        attemptId: str(ctx.opts.attempt) ?? ctx.io.env.AGENT_GRAPHS_ATTEMPT,
      }),
    );
    ctx.print(r, () => `Acknowledged ${id}.`);
  };
  const ackOpts = (c: Command) =>
    c
      .argument('<directive>')
      .option('--note <text>', 'how you applied it')
      .option('--attempt <id>', 'the attempt it reached you on (AGENT_GRAPHS_ATTEMPT)');
  ackOpts(program.command('ack').description('Acknowledge a directive')).action(act(ack));
  ackOpts(directive.command('ack').description('Acknowledge a directive')).action(act(ack));

  // ─── Orchestrators ─────────────────────────────────────────────────────────
  const orch = program.command('orch').alias('orchestrator').description('Orchestrator roles');
  orch
    .command('attach')
    .argument('<graph>')
    .argument('<key>')
    .description('Take an orchestrator role (prints the session to export)')
    .action(
      act(async (ctx, [g, key]) => {
        const r = await ctx
          .client()
          .attach(required(g, 'graph'), required(key, 'key'), actorFrom(ctx.io, ctx.opts.actor));
        ctx.print(r, () =>
          [
            `Attached as ${key} · session ${r.session} · lease until ${r.lease.expiresAt}`,
            `Use it for capability commands: export AGENT_GRAPHS_SESSION=${r.session}`,
            'Duty queue:',
            ...(r.queue.length ? r.queue.map(format.dutyLine) : ['- (empty)']),
          ].join('\n'),
        );
      }),
    );
  orch
    .command('queue')
    .argument('<graph>')
    .argument('<key>')
    .description('The duty queue of a role')
    .action(
      act(async (ctx, [g, key]) => {
        const r = await ctx.client().queue(required(g, 'graph'), required(key, 'key'));
        ctx.print(r, () =>
          r.items.length ? r.items.map(format.dutyLine).join('\n') : 'Queue empty.',
        );
      }),
    );
  orch
    .command('heartbeat')
    .argument('<graph>')
    .argument('<key>')
    .description('Renew the role lease')
    .action(
      act(async (ctx, [g, key]) => {
        const r = await (await asCapable(ctx)).orchestratorHeartbeat(
          required(g, 'graph'),
          required(key, 'key'),
        );
        ctx.print(r, () => `Lease renewed until ${r.leaseExpiresAt}.`);
      }),
    );
  orch
    .command('detach')
    .argument('<graph>')
    .argument('<key>')
    .option('--handoff <text>', 'handoff for the next holder')
    .description('Release the role')
    .action(
      act(async (ctx, [g, key]) => {
        const r = await (await asCapable(ctx)).detach(
          required(g, 'graph'),
          required(key, 'key'),
          str(ctx.opts.handoff),
        );
        ctx.print(r, () => `Detached from ${key}.`);
      }),
    );

  // ─── Tokens ────────────────────────────────────────────────────────────────
  const token = program.command('token').description('API tokens (admin)');
  token
    .command('create')
    .requiredOption('--name <name>', 'token name')
    .addOption(
      new Option('--role <role>', 'role').choices(['admin', 'agent', 'viewer']).default('agent'),
    )
    .description('Create a token (the secret is shown once)')
    .action(
      act(async (ctx) => {
        const r = await ctx.client().createToken({
          name: required(str(ctx.opts.name), '--name'),
          role: (str(ctx.opts.role) ?? 'agent') as 'agent',
        });
        ctx.print(
          r,
          () => `Created ${r.role} token ${r.id} (${r.name}). Secret (shown once):\n${r.token}`,
        );
      }),
    );
  token
    .command('list')
    .description('List active tokens')
    .action(
      act(async (ctx) => {
        const r = await ctx.client().tokens();
        ctx.print(r, () =>
          r.items.length
            ? r.items.map((t) => `- ${t.id} · ${t.name} · ${t.role} · ${t.prefix}…`).join('\n')
            : 'No tokens.',
        );
      }),
    );
  token
    .command('revoke')
    .argument('<id>')
    .description('Revoke a token')
    .action(
      act(async (ctx, [id]) => {
        const r = await ctx.client().revokeToken(required(id, 'token id'));
        ctx.print(r, () => `Revoked ${r.revoked}.`);
      }),
    );

  // ─── Claude Code ───────────────────────────────────────────────────────────
  program
    .command('hook')
    .argument('<event>', HOOK_EVENTS.join(' | '))
    .option('--subagent', 'SubagentStop mode for `stop` (warn only)')
    .description('Run a Claude Code hook (reads the hook JSON on stdin)')
    .action(
      act(async (ctx, [event]) => {
        if (!(HOOK_EVENTS as readonly string[]).includes(event as string))
          throw new CliUsageError(
            `Unknown hook event '${event}'. Use one of: ${HOOK_EVENTS.join(', ')}.`,
          );
        const input = parseHookInput(await ctx.io.readStdin());
        const ms = Number(
          ctx.io.env.AGENT_GRAPHS_HOOK_TIMEOUT_MS ??
            (event === 'post-tool-use' || event === 'heartbeat' ? 2000 : 5000),
        );
        const client = clientFor(ctx.io, ctx.opts, {
          fetch: timeoutFetch(ctx.io.fetch ?? ((...a) => fetch(...a)), ms),
          client: 'hook',
        });
        const r = await runHook(event as HookEvent, input, {
          client,
          env: ctx.io.env,
          cwd: ctx.io.cwd,
          now: ctx.io.now?.() ?? Date.now(),
          subagent: Boolean(ctx.opts.subagent),
        });
        if (r.stdout) ctx.io.out(r.stdout);
        ctx.setExit(r.code);
      }),
    );

  const claude = program.command('claude').description('Claude Code integration');
  claude
    .command('install')
    .option('--dir <dir>', 'target repository', '.')
    .option(
      '--command <cmd>',
      'how to run agraph (default: node <this checkout>/packages/cli/bin/agraph.js)',
    )
    .option('--npx', 'use `npx -y agent-graphs` (after npm packaging)')
    .addOption(new Option('--profile <profile>', 'MCP tool profile').choices([...MCP_PROFILES]))
    .option('--no-mcp', 'skip .mcp.json')
    .option('--no-hooks', 'skip .claude/settings.json hooks')
    .option('--no-skill', 'skip the agent-graphs skill')
    .description('Write or merge .mcp.json, hook settings, and the skill into a repository')
    .action(
      act(async (ctx) => {
        const saved = readConfig(ctx.io.env);
        const report = installClaude(
          defined({
            dir: resolve(ctx.io.cwd, str(ctx.opts.dir) ?? '.'),
            url:
              ctx.opts.url ?? ctx.io.env.AGENT_GRAPHS_URL ?? saved.url ?? 'http://localhost:4747',
            command: ctx.opts.npx ? 'npx -y agent-graphs' : str(ctx.opts.command),
            profile: str(ctx.opts.profile),
            actor: ctx.opts.actor,
            mcp: ctx.opts.mcp !== false,
            hooks: ctx.opts.hooks !== false,
            skill: ctx.opts.skill !== false,
          }),
        );
        ctx.print({ files: report }, () =>
          [
            ...report.map((f) => `${f.action.padEnd(9)} ${f.path}`),
            'Restart Claude Code in that repository; run /mcp to check the agent-graphs server.',
          ].join('\n'),
        );
      }),
    );

  // ─── Database ──────────────────────────────────────────────────────────────
  const db = program.command('db').description('Backups and exports');
  db.command('backup')
    .option('--data <dir>', 'data directory (DATA_DIR)')
    .option('--out <file>', 'backup file')
    .description('Online backup of the local SQLite database')
    .action(
      act(async (ctx) => {
        const { loadConfig, openDatabase } = await import('@agent-graphs/server');
        const config = loadConfig(
          ctx.io.env as NodeJS.ProcessEnv,
          str(ctx.opts.data) ? { dataDir: resolve(ctx.io.cwd, str(ctx.opts.data) as string) } : {},
        );
        const stamp = new Date(ctx.io.now?.() ?? Date.now()).toISOString().replace(/[:.]/g, '-');
        const out = resolve(
          ctx.io.cwd,
          str(ctx.opts.out) ?? join(config.dataDir, 'backups', `agent-graphs-${stamp}.sqlite`),
        );
        mkdirSync(resolve(out, '..'), { recursive: true });
        const sqlite = openDatabase(config.databasePath);
        try {
          await sqlite.backup(out);
        } finally {
          sqlite.close();
        }
        ctx.print(
          { backup: out, from: config.databasePath },
          () => `Backed up ${config.databasePath} → ${out}`,
        );
      }),
    );
  db.command('export')
    .option('--out <dir>', 'output directory', 'agent-graphs-export')
    .option('--graph <graph>', 'only this graph')
    .description('Export audit bundles (JSONL: spec, entities, hash-chained events) via the API')
    .action(
      act(async (ctx) => {
        const client = ctx.client();
        const dir = resolve(ctx.io.cwd, str(ctx.opts.out) ?? 'agent-graphs-export');
        mkdirSync(dir, { recursive: true });
        const refs = str(ctx.opts.graph)
          ? [str(ctx.opts.graph) as string]
          : (await client.listGraphs({ archived: 'all' })).items.map((g) => g.slug ?? g.id);
        const files: string[] = [];
        for (const ref of refs) {
          const file = join(dir, `${ref}.jsonl`);
          writeFileSync(file, await client.exportAudit(ref));
          files.push(file);
        }
        ctx.print({ files }, () => `Exported ${files.length} graph(s) to ${dir}`);
      }),
    );

  // ─── Simulator ─────────────────────────────────────────────────────────────
  program
    .command('simulate')
    .argument('<spec>', 'spec file to create, or an existing graph slug/id with --existing')
    .option('--profile <names>', 'comma-separated agent profiles (see --list-profiles)')
    .option('--workers <n>', 'number of simulated workers', '3')
    .option('--speed <x>', 'time compression: simulated seconds per real second', '60')
    .option('--seed <n>', 'random seed', '1')
    .option('--existing', 'drive an existing graph instead of creating one')
    .option('--no-human', 'do not auto-resolve human requests')
    .option('--max-minutes <n>', 'stop after this many real minutes', '30')
    .description('Drive a graph on a live server with simulated agents (demos)')
    .action(
      act(async (ctx, [specArg]) => {
        const { runLive } = await import('@agent-graphs/simulator');
        const client = ctx.client();
        const spec = ctx.opts.existing
          ? undefined
          : readFileSync(resolve(ctx.io.cwd, required(specArg, 'spec')), 'utf8');
        const result = await runLive({
          client,
          ...(spec ? { spec } : { graph: required(specArg, 'graph') }),
          profiles: list(ctx.opts.profile),
          workers: num(ctx.opts.workers) ?? 3,
          speed: num(ctx.opts.speed) ?? 60,
          seed: num(ctx.opts.seed) ?? 1,
          human: ctx.opts.human !== false,
          maxRealMs: (num(ctx.opts.maxMinutes) ?? 30) * 60_000,
          log: ctx.json ? undefined : (line: string) => ctx.io.out(line),
        });
        ctx.print(
          result,
          () =>
            `Simulation finished: graph ${result.graph} is ${result.status} after ${result.ticks} ticks.`,
        );
      }),
    );

  return program;
}

function renderGraph(v: GraphView): string {
  const g = v.graph;
  const lines = [
    `# ${g.title} (${g.slug ?? g.id}) · ${g.status}${g.stalled ? ' · stalled' : ''}${g.pendingApproval ? ' · awaiting plan approval' : ''}`,
    `Progress ${Math.round(g.progress * 100)}% · cost $${g.costUsd.toFixed(2)} · revision ${g.revision}`,
    '',
    '## Nodes',
  ];
  for (const n of v.nodes) {
    const a = n.currentAttempt;
    const holder =
      a?.status === 'running'
        ? ` · ${a.executor.model ?? a.executor.agent ?? 'agent'} ${a.progress ?? 0}%`
        : '';
    const loop = n.loop ? ` · ↺ ${n.loop.key} ${n.loop.iteration}/${n.loop.max}` : '';
    lines.push(`- ${n.key} · ${n.status} · ${n.title}${holder}${loop}`);
  }
  if (v.loops.length) {
    lines.push('', '## Loops');
    for (const l of v.loops)
      lines.push(
        `- ${l.key} · ${l.status} · ${l.iteration}/${l.maxIterations + l.grantedIterations}`,
      );
  }
  const open = v.requests.filter((r) => r.status === 'open');
  if (open.length) {
    lines.push('', '## Open requests');
    lines.push(...open.map(format.requestLine));
  }
  return lines.join('\n');
}

function renderNode(d: NodeDetail): string {
  const lines = [
    `# ${d.title} (${d.key}) · ${d.kind} · ${d.status}${d.statusReason ? ` (${d.statusReason})` : ''}`,
    d.aim ? `Aim: ${d.aim}` : '',
    d.purpose ? `Purpose: ${d.purpose}` : '',
    `Attempts: ${d.countedAttempts}/${d.maxAttempts} counted · ${d.attemptsTotal} total · activation ${d.activation}`,
    '',
    '## Aims',
    ...d.aims.map(
      (a) =>
        `- ${a.key} · ${a.status} · ${a.title}${a.metric ? ` (${a.metric} ${a.comparator} ${a.target}${a.currentValue !== undefined ? `, last ${a.currentValue}` : ''})` : ` (${a.evaluator})`}`,
    ),
  ];
  if (d.attempts.length) {
    lines.push('', '## Attempts');
    for (const a of d.attempts)
      lines.push(
        `- ${a.id} #${a.number} · ${a.status} · ${a.executor.model ?? a.executor.agent ?? ''}${a.summary ? ` · ${a.summary}` : ''}`,
      );
  }
  return lines.filter((l, i) => l !== '' || i > 3).join('\n');
}

/** Run the CLI in-process. Returns the exit code; never throws. */
export async function runCli(argv: string[], io: Io): Promise<number> {
  const state: CliState = { exitCode: 0 };
  const program = buildProgram(io, state);
  try {
    await program.parseAsync(argv, { from: 'user' });
    return state.exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (
        error.code === 'commander.helpDisplayed' ||
        error.code === 'commander.version' ||
        error.code === 'commander.help'
      )
        return 0;
      return error.exitCode || 2;
    }
    const d = describeError(error);
    if (argv.includes('--json')) io.out(JSON.stringify(d.json, null, 2));
    else io.err(d.text);
    return d.code;
  }
}
