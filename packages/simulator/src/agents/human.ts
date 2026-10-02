/** A simulated human approver working the Inbox (requests assigned to humans or anyone). */
import type { World } from '../world';
import { type ResolutionPolicy, Resolver } from './policy';

export type HumanOptions = ResolutionPolicy & {
  name?: string;
  /** Simulated minutes before a request is answered. */
  delayMinutes?: number;
  /** Also resolve requests assigned to orchestrators (when no orchestrator is simulated). */
  includeOrchestrator?: boolean;
};

export class SimHuman {
  readonly name: string;
  private readonly firstSeen = new Map<string, number>();
  private readonly resolver: Resolver;

  constructor(
    private readonly world: World,
    private readonly options: HumanOptions = {},
  ) {
    this.name = options.name ?? 'Maintainer';
    this.resolver = new Resolver(world, options, 'human');
  }

  async step(): Promise<void> {
    const w = this.world;
    const now = w.now();
    const delay = (this.options.delayMinutes ?? 2) * 60_000;
    for (const r of w.openRequests) {
      if (r.assignee === 'orchestrator' && !this.options.includeOrchestrator) continue;
      if (!this.firstSeen.has(r.id)) this.firstSeen.set(r.id, now);
      if (now - (this.firstSeen.get(r.id) as number) < delay) continue;
      if (this.resolver.gaveUp(r.id)) continue;
      const decision = this.resolver.decide(r);
      if (!decision) continue;
      const out = await w.attempt(this.name, `resolve ${r.id}`, () =>
        w.admin(this.name).resolveRequest(r.id, decision),
      );
      if (!out) this.resolver.failed(r.id);
      else {
        w.stats.resolutions++;
        w.log(
          `${this.name} resolved ${r.kind}/${(r as { subject?: string }).subject} "${r.title}" → ${decision.choice}`,
        );
      }
    }
  }
}
