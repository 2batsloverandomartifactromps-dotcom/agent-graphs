/**
 * A simulated worker (docs/agent-protocol.md §2): claims work (or receives a dispatched
 * attempt), heartbeats, acks directives, asks questions, and finishes by submitting with
 * realistic metrics, verdicts, and notes — or fails, blocks, releases, or crashes.
 */
import type { AgentGraphsClient, Aim, Directive, NodeDetail } from '@agent-graphs/sdk';
import { satisfying, violating } from '../metrics';
import { annotationOf, type SimulatedAgentProfile } from '../profiles';
import type { Outcome, World } from '../world';

const HEARTBEAT_MS = 5 * 60_000;

type Job = {
  attemptId: string;
  nodeKey: string;
  plan: Outcome;
  ask: boolean;
  asked: boolean;
  startedAt: number;
  finishAt: number;
  lastHeartbeat: number;
};

export type WorkerOptions = {
  name: string;
  profile: SimulatedAgentProfile;
  /** A dispatched subagent: works only this attempt, then is done. */
  dispatched?: { attemptId: string; nodeKey: string };
  /** Disable crashes (live demos: leases expire in real time). */
  noCrashes?: boolean;
};

export class SimWorker {
  readonly name: string;
  done = false;
  private job: Job | undefined;
  private restarts = 0;
  private readonly profile: SimulatedAgentProfile;

  constructor(
    private readonly world: World,
    private readonly options: WorkerOptions,
  ) {
    this.name = options.name;
    this.profile = options.profile;
    if (options.dispatched)
      this.job = this.plan(options.dispatched.attemptId, options.dispatched.nodeKey);
  }

  get busy(): boolean {
    return this.job !== undefined;
  }

  private get client(): AgentGraphsClient {
    return this.world.agent();
  }

  private actor() {
    return {
      ...annotationOf(this.profile, this.name),
      clientSessionId: `sim-${this.name}-${this.restarts}`,
    };
  }

  private plan(attemptId: string, nodeKey: string): Job {
    const { rng } = this.world;
    const p = this.profile;
    let plan = this.world.nextOutcome(nodeKey);
    if (!plan) {
      const r = rng.next();
      const crash = this.options.noCrashes ? 0 : (p.crashRate ?? 0);
      const block = p.blockRate ?? 0;
      const error = p.errorRate ?? 0;
      if (r < crash) plan = 'crash';
      else if (r < crash + block) plan = 'block';
      else if (r < crash + block + error) plan = 'error';
      else if (r < crash + block + error + p.failureRate) plan = 'fail';
      else plan = 'pass';
    }
    const range = p.durationMinutes ?? { min: 5, max: 15 };
    const minutes = rng.int(range.min, range.max);
    const now = this.world.now();
    return {
      attemptId,
      nodeKey,
      plan,
      ask: plan === 'question' || rng.chance(p.questionRate),
      asked: false,
      startedAt: now,
      finishAt: now + minutes * 60_000,
      lastHeartbeat: now,
    };
  }

  async step(): Promise<void> {
    if (this.done) return;
    if (!this.job) {
      if (this.options.dispatched) {
        this.done = true;
        return;
      }
      await this.claim();
      return;
    }
    await this.work(this.job);
  }

  private async claim(): Promise<void> {
    const view = this.world.view;
    if (view?.graph.status !== 'active') return;
    if (!view.nodes.some((n) => n.status === 'ready' && n.kind === 'task')) return;
    const r = await this.world.attempt(this.name, 'claim', () =>
      this.client.next(this.world.graph, {
        actor: this.actor(),
        claim: true,
        skills: this.profile.skills ?? this.world.requiredSkills(),
        briefing: { budget: 3000 },
      }),
    );
    if (!r?.node || !r.attempt) return;
    this.world.stats.claims++;
    this.job = this.plan(r.attempt.id, r.node.key);
    this.world.log(`${this.name} claimed ${r.node.key} (${r.attempt.id}) · plan ${this.job.plan}`);
    for (const d of r.directives ?? []) await this.ack(d, this.job);
  }

  private async ack(d: Directive, job: Job): Promise<void> {
    if (!d.requiresAck) return;
    const ok = await this.world.attempt(this.name, `ack ${d.id}`, () =>
      this.client.ackDirective(d.id, {
        attemptId: job.attemptId,
        note: `Applied: ${d.title}`,
      }),
    );
    if (ok !== undefined) this.world.stats.directivesAcked++;
  }

