/**
 * YAML scenarios (docs/architecture.md §7): a spec, simulated agents with scripted outcomes,
 * timed actions, and expectations on final statuses, events, and invariants. Scenarios run
 * against any SimHost; tests use an in-memory server with a fake clock.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { AgentGraphsError } from '@agent-graphs/sdk';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { SimHuman } from './agents/human';
import { SimJudge } from './agents/judge';
import { SimLead } from './agents/lead';
import { SimWorker } from './agents/worker';
import { checkInvariants } from './invariants';
import { annotationOf, profileByName, type SimulatedAgentProfile } from './profiles';
import { type SimAgent, simulate } from './simulation';
import { type SimHost, TERMINAL_GRAPH, World } from './world';

const Outcome = z.enum(['pass', 'fail', 'error', 'crash', 'block', 'release', 'question']);
const Policy = z.object({
  gateRejectRate: z.number().min(0).max(1).optional(),
  maxRetries: z.number().int().min(0).optional(),
  maxExtends: z.number().int().min(0).optional(),
  guard: z.enum(['raise', 'waive', 'fail']).optional(),
  plan: z.enum(['approve', 'reject']).optional(),
  verification: z.enum(['accept', 'fail']).optional(),
});
const ProfileOverrides = z.object({
  profile: z.string().optional(),
  failureRate: z.number().min(0).max(1).optional(),
  errorRate: z.number().min(0).max(1).optional(),
  crashRate: z.number().min(0).max(1).optional(),
  blockRate: z.number().min(0).max(1).optional(),
  questionRate: z.number().min(0).max(1).optional(),
  strictness: z.number().min(0).max(1).optional(),
  durationMinutes: z
    .object({ min: z.number().int().min(1), max: z.number().int().min(1) })
    .optional(),
  costPerMinute: z.number().min(0).optional(),
  skills: z.array(z.string()).optional(),
});
const Condition = z.object({
  graph: z.string().optional(),
  node: z.string().optional(),
  status: z.string().optional(),
  event: z.string().optional(),
});

const Step = z
  .object({
    at: z.number().min(0).optional().describe('simulated minute'),
    when: Condition.optional(),
    action: z.enum([
      'directive',
      'pause',
      'resume',
      'cancel',
      'start',
      'mutate',
      'patch-node',
      'skip-node',
      'retry-node',
      'extend-loop',
      'graph-metrics',
    ]),
    as: z.string().optional().describe('admin (default), agent, or an orchestrator key'),
    node: z.string().optional(),
    loop: z.string().optional(),
    kind: z.string().optional(),
    title: z.string().optional(),
    body: z.string().optional(),
    reason: z.string().optional(),
    batch: z.record(z.string(), z.unknown()).optional(),
    patch: z.record(z.string(), z.unknown()).optional(),
    metrics: z.record(z.string(), z.number()).optional(),
    extra: z.number().int().min(1).optional(),
    expectError: z.string().optional(),
  })
  .strict();

export const ScenarioSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    spec: z.string().optional(),
    specFile: z.string().optional(),
    seed: z.number().int().optional(),
    tickMinutes: z.number().min(0.1).optional(),
    maxTicks: z.number().int().min(1).optional(),
    start: z.union([z.enum(['admin', 'agent']), z.literal(false)]).optional(),
    agents: z
      .object({
        workers: z
          .array(ProfileOverrides.extend({ count: z.number().int().min(1).optional() }))
          .optional(),
        judges: z
          .array(ProfileOverrides.extend({ orchestrator: z.string().optional() }))
          .optional(),
        lead: Policy.extend({
          orchestrator: z.string().default('lead'),
          profile: z.string().optional(),
          subagents: z.array(z.string()).optional(),
          maxSubagents: z.number().int().min(1).optional(),
          resolve: z.boolean().optional(),
          crashRate: z.number().min(0).max(1).optional(),
        }).optional(),
        human: z
          .union([
            z.literal(false),
            Policy.extend({
              name: z.string().optional(),
              delayMinutes: z.number().min(0).optional(),
              includeOrchestrator: z.boolean().optional(),
            }),
          ])
          .optional(),
      })
      .default({}),
    outcomes: z.record(z.string(), z.array(Outcome)).optional(),
    verdicts: z.record(z.string(), z.array(z.enum(['met', 'unmet']))).optional(),
    gates: z.record(z.string(), z.array(z.enum(['approve', 'reject']))).optional(),
    script: z.array(Step).optional(),
    until: z
      .object({
        graph: z.union([z.string(), z.array(z.string())]).optional(),
        nodes: z.record(z.string(), z.string()).optional(),
      })
      .optional(),
    expect: z
      .object({
        graph: z.string().optional(),
        nodes: z.record(z.string(), z.string()).optional(),
        loops: z
          .record(
            z.string(),
            z.object({ iteration: z.number().optional(), status: z.string().optional() }),
          )
          .optional(),
        events: z
          .object({
            include: z.array(z.string()).optional(),
            exclude: z.array(z.string()).optional(),
            min: z.record(z.string(), z.number()).optional(),
          })
          .optional(),
        stats: z.record(z.string(), z.number()).optional(),
        requests: z.record(z.string(), z.number()).optional(),
        audit: z.boolean().optional(),
        invariants: z.boolean().optional(),
        errors: z.number().int().optional(),
      })
      .default({}),
  })
  .strict();

export type Scenario = z.infer<typeof ScenarioSchema> & { specText: string };

/** Parse a scenario file (resolving `specFile` relative to it). */
export function loadScenario(path: string): Scenario {
  return parseScenario(readFileSync(path, 'utf8'), dirname(path));
}

