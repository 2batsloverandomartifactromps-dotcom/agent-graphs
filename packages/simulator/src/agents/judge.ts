/**
 * A simulated reviewer/judge: an independent session judging `agent`-evaluated aims, and
 * optionally an attached orchestrator role (e.g. `reviewer`) judging `orchestrator` aims.
 */
import { annotationOf, type SimulatedAgentProfile } from '../profiles';
import type { World } from '../world';

export type JudgeOptions = {
  name: string;
  profile: SimulatedAgentProfile;
  /** Attach as this orchestrator role (capability `evaluate`) to judge its aims. */
  orchestrator?: string;
};

export class SimJudge {
  readonly name: string;
  private session: string | undefined;
  private orchSession: string | undefined;
  private lastHeartbeat = 0;

  constructor(
    private readonly world: World,
    private readonly options: JudgeOptions,
  ) {
    this.name = options.name;
  }

  private verdict(nodeKey: string): 'met' | 'unmet' {
    const scripted = this.world.nextVerdict(nodeKey);
    if (scripted) return scripted;
    return this.world.rng.chance(this.options.profile.strictness) ? 'unmet' : 'met';
  }

  private async judge(
    session: string,
    attemptId: string,
    nodeKey: string,
    aim: string,
    title: string,
  ) {
    const w = this.world;
    const verdict = this.verdict(nodeKey);
    const r = await w.attempt(this.name, `evaluate ${attemptId}/${aim}`, () =>
      w.agent(session).evaluate(attemptId, {
        aim,
        verdict,
        rationale:
          verdict === 'met'
            ? `Meets the criteria for "${title}"; evidence reviewed.`
            : `Does not meet "${title}": handlers still contain business logic in two routes; move it into services.`,
      }),
    );
    if (r) {
      w.stats.verdicts++;
      w.log(`${this.name} judged ${nodeKey}/${aim} → ${verdict}`);
    }
  }

  async step(): Promise<void> {
    const w = this.world;
    if (!w.view || w.view.graph.status === 'draft') return;
    const annotation = annotationOf(this.options.profile, this.name);
    if (!this.session) {
      const reg = await w.attempt(this.name, 'register', () =>
        w.agent().registerSession(annotation),
      );
      if (!reg) return;
      this.session = reg.session.id;
    }
    const pending = await w.attempt(this.name, 'pending evaluations', () =>
      w.agent(this.session).pendingEvaluations(w.graph),
    );
    for (const p of pending?.items ?? [])
      for (const aim of p.aims)
        await this.judge(this.session, p.attempt.id, p.node.key, aim.key, aim.title);

    const key = this.options.orchestrator;
    if (!key) return;
    const now = w.now();
    if (!this.orchSession) {
      const r = await w.attempt(this.name, `attach ${key}`, () =>
        w.agent().attach(w.graph, key, { ...annotation, clientSessionId: `sim-${this.name}` }),
      );
      if (!r) return;
      this.orchSession = r.session;
      this.lastHeartbeat = now;
      w.log(`${this.name} attached as ${key}`);
    } else if (now - this.lastHeartbeat >= 10 * 60_000) {
      this.lastHeartbeat = now;
      const hb = await w.attempt(this.name, `heartbeat ${key}`, () =>
        w.agent(this.orchSession).orchestratorHeartbeat(w.graph, key),
      );
      if (!hb) this.orchSession = undefined;
    }
    if (!this.orchSession) return;
    const queue = await w.attempt(this.name, 'queue', () => w.agent().queue(w.graph, key));
    for (const item of queue?.items ?? []) {
      if (item.kind !== 'evaluate' || !item.attemptId || !item.aimKey) continue;
      await this.judge(
        this.orchSession,
        item.attemptId,
        item.nodeKey ?? '',
        item.aimKey,
        item.title,
      );
    }
  }
}