  private end(): void {
    this.job = undefined;
    if (this.options.dispatched) this.done = true;
  }

  private async work(job: Job): Promise<void> {
    const now = this.world.now();
    const span = Math.max(job.finishAt - job.startedAt, 1);
    if (job.plan === 'crash' && now >= job.startedAt + span / 2) {
      this.world.stats.crashes++;
      this.world.log(
        `${this.name} crashed on ${job.nodeKey} (${job.attemptId}); the lease will expire`,
      );
      this.restarts++;
      this.end();
      return;
    }
    if (now - job.lastHeartbeat >= HEARTBEAT_MS || now >= job.finishAt) {
      job.lastHeartbeat = now;
      const progress = Math.min(99, Math.round(((now - job.startedAt) / span) * 100));
      const hb = await this.world.attempt(this.name, 'heartbeat', () =>
        this.client.heartbeat(job.attemptId, {
          progress,
          step: progress < 50 ? 'implementing' : 'testing',
          checkpoint: {
            done: progress < 50 ? ['plan'] : ['plan', 'implementation'],
            next: ['tests'],
          },
          usage: this.usage(job, now),
        }),
      );
      if (!hb) {
        this.world.log(`${this.name} lost ${job.attemptId} on ${job.nodeKey}`);
        this.end();
        return;
      }
      for (const d of hb.directives) await this.ack(d, job);
      if (hb.pauseRequested || hb.cancelRequested) {
        await this.world.attempt(this.name, 'release', () =>
          this.client.release(
            job.attemptId,
            hb.cancelRequested ? 'cancel requested' : 'pause requested',
            `Checkpoint at ${progress}%: implementation in progress; next: finish and run the tests.`,
          ),
        );
        this.world.stats.releases++;
        this.world.log(
          `${this.name} released ${job.nodeKey} (${hb.pauseRequested ? 'pause' : 'cancel'})`,
        );
        this.end();
        return;
      }
    }
    if (job.ask && !job.asked && now >= job.startedAt + span / 3) {
      job.asked = true;
      const q = await this.world.attempt(this.name, 'ask', () =>
        this.client.raiseRequest(this.world.graph, {
          kind: 'question',
          title: `${job.nodeKey}: which convention should I follow for error responses?`,
          body: 'The docs show two variants; I will use the error envelope unless told otherwise.',
          node: job.nodeKey,
          attempt: job.attemptId,
          assignee: 'any',
        }),
      );
      if (q) {
        this.world.stats.questions++;
        this.world.log(`${this.name} asked ${q.id} on ${job.nodeKey}`);
      }
    }
    if (now < job.finishAt) return;
    await this.finish(job, now);
  }

  private usage(job: Job, now: number) {
    const minutes = (now - job.startedAt) / 60_000;
    const cost = Math.round(minutes * (this.profile.costPerMinute ?? 0.02) * 1000) / 1000;
    return {
      costUsd: cost,
      inputTokens: Math.round(minutes * 9000),
      outputTokens: Math.round(minutes * 700),
      durationMs: now - job.startedAt,
    };
  }

  private async finish(job: Job, now: number): Promise<void> {
    const c = this.client;
    const w = this.world;
    switch (job.plan) {
      case 'block': {
        await w.attempt(this.name, 'block', () =>
          c.block(job.attemptId, 'Staging credentials are missing', {
            title: `${job.nodeKey}: need staging credentials`,
            body: 'Set STAGING_TOKEN in the environment, then unblock.',
          }),
        );
        w.stats.blocks++;
        w.log(`${this.name} blocked on ${job.nodeKey}`);
        this.end();
        return;
      }
      case 'error': {
        await w.attempt(this.name, 'fail', () =>
          c.fail(job.attemptId, 'The test runner crashed with an out-of-memory error.'),
        );
        w.stats.errorsReported++;
        w.log(`${this.name} reported an error on ${job.nodeKey}`);
        this.end();
        return;
      }
      case 'release': {
        await w.attempt(this.name, 'release', () =>
          c.release(job.attemptId, 'context window nearly full', 'Done: scaffolding. Next: tests.'),
        );
        w.stats.releases++;
        this.end();
        return;
      }
      default:
        await this.submit(job, now, job.plan !== 'fail');
        this.end();
    }
  }

