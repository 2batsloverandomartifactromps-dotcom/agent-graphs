/**
 * A simulated lead orchestrator (docs/agent-protocol.md §3): attaches, dispatches ready nodes
 * to subagents on their behalf, resolves what it may by policy, and writes handoffs.
 */
import { annotationOf, profileByName, type SimulatedAgentProfile } from '../profiles';
import type { World } from '../world';
import { type ResolutionPolicy, Resolver } from './policy';
import { SimWorker } from './worker';

export type LeadOptions = ResolutionPolicy & {
  name?: string;
  orchestrator: string;
  profile: SimulatedAgentProfile;
  /** Profiles for dispatched subagents (round-robin). */
  subagents?: SimulatedAgentProfile[];
  /** Concurrent subagents. */
  maxSubagents?: number;
  /** Resolve requests from the duty queue (needs `resolve`/`approve`). */
  resolve?: boolean;
  noCrashes?: boolean;
};

export class SimLead {
  readonly name: string;
  session: string | undefined;
  private readonly workers: SimWorker[] = [];
  private readonly resolver: Resolver;
  private lastHeartbeat = 0;
  private lastHandoff = 0;
  private spawned = 0;

  constructor(
    private readonly world: World,
    private readonly options: LeadOptions,
  ) {
    this.name = options.name ?? `${options.orchestrator}-orchestrator`;
    this.resolver = new Resolver(world, options, 'orchestrator');
  }

  get key(): string {
    return this.options.orchestrator;
  }

  async step(): Promise<void> {
    const w = this.world;
    const status = w.view?.graph.status;
    if (!status || status === 'draft') return;
    const now = w.now();
    const key = this.options.orchestrator;
    if (!this.session) {
      const r = await w.attempt(this.name, `attach ${key}`, () =>
        w.agent().attach(w.graph, key, {
          ...annotationOf(this.options.profile, this.name),
          clientSessionId: `sim-${this.name}`,
        }),
      );
      if (!r) return;
      this.session = r.session;
      this.lastHeartbeat = now;
      this.lastHandoff = now;
      w.log(`${this.name} attached as ${key} (${r.queue.length} duties)`);
    } else if (now - this.lastHeartbeat >= 10 * 60_000) {
      this.lastHeartbeat = now;
      const hb = await w.attempt(this.name, 'heartbeat', () =>
        w.agent(this.session).orchestratorHeartbeat(w.graph, key),
      );
      if (!hb) {
        this.session = undefined;
        return;
      }
    }

    for (const sub of this.workers) await sub.step();
    for (let i = this.workers.length - 1; i >= 0; i--)
      if (this.workers[i]?.done) this.workers.splice(i, 1);

    const queue = await w.attempt(this.name, 'queue', () => w.agent().queue(w.graph, key));
    const lead = w.agent(this.session);
    const max = this.options.maxSubagents ?? 3;
    for (const item of queue?.items ?? []) {
      if (item.kind === 'dispatch' && item.nodeKey && this.workers.length < max) {
        const profile = this.subagentProfile();
        const agent = `${profile.name}-sub-${++this.spawned}`;
        const claim = await w.attempt(this.name, `dispatch ${item.nodeKey}`, () =>
          lead.claim(w.graph, item.nodeKey as string, {
            actor: annotationOf(profile, agent),
            dispatchedBy: key,
            skills:
              profile.skills ??
              w.view?.nodes.find((x) => x.key === item.nodeKey)?.executor.requires ??
              [],
          }),
        );
        if (!claim) continue;
        w.stats.dispatches++;
        w.stats.claims++;
        w.log(`${this.name} dispatched ${item.nodeKey} to ${agent} (${claim.attempt.id})`);
        this.workers.push(
          new SimWorker(w, {
            name: agent,
            profile,
            dispatched: { attemptId: claim.attempt.id, nodeKey: item.nodeKey },
            ...(this.options.noCrashes ? { noCrashes: true } : {}),
          }),
        );
      } else if ((item.kind === 'resolve' || item.kind === 'approve') && item.requestId) {
        if (this.options.resolve === false) continue;
        const request = w.openRequests.find((r) => r.id === item.requestId);
        if (!request) continue;
        const decision = this.resolver.decide(request);
        if (!decision) continue;
        const out = await w.attempt(this.name, `resolve ${request.id}`, () =>
          lead.resolveRequest(request.id, decision),
        );
        if (out) {
          w.stats.resolutions++;
          w.log(`${this.name} resolved "${request.title}" → ${decision.choice}`);
        }
      }
    }

    if (now - this.lastHandoff >= 60 * 60_000) {
      this.lastHandoff = now;
      await w.attempt(this.name, 'handoff', () =>
        lead.orchestratorNote(w.graph, key, {
          type: 'handoff',
          title: `Lead handoff · ${this.workers.length} subagent(s) running`,
          body: `Running: ${this.workers.map((s) => s.name).join(', ') || 'none'}. Next: keep dispatching ready nodes and resolve escalations.`,
        }),
      );
    }
  }

  private subagentProfile(): SimulatedAgentProfile {
    const list = this.options.subagents?.length
      ? this.options.subagents
      : [profileByName('sonnet-worker')];
    return list[this.spawned % list.length] as SimulatedAgentProfile;
  }
}