export function parseScenario(text: string, baseDir = '.'): Scenario {
  const parsed = ScenarioSchema.parse(parseYaml(text));
  const specText =
    parsed.spec ??
    (parsed.specFile ? readFileSync(resolve(baseDir, parsed.specFile), 'utf8') : undefined);
  if (!specText) throw new Error(`Scenario '${parsed.name}' needs spec or specFile.`);
  return { ...parsed, specText };
}

export type ScenarioResult = {
  name: string;
  passed: boolean;
  failures: string[];
  ticks: number;
  status: string;
  stats: World['stats'];
  log: string[];
  actions: Array<{ minute: number; action: string; ok: boolean; code?: string }>;
};

function withOverrides(
  base: SimulatedAgentProfile,
  o: z.infer<typeof ProfileOverrides>,
): SimulatedAgentProfile {
  const { profile: _p, ...rest } = o;
  return {
    ...base,
    ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)),
  };
}

export async function runScenario(
  scenario: Scenario,
  host: SimHost,
  options: { log?: (line: string) => void } = {},
): Promise<ScenarioResult> {
  const world = new World(host, {
    seed: scenario.seed ?? 1,
    scripts: defined({
      outcomes: scenario.outcomes,
      verdicts: scenario.verdicts,
      gates: scenario.gates,
    }),
    ...(options.log ? { log: options.log } : {}),
  });
  const failures: string[] = [];
  const actions: ScenarioResult['actions'] = [];
  const startedAt = host.now();
  const minute = () => Math.round((host.now() - startedAt) / 60_000);

  await world.setupAgentToken();
  const created = await world.admin().createGraph(scenario.specText);
  world.graph = created.graph.slug ?? created.graph.id;
  world.log(`created ${world.graph} (${created.nodes.length} nodes)`);
  if (scenario.start !== false) {
    const starter = scenario.start === 'agent' ? world.agent() : world.admin();
    const r = await starter.graphAction(world.graph, 'start');
    world.log(
      `start (${scenario.start ?? 'admin'}) → ${r.graph.status}${r.graph.pendingApproval ? ' (plan approval requested)' : ''}`,
    );
  }

  // Agents
  const agents: SimAgent[] = [];
  const a = scenario.agents;
  const human = a.human === false ? undefined : new SimHuman(world, a.human ?? {});
  if (human) agents.push(human);
  let lead: SimLead | undefined;
  if (a.lead) {
    lead = new SimLead(world, {
      ...a.lead,
      profile: profileByName(a.lead.profile, 'lead'),
      subagents: (a.lead.subagents ?? ['reliable-worker']).map((n) => {
        const p = profileByName(n);
        return a.lead?.crashRate !== undefined ? { ...p, crashRate: a.lead.crashRate } : p;
      }),
    });
    agents.push(lead);
  }
  (a.judges ?? []).forEach((j, i) => {
    agents.push(
      new SimJudge(world, {
        name: `judge-${i + 1}`,
        profile: withOverrides(profileByName(j.profile, 'judge'), j),
        ...(j.orchestrator ? { orchestrator: j.orchestrator } : {}),
      }),
    );
  });
  let n = 0;
  for (const w of a.workers ?? []) {
    const profile = withOverrides(profileByName(w.profile, 'reliable-worker'), w);
    for (let i = 0; i < (w.count ?? 1); i++)
      agents.push(new SimWorker(world, { name: `${profile.name}-${++n}`, profile }));
  }

  // Scripted actions
  const pending = [...(scenario.script ?? [])];
  const orchSessions = new Map<string, string>();
  const clientFor = async (as: string | undefined) => {
    if (!as || as === 'admin') return world.admin('Scenario admin');
    if (as === 'agent') return world.agent();
    if (lead?.key === as && lead.session) return world.agent(lead.session);
    let session = orchSessions.get(as);
    if (!session) {
      const r = await world.agent().attach(world.graph, as, {
        ...annotationOf(profileByName('lead'), `script-${as}`),
        clientSessionId: `script-${as}`,
      });
      session = r.session;
      orchSessions.set(as, session);
    }
    return world.agent(session);
  };
  const eventSeen = async (type: string) =>
    (await world.admin().events(world.graph, { types: type, limit: 1 })).items.length > 0;
  const due = async (s: z.infer<typeof Step>): Promise<boolean> => {
    if (s.at !== undefined && minute() < s.at) return false;
    const c = s.when;
    if (!c) return true;
    if (c.graph && world.view?.graph.status !== c.graph) return false;
    if (c.node) {
      const node = world.view?.nodes.find((x) => x.key === c.node);
      if (!node || (c.status && node.status !== c.status)) return false;
    }
    if (c.event && !(await eventSeen(c.event))) return false;
    return true;
  };
  const run = async (s: z.infer<typeof Step>) => {
    const c = await clientFor(s.as);
    const g = world.graph;
    switch (s.action) {
      case 'directive':
        return c.sendDirective(g, {
          target: s.node ? { type: 'node', key: s.node } : { type: 'graph' },
          kind: (s.kind ?? 'guidance') as 'guidance',
          title: s.title ?? 'Guidance',
          ...(s.body ? { body: s.body } : {}),
        });
      case 'pause':
      case 'resume':
      case 'cancel':
      case 'start':
        return c.graphAction(g, s.action, s.reason);
      case 'mutate':
        return c.mutate(g, (s.batch ?? {}) as never);
      case 'patch-node':
        return c.patchNode(g, s.node as string, s.patch ?? {});
      case 'skip-node':
        return c.nodeAction(g, s.node as string, 'skip', { reason: s.reason ?? 'not needed' });
      case 'retry-node':
        return c.nodeAction(g, s.node as string, 'retry', { extraAttempts: s.extra ?? 1 });
      case 'extend-loop':
        return c.extendLoop(g, s.loop as string, s.extra ?? 1, s.reason);
      case 'graph-metrics':
        return c.reportGraphMetrics(g, s.metrics ?? {});
    }
  };
  const beforeAgents = async () => {
    for (let i = 0; i < pending.length; i++) {
      const s = pending[i] as z.infer<typeof Step>;
      if (!(await due(s))) continue;
      pending.splice(i--, 1);
      let code: string | undefined;
      try {
        await run(s);
      } catch (error) {
        code = error instanceof AgentGraphsError ? error.code : 'ERROR';
        if (!s.expectError)
          failures.push(
            `action ${s.action}: ${error instanceof AgentGraphsError ? error.describe() : String(error)}`,
          );
      }
      if (s.expectError && code !== s.expectError)
        failures.push(`action ${s.action}: expected ${s.expectError}, got ${code ?? 'success'}`);
      actions.push({
        minute: minute(),
        action: s.action,
        ok: code === undefined,
        ...(code ? { code } : {}),
      });
      world.log(
        `script: ${s.action}${s.node ? ` ${s.node}` : ''}${s.as ? ` as ${s.as}` : ''} → ${code ?? 'ok'}`,
      );
    }
  };

  const untilGraph = scenario.until?.graph;
  const untilStatuses = untilGraph
    ? Array.isArray(untilGraph)
      ? untilGraph
      : [untilGraph]
    : undefined;
  const until = (w: World) => {
    const status = w.view?.graph.status ?? 'draft';
    if (pending.length && !TERMINAL_GRAPH.has(status)) return false;
    if (untilStatuses && !untilStatuses.includes(status)) return TERMINAL_GRAPH.has(status);
    for (const [key, s] of Object.entries(scenario.until?.nodes ?? {}))
      if (w.view?.nodes.find((x) => x.key === key)?.status !== s) return false;
    return untilStatuses || scenario.until?.nodes ? true : TERMINAL_GRAPH.has(status);
  };

  const sim = await simulate({
    world,
    agents,
    tickMs: (scenario.tickMinutes ?? 1) * 60_000,
    maxTicks: scenario.maxTicks ?? 720,
    until,
    beforeAgents,
  });
  if (pending.length) failures.push(`${pending.length} scripted action(s) never ran`);

  // Expectations
  await world.refresh();
  const e = scenario.expect;
  const view = world.view;
  if (e.graph && view?.graph.status !== e.graph)
    failures.push(`graph status: expected ${e.graph}, got ${view?.graph.status}`);
  for (const [key, status] of Object.entries(e.nodes ?? {})) {
    const node = view?.nodes.find((x) => x.key === key);
    if (node?.status !== status)
      failures.push(`node ${key}: expected ${status}, got ${node?.status}`);
  }
  for (const [key, want] of Object.entries(e.loops ?? {})) {
    const loop = view?.loops.find((l) => l.key === key);
    if (!loop) failures.push(`loop ${key} not found`);
    else {
      if (want.iteration !== undefined && loop.iteration !== want.iteration)
        failures.push(`loop ${key}: expected iteration ${want.iteration}, got ${loop.iteration}`);
      if (want.status && loop.status !== want.status)
        failures.push(`loop ${key}: expected ${want.status}, got ${loop.status}`);
    }
  }
  if (e.events) {
    const counts = new Map<string, number>();
    let after = 0;
    for (;;) {
      const page = await world.admin().events(world.graph, { after, limit: 1000 });
      for (const ev of page.items) counts.set(ev.type, (counts.get(ev.type) ?? 0) + 1);
      if (page.items.length < 1000 || page.nextCursor === null) break;
      after = page.nextCursor;
    }
    for (const t of e.events.include ?? []) if (!counts.get(t)) failures.push(`missing event ${t}`);
    for (const t of e.events.exclude ?? [])
      if (counts.get(t)) failures.push(`unexpected event ${t} (×${counts.get(t)})`);
    for (const [t, min] of Object.entries(e.events.min ?? {}))
      if ((counts.get(t) ?? 0) < min)
        failures.push(`event ${t}: expected ≥${min}, got ${counts.get(t) ?? 0}`);
  }
  for (const [k, min] of Object.entries(e.stats ?? {})) {
    const v = (world.stats as Record<string, number>)[k];
    if (v === undefined) failures.push(`unknown stat ${k}`);
    else if (v < min) failures.push(`stat ${k}: expected ≥${min}, got ${v}`);
  }
  if (e.requests) {
    const resolved = (await world.admin().requests({ graph: world.graph, status: 'resolved' }))
      .items;
    for (const [subject, min] of Object.entries(e.requests)) {
      const count = resolved.filter((r) => (r as { subject?: string }).subject === subject).length;
      if (count < min)
        failures.push(`resolved ${subject} requests: expected ≥${min}, got ${count}`);
    }
  }
  if (e.audit !== false) {
    const audit = await world.admin().verifyAudit(world.graph);
    if (!audit.ok) failures.push(`audit verify failed at seq ${audit.firstMismatch}`);
  }
  if (e.invariants !== false) failures.push(...(await checkInvariants(world.admin(), world.graph)));
  const allowedErrors = e.errors ?? 0;
  if (world.errors.length > allowedErrors)
    failures.push(
      `unexpected agent errors (${world.errors.length}):\n  ${world.errors.slice(0, 5).join('\n  ')}`,
    );

  return {
    name: scenario.name,
    passed: failures.length === 0,
    failures,
    ticks: sim.ticks,
    status: view?.graph.status ?? 'unknown',
    stats: world.stats,
    log: world.lines,
    actions,
  };
}

function defined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