  private async submit(job: Job, now: number, passing: boolean): Promise<void> {
    const w = this.world;
    const c = this.client;
    const detail: NodeDetail | undefined = await w.attempt(this.name, 'node detail', () =>
      c.getNode(w.graph, job.nodeKey),
    );
    if (!detail) return;
    if (detail.checklist.length) {
      await w.attempt(this.name, 'checklist', () =>
        c.checklist(
          job.attemptId,
          Object.fromEntries(
            detail.checklist.map((i) => [
              i.key,
              { done: true, evidence: [{ kind: 'text' as const, value: `${i.title}: done` }] },
            ]),
          ),
        ),
      );
    }
    const terminating = (detail.aims as Aim[]).filter((a) => a.terminating && !a.implicit);
    const metricAims = terminating.filter(
      (a) => a.kind === 'quantitative' && a.source !== 'derived' && a.metric,
    );
    const selfAims = terminating.filter((a) => a.kind === 'qualitative' && a.evaluator === 'self');
    let violated: string | undefined;
    const metrics: Record<string, number> = {};
    for (const a of metricAims) {
      const fail = !passing && violated === undefined;
      metrics[a.metric as string] = fail ? violating(a) : satisfying(a);
      if (fail) violated = a.key;
    }
    const evaluations = selfAims.map((a) => {
      const fail = !passing && violated === undefined;
      if (fail) violated = a.key;
      return {
        aim: a.key,
        verdict: fail ? ('unmet' as const) : ('met' as const),
        rationale: fail
          ? `Not yet: ${a.title.toLowerCase()} fails in two edge cases.`
          : `Checked against the criteria: ${a.title}.`,
      };
    });
    const exitCode = passing ? 0 : 1;
    const notes = [
      {
        type: 'proof' as const,
        title: passing ? `Checks pass for ${job.nodeKey}` : `Checks fail for ${job.nodeKey}`,
        evidence: [
          {
            kind: 'command' as const,
            value: 'pnpm test',
            meta: { exitCode, output: passing ? 'all passed' : '3 failed' },
          },
        ],
      },
      ...(passing
        ? [
            {
              type: 'deliverable' as const,
              title: `${detail.title} · commit ${hex(w.rng.next())}`,
              evidence: [{ kind: 'commit' as const, value: hex(w.rng.next()) }],
            },
          ]
        : [
            {
              type: 'finding' as const,
              title: `${job.nodeKey}: 3 failing checks`,
              severity: 'medium' as const,
              body: 'First error: expected 200, got 500 on the refresh path.',
            },
          ]),
    ];
    const r = await w.attempt(this.name, 'submit', () =>
      c.submit(job.attemptId, {
        summary: passing
          ? `Implemented ${detail.title}; all checks pass.`
          : `Implemented ${detail.title}, but some checks still fail.`,
        ...(Object.keys(metrics).length ? { metrics } : {}),
        ...(evaluations.length ? { evaluations } : {}),
        notes,
        usage: this.usage(job, now),
      }),
    );
    if (!r) return;
    w.stats.submits++;
    if (r.outcome === 'passed') w.stats.passed++;
    if (r.outcome === 'failed') w.stats.failed++;
    w.log(`${this.name} submitted ${job.nodeKey} → ${r.outcome}`);
    if (r.lessonDuty) {
      await w.attempt(this.name, 'lesson', async () => {
        try {
          return await c.addLesson({
            scope: { graph: w.graph, node: job.nodeKey },
            kind: 'guidance',
            condition: `When ${job.nodeKey} checks fail`,
            content:
              'Re-run the failing checks locally before resubmitting; fix the first error first.',
            dutyId: r.lessonDuty?.id as string,
          });
        } catch {
          return undefined; // learn-mode endpoints may not exist on this server yet
        }
      });
    }
    if (r.outcome !== 'failed' && Object.keys(metrics).length)
      await this.reportGraphMetrics(metrics);
  }

  /** Metrics that also feed graph aims are reported at graph level too. */
  private async reportGraphMetrics(metrics: Record<string, number>): Promise<void> {
    const graphMetrics = new Set(
      (this.world.view?.aims ?? [])
        .filter((a) => a.kind === 'quantitative' && a.source !== 'derived' && a.metric)
        .map((a) => a.metric as string),
    );
    const shared = Object.fromEntries(Object.entries(metrics).filter(([k]) => graphMetrics.has(k)));
    if (Object.keys(shared).length)
      await this.world.attempt(this.name, 'graph metrics', () =>
        this.client.reportGraphMetrics(this.world.graph, shared),
      );
  }
}

function hex(x: number): string {
  return Math.floor(x * 0xfffffff)
    .toString(16)
    .padStart(7, '0');
}
