/**
 * Run metrics, the objective score, and the evolution gate (docs/self-evolution.md §9):
 * accept when score(candidate) ≥ score(incumbent) (ties accepted), every constraint holds,
 * and both arms meet the sample minimum.
 */
import { attemptsOf } from '../engine/state';
import type { GraphState } from '../engine/types';
import type { EvolutionObjective } from '../spec/normalize';

/** One run's signals, computed from a finished (or current) graph. */
export type RunMetrics = {
  success: number;
  firstPassYield: number;
  loopIterationsPerEntry: number;
  humanInterventions: number;
  costUsd: number;
  wallTimeHours: number;
  openFindingsHigh: number;
};

export function runMetrics(state: GraphState, now: number): RunMetrics {
  const g = state.graph;
  const nodes = [...state.nodes.values()].filter((n) => n.kind === 'task');
  let activations = 0;
  let firstPass = 0;
  for (const n of nodes) {
    for (let act = 1; act <= n.activation; act++) {
      // Attempts that reached a verdict: passed (even if later superseded) or counted failures.
      const decided = attemptsOf(state, n.id, act).filter(
        (a) => !a.manual && (a.passedAt !== undefined || a.status === 'failed' || a.counted),
      );
      if (decided.length === 0) continue;
      activations++;
      if (decided[0]?.passedAt !== undefined) firstPass++;
    }
  }
  const entered = state.loops.filter((l) => l.status !== 'idle');
  const interventions = [...state.requests.values()].filter(
    (r) =>
      r.kind === 'escalation' ||
      r.kind === 'blocker' ||
      (r.subject === 'gate' && r.resolution?.choice === 'reject'),
  ).length;
  const cost = [...state.attempts.values()].reduce((s, a) => s + (a.usage?.costUsd ?? 0), 0);
  const end = g.completedAt ?? now;
  return {
    success: g.status === 'completed' && !g.acceptedWithDeviation ? 1 : 0,
    firstPassYield: activations === 0 ? 1 : firstPass / activations,
    loopIterationsPerEntry:
      entered.length === 0 ? 1 : entered.reduce((s, l) => s + l.iteration, 0) / entered.length,
    humanInterventions: interventions,
    costUsd: cost,
    wallTimeHours: g.startedAt ? Math.max(0, end - g.startedAt) / 3_600_000 : 0,
    openFindingsHigh: state.openHighFindings ?? 0,
  };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

export type ArmSummary = {
  samples: number;
  success: number;
  firstPassYield: number;
  loopIterationsPerEntry: number;
  humanInterventions: number;
  costUsd: number;
  wallTimeHours: number;
  openFindingsHigh: number;
};

export function summarize(runs: RunMetrics[]): ArmSummary {
  return {
    samples: runs.length,
    success: mean(runs.map((r) => r.success)),
    firstPassYield: mean(runs.map((r) => r.firstPassYield)),
    loopIterationsPerEntry: mean(runs.map((r) => r.loopIterationsPerEntry)),
    humanInterventions: mean(runs.map((r) => r.humanInterventions)),
    costUsd: mean(runs.map((r) => r.costUsd)),
    wallTimeHours: mean(runs.map((r) => r.wallTimeHours)),
    openFindingsHigh: mean(runs.map((r) => r.openFindingsHigh)),
  };
}

/** Lower-is-better signals become [0, 1] relative to the better of the two arms. */
function relative(value: number, best: number): number {
  if (value <= 0) return 1;
  return Math.min(1, best / value);
}

/**
 * Objective score in [0, 1]. Inverse signals: extra loop iterations and interventions use
 * 1 / (1 + x); cost and wall time are normalized against the cheaper/faster arm (`reference`).
 */
export function objectiveScore(
  arm: ArmSummary,
  weights: EvolutionObjective,
  reference: { costUsd: number; wallTimeHours: number },
): number {
  const parts = {
    graphSuccess: arm.success,
    firstPassYield: arm.firstPassYield,
    loopIterations: 1 / (1 + Math.max(0, arm.loopIterationsPerEntry - 1)),
    humanInterventions: 1 / (1 + arm.humanInterventions),
    cost: relative(arm.costUsd, reference.costUsd),
    wallTime: relative(arm.wallTimeHours, reference.wallTimeHours),
  };
  const total = Object.values(weights).reduce((s, w) => s + w, 0) || 1;
  return (
    (Object.entries(parts) as Array<[keyof EvolutionObjective, number]>).reduce(
      (s, [k, v]) => s + v * weights[k],
      0,
    ) / total
  );
}

export type EvolutionGateInput = {
  candidate: RunMetrics[];
  incumbent: RunMetrics[];
  weights: EvolutionObjective;
  minRuns: number;
  /** Relative tolerance for cost and time regressions (default 0.1 = 10%). */
  tolerance?: number;
  /** Absolute tolerance for open high-severity findings (default 0). */
  findingsTolerance?: number;
};

export type GateDecision = {
  accept: boolean;
  scoreCandidate: number;
  scoreIncumbent: number;
  candidate: ArmSummary;
  incumbent: ArmSummary;
  reasons: string[];
};

export function gateDecision(input: EvolutionGateInput): GateDecision {
  const tol = input.tolerance ?? 0.1;
  const c = summarize(input.candidate);
  const i = summarize(input.incumbent);
  const reference = {
    costUsd: Math.min(c.costUsd || Number.POSITIVE_INFINITY, i.costUsd || Number.POSITIVE_INFINITY),
    wallTimeHours: Math.min(
      c.wallTimeHours || Number.POSITIVE_INFINITY,
      i.wallTimeHours || Number.POSITIVE_INFINITY,
    ),
  };
  const ref = {
    costUsd: Number.isFinite(reference.costUsd) ? reference.costUsd : 0,
    wallTimeHours: Number.isFinite(reference.wallTimeHours) ? reference.wallTimeHours : 0,
  };
  const scoreCandidate = objectiveScore(c, input.weights, ref);
  const scoreIncumbent = objectiveScore(i, input.weights, ref);
  const reasons: string[] = [];
  if (c.samples < input.minRuns)
    reasons.push(`candidate has ${c.samples} runs; ${input.minRuns} required`);
  if (i.samples < input.minRuns)
    reasons.push(`incumbent has ${i.samples} runs; ${input.minRuns} required`);
  if (c.costUsd > i.costUsd * (1 + tol) + 1e-9) {
    reasons.push(
      `cost regressed: $${c.costUsd.toFixed(2)} vs $${i.costUsd.toFixed(2)} (tolerance ${tol * 100}%)`,
    );
  }
  if (c.wallTimeHours > i.wallTimeHours * (1 + tol) + 1e-9) {
    reasons.push(
      `wall time regressed: ${c.wallTimeHours.toFixed(2)}h vs ${i.wallTimeHours.toFixed(2)}h`,
    );
  }
  if (c.openFindingsHigh > i.openFindingsHigh + (input.findingsTolerance ?? 0)) {
    reasons.push(
      `open high-severity findings rose: ${c.openFindingsHigh} vs ${i.openFindingsHigh}`,
    );
  }
  // Ties are accepted (R5); compare with a small epsilon to absorb float noise.
  if (scoreCandidate + 1e-9 < scoreIncumbent) {
    reasons.push(`score ${scoreCandidate.toFixed(4)} < incumbent ${scoreIncumbent.toFixed(4)}`);
  }
  return {
    accept: reasons.length === 0,
    scoreCandidate,
    scoreIncumbent,
    candidate: c,
    incumbent: i,
    reasons,
  };
}
