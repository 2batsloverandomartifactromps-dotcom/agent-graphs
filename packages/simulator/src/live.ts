/**
 * Live demos (`agraph simulate`): drive a graph on a running server with simulated agents,
 * compressing time so the UI shows realistic progress, loops, escalations, and notes.
 */
import { type AgentGraphsClient, AgentGraphsError } from '@agent-graphs/sdk';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { SimHuman } from './agents/human';
import { SimJudge } from './agents/judge';
import { SimLead } from './agents/lead';
import { SimWorker } from './agents/worker';
import { DEFAULT_PROFILES, profileByName, type SimulatedAgentProfile } from './profiles';
import { type SimAgent, simulate } from './simulation';
import { World } from './world';

export type LiveOptions = {
  /** A client for the server (its token is used as the admin token when present). */
  client: AgentGraphsClient;
  /** Spec text to create (YAML or JSON), or an existing graph with `graph`. */
  spec?: string;
  graph?: string;
  /** Worker profile names (round-robin); defaults to the built-in worker profiles. */
  profiles?: string[];
  workers?: number;
  /** Simulated seconds per real second. */
  speed?: number;
  seed?: number;
  human?: boolean;
  /** Wall-clock limit. */
  maxRealMs?: number;
  log?: (line: string) => void;
};

export type LiveResult = { graph: string; status: string; ticks: number; stats: World['stats'] };

export async function runLive(options: LiveOptions): Promise<LiveResult> {
  const speed = Math.max(options.speed ?? 60, 1);
  let simNow = Date.now();
  const token = options.client.options.token;
  const world = new World(
    {
      baseUrl: options.client.baseUrl,
      ...(options.client.options.fetch ? { fetch: options.client.options.fetch } : {}),
      ...(token ? { adminToken: token } : {}),
      now: () => simNow,
      advance: async (ms) => {
        simNow += ms;
        await new Promise((r) => setTimeout(r, ms / speed));
      },
    },
    { seed: options.seed ?? 1, ...(options.log ? { log: options.log } : {}) },
  );
  await world.setupAgentToken();

  if (options.spec) {
    world.graph = await createUnique(world, options.spec);
    const started = await world.agent().graphAction(world.graph, 'start');
    world.log(
      `started ${world.graph}: ${started.graph.status}${started.graph.pendingApproval ? ' (awaiting plan approval)' : ''}`,
    );
  } else if (options.graph) {
    world.graph = options.graph;
  } else throw new Error('Pass a spec or an existing graph.');

  await world.refresh();
  const view = world.view;
  const orchestrators = view?.orchestrators ?? [];
  const leadRole = orchestrators.find((o) => o.capabilities.includes('dispatch'));
  const judgeRole = orchestrators.find(
    (o) => o.key !== leadRole?.key && o.capabilities.includes('evaluate'),
  );
  const names = options.profiles?.length
    ? options.profiles
    : DEFAULT_PROFILES.filter(
        (p) => p.name.endsWith('-worker') && p.name !== 'reliable-worker',
      ).map((p) => p.name);
  const workerProfiles: SimulatedAgentProfile[] = names.map((n) => profileByName(n));
  const count = Math.max(options.workers ?? 3, 1);

  const agents: SimAgent[] = [];
  if (options.human !== false)
    agents.push(
      new SimHuman(world, { delayMinutes: 3, gateRejectRate: 0.3, maxRetries: 1, maxExtends: 1 }),
    );
  if (leadRole) {
    agents.push(
      new SimLead(world, {
        orchestrator: leadRole.key,
        profile: profileByName('lead'),
        subagents: workerProfiles,
        maxSubagents: count,
        noCrashes: true,
        maxRetries: 1,
        maxExtends: 1,
      }),
    );
  } else {
    for (let i = 0; i < count; i++) {
      const profile = workerProfiles[i % workerProfiles.length] as SimulatedAgentProfile;
      agents.push(
        new SimWorker(world, { name: `${profile.name}-${i + 1}`, profile, noCrashes: true }),
      );
    }
  }
  agents.push(
    new SimJudge(world, {
      name: 'judge',
      profile: profileByName('judge'),
      ...(judgeRole ? { orchestrator: judgeRole.key } : {}),
    }),
  );

  const result = await simulate({
    world,
    agents,
    tickMs: 60_000,
    maxTicks: 100_000,
    ...(options.maxRealMs ? { deadline: Date.now() + options.maxRealMs } : {}),
  });
  return { graph: world.graph, status: result.status, ticks: result.ticks, stats: world.stats };
}

/** Create the graph; on a slug clash, retry with a suffixed slug. */
async function createUnique(world: World, spec: string): Promise<string> {
  try {
    const g = await world.agent().createGraph(spec);
    return g.graph.slug ?? g.graph.id;
  } catch (error) {
    if (!(error instanceof AgentGraphsError) || error.code !== 'CONFLICT') throw error;
    const doc = parseYaml(spec) as Record<string, unknown>;
    doc.slug = `${String(doc.slug ?? 'sim')}-${Date.now().toString(36)}`;
    const g = await world.agent().createGraph(stringifyYaml(doc));
    return g.graph.slug ?? g.graph.id;
  }
}
