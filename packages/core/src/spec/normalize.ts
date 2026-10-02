/**
 * Shorthand expansion and defaults: SpecInput → NormalizedSpec (the canonical form that exports
 * emit). Rules: docs/spec-format.md §2–§7 and docs/concepts.md §2 (precedence).
 */
import { durationToSeconds, type Issue } from '../schemas/common';
import type {
  Aggregation,
  AimKind,
  AimMode,
  AimSource,
  Comparator,
  EdgeRelation,
  Evaluator,
  EvolutionMode,
  ExhaustionPolicy,
  GateApprover,
  MutationPolicy,
  NodeKind,
  OrchestratorCapability,
  OrchestratorRole,
  Priority,
  ValidationStage,
} from '../vocabulary';
import type { AimInput, EdgeRefInput, ExecutorInput, SpecInput } from './schema';

export type NormalizedAim = {
  key: string;
  title: string;
  description?: string;
  kind: AimKind;
  terminating: boolean;
  guard: boolean;
  weight?: number;
  metric?: string;
  comparator?: Comparator;
  target?: number;
  targetMax?: number;
  unit?: string;
  source: AimSource;
  aggregation: Aggregation;
  criteria?: string[];
  evaluator: Evaluator;
  evaluatorKey?: string;
};

export type NormalizedEdgeRef = {
  key: string;
  label?: string;
  relation?: EdgeRelation;
  condition?: string;
  guidance?: string;
  pitfalls?: string;
};

export type Executor = {
  role?: string;
  model?: string;
  thinking?: string;
  provider?: string;
  mechanism?: string;
  requires?: string[];
  instructions?: string;
};

export type Deliverable = { name: string; description?: string; required: boolean };
export type ChecklistItem = { key: string; title: string; required: boolean };

export type NormalizedNode = {
  key: string;
  title: string;
  kind: NodeKind;
  aim?: string;
  purpose?: string;
  prompt?: string;
  context?: string;
  deliverables: Deliverable[];
  checklist: ChecklistItem[];
  needs: NormalizedEdgeRef[];
  informedBy: NormalizedEdgeRef[];
  aims: NormalizedAim[];
  aimMode: AimMode;
  priority: Priority;
  tags: string[];
  executor: Executor;
  maxAttempts: number;
  onExhausted: ExhaustionPolicy;
  leaseTtlSec: number;
  timeoutSec?: number;
  gate?: { approver: GateApprover; approverKey?: string; instructions?: string };
  parent?: string;
  position?: { x: number; y: number };
  metadata: Record<string, unknown>;
};

export type NormalizedLoop = {
  key: string;
  title?: string;
  from: string;
  to: string;
  maxIterations: number;
  onExhausted: ExhaustionPolicy;
  feedback?: string;
};

export type NormalizedScope = 'all' | { nodes: string[] } | { tags: string[] };

export type NormalizedOrchestrator = {
  key: string;
  name: string;
  role: OrchestratorRole;
  aim?: string;
  purpose?: string;
  prompt?: string;
  scope: NormalizedScope;
  capabilities: OrchestratorCapability[];
  triggers: string[];
  aims: NormalizedAim[];
  executor: Executor;
  metadata: Record<string, unknown>;
};

export type ResolvedPolicy = {
  maxAttempts: number;
  onExhausted: ExhaustionPolicy;
  leaseTtlSec: number;
  maxParallel: number | null;
  mutations: MutationPolicy;
  requirePlanApproval: boolean;
  evaluation: { independent: boolean };
  skippedSatisfiesDeps: boolean;
  requireProofForDone: boolean;
  failFast: boolean;
};

export type EvolutionObjective = {
  graphSuccess: number;
  firstPassYield: number;
  loopIterations: number;
  humanInterventions: number;
  cost: number;
  wallTime: number;
};

export type ResolvedEvolution = {
  mode: EvolutionMode;
  scope: string[];
  online: boolean;
  harvest: boolean;
  approval: 'human' | 'orchestrator';
  validation: {
    ladder: ValidationStage[];
    suite: string | null;
    minRuns: number;
    maxRounds: number;
    maxOpsPerProposal: number;
  };
  objective: EvolutionObjective;
  budget: { costUsd?: number; tokens?: number };
};

export type NormalizedSpec = {
  schema: 'agent-graphs/v1';
  title: string;
  slug?: string;
  description?: string;
  tags: string[];
  repository?: { url: string; branch?: string; path?: string };
  context?: string;
  constraints: string[];
  aims: NormalizedAim[];
  policy: ResolvedPolicy;
  defaults: {
    executor?: Executor;
    tags?: string[];
    maxAttempts?: number;
    onExhausted?: ExhaustionPolicy;
    leaseTtlSec?: number;
  };
  evolution: ResolvedEvolution;
  orchestrators: NormalizedOrchestrator[];
  nodes: NormalizedNode[];
  loops: NormalizedLoop[];
  metadata: Record<string, unknown>;
};

export const DEFAULT_POLICY: ResolvedPolicy = {
  maxAttempts: 3,
  onExhausted: 'escalate',
  leaseTtlSec: 1800,
  maxParallel: null,
  mutations: 'append',
  requirePlanApproval: false,
  evaluation: { independent: true },
  skippedSatisfiesDeps: true,
  requireProofForDone: false,
  failFast: false,
};

export const DEFAULT_OBJECTIVE: EvolutionObjective = {
  graphSuccess: 0.4,
  firstPassYield: 0.25,
  loopIterations: 0.1,
  humanInterventions: 0.1,
  cost: 0.1,
  wallTime: 0.05,
};

export const DEFAULT_GRAPH_AIM: NormalizedAim = {
  key: 'all-nodes-done',
  title: 'All nodes complete',
  kind: 'quantitative',
  terminating: true,
  guard: false,
  metric: 'nodes_done_ratio',
  comparator: 'gte',
  target: 1,
  source: 'derived',
  aggregation: 'latest',
  evaluator: 'self',
};

const CHECK_OPS: Record<string, Comparator> = {
  '>=': 'gte',
  '>': 'gt',
  '<=': 'lte',
  '<': 'lt',
  '==': 'eq',
  '!=': 'neq',
};
const CHECK_RE = /^\s*([a-z][a-z0-9_.]*)\s*(>=|>|<=|<|==|!=)\s*(-?\d+(?:\.\d+)?)\s*$/;
const BETWEEN_RE =
  /^\s*([a-z][a-z0-9_.]*)\s+in\s+\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]\s*$/;

/** Parse the `check` shorthand (`metric >= 1`, `metric in [a, b]`). */
export function parseCheck(
  check: string,
): { metric: string; comparator: Comparator; target: number; targetMax?: number } | null {
  const between = BETWEEN_RE.exec(check);
  if (between) {
    return {
      metric: between[1] as string,
      comparator: 'between',
      target: Number(between[2]),
      targetMax: Number(between[3]),
    };
  }
  const simple = CHECK_RE.exec(check);
  if (!simple) return null;
  return {
    metric: simple[1] as string,
    comparator: CHECK_OPS[simple[2] as string] as Comparator,
    target: Number(simple[3]),
  };
}

/** Derive a key from a title (spec-format.md §4): lowercase, non-alphanumerics → `-`, ≤ 64. */
export function deriveKey(title: string): string {
  const key = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return key || 'aim';
}

function uniqueKey(base: string, used: Set<string>): string {
  let key = base;
  let n = 2;
  while (used.has(key)) {
    const suffix = `-${n++}`;
    key = `${base.slice(0, 64 - suffix.length)}${suffix}`;
  }
  used.add(key);
  return key;
}

function normalizeAims(
  inputs: AimInput[] | undefined,
  owner: 'graph' | 'node' | 'orchestrator',
  path: string,
  issues: Issue[],
): NormalizedAim[] {
  const used = new Set<string>();
  for (const input of inputs ?? []) {
    if (typeof input !== 'string' && input.key) used.add(input.key);
  }
  return (inputs ?? []).map((input, i): NormalizedAim => {
    if (typeof input === 'string') {
      return {
        key: uniqueKey(deriveKey(input), used),
        title: input,
        kind: 'qualitative',
        terminating: true,
        guard: false,
        source: 'reported',
        aggregation: 'latest',
        evaluator: owner === 'graph' ? 'human' : 'self',
      };
    }
    let metric = input.metric;
    let comparator = input.comparator;
    let target = input.target;
    let targetMax = input.targetMax;
    if (input.check !== undefined) {
      const parsed = parseCheck(input.check);
      if (!parsed) {
        issues.push({
          path: `${path}[${i}].check`,
          code: 'invalid_check',
          message: `Cannot parse check '${input.check}'.`,
          hint: 'Use `metric >= 1`, `metric < 200`, or `metric in [100, 250]` (operators >= > <= < == !=).',
        });
      } else {
        metric ??= parsed.metric;
        comparator ??= parsed.comparator;
        target ??= parsed.target;
        targetMax ??= parsed.targetMax;
      }
    }
    const kind: AimKind = input.kind ?? (metric !== undefined ? 'quantitative' : 'qualitative');
    const title = input.title ?? input.check ?? metric ?? `aim ${i + 1}`;
    const key = input.key ?? uniqueKey(deriveKey(title), used);
    const aim: NormalizedAim = {
      key,
      title,
      kind,
      terminating: input.terminating ?? true,
      guard: input.guard ?? false,
      source: input.source ?? 'reported',
      aggregation: input.aggregation ?? 'latest',
      evaluator: input.evaluator ?? (owner === 'graph' ? 'human' : 'self'),
    };
    if (input.description !== undefined) aim.description = input.description;
    if (input.weight !== undefined) aim.weight = input.weight;
    if (metric !== undefined) aim.metric = metric;
    if (comparator !== undefined) aim.comparator = comparator;
    if (target !== undefined) aim.target = target;
    if (targetMax !== undefined) aim.targetMax = targetMax;
    if (input.unit !== undefined) aim.unit = input.unit;
    if (input.criteria !== undefined) aim.criteria = input.criteria;
    if (input.evaluatorKey !== undefined) aim.evaluatorKey = input.evaluatorKey;
    return aim;
  });
}

function normalizeEdgeRefs(refs: EdgeRefInput[] | undefined): NormalizedEdgeRef[] {
  return (refs ?? []).map((ref) => (typeof ref === 'string' ? { key: ref } : { ...ref }));
}

function compactExecutor(executor: ExecutorInput | undefined): Executor {
  const out: Executor = {};
  for (const [k, v] of Object.entries(executor ?? {})) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Normalize a structurally valid SpecInput. Shorthand problems are appended to `issues`. */
export function normalizeSpec(input: SpecInput, issues: Issue[] = []): NormalizedSpec {
  const p = input.policy ?? {};
  const policy: ResolvedPolicy = {
    maxAttempts: p.maxAttempts ?? DEFAULT_POLICY.maxAttempts,
    onExhausted: p.onExhausted ?? DEFAULT_POLICY.onExhausted,
    leaseTtlSec:
      p.leaseTtl !== undefined ? durationToSeconds(p.leaseTtl) : DEFAULT_POLICY.leaseTtlSec,
    maxParallel: p.maxParallel ?? null,
    mutations: p.mutations ?? DEFAULT_POLICY.mutations,
    requirePlanApproval: p.requirePlanApproval ?? false,
    evaluation: { independent: p.evaluation?.independent ?? true },
    skippedSatisfiesDeps: p.skippedSatisfiesDeps ?? true,
    requireProofForDone: p.requireProofForDone ?? false,
    failFast: p.failFast ?? false,
  };

  const d = input.defaults ?? {};
  const defaults: NormalizedSpec['defaults'] = {};
  if (d.executor) defaults.executor = compactExecutor(d.executor);
  if (d.tags) defaults.tags = d.tags;
  if (d.maxAttempts !== undefined) defaults.maxAttempts = d.maxAttempts;
  if (d.onExhausted !== undefined) defaults.onExhausted = d.onExhausted;
  if (d.leaseTtl !== undefined) defaults.leaseTtlSec = durationToSeconds(d.leaseTtl);

  const e = input.evolution ?? {};
  const evolution: ResolvedEvolution = {
    mode: e.mode ?? 'off',
    scope: e.scope ?? [],
    online: e.online ?? true,
    harvest: e.harvest ?? true,
    approval: e.approval ?? 'human',
    validation: {
      ladder: e.validation?.ladder ?? ['structural', 'counterfactual', 'human'],
      suite: e.validation?.suite ?? null,
      minRuns: e.validation?.minRuns ?? 5,
      maxRounds: e.validation?.maxRounds ?? 10,
      maxOpsPerProposal: e.validation?.maxOpsPerProposal ?? 5,
    },
    objective: { ...DEFAULT_OBJECTIVE, ...e.objective },
    budget: { ...e.budget },
  };

  const nodes = input.nodes.map((n, i): NormalizedNode => {
    const usedChecklist = new Set<string>();
    const node: NormalizedNode = {
      key: n.key,
      title: n.title,
      kind: n.kind ?? 'task',
      deliverables: (n.deliverables ?? []).map((item) =>
        typeof item === 'string'
          ? { name: item, required: false }
          : { ...item, required: item.required ?? false },
      ),
      checklist: (n.checklist ?? []).map((item) =>
        typeof item === 'string'
          ? { key: uniqueKey(deriveKey(item), usedChecklist), title: item, required: false }
          : {
              key: item.key ?? uniqueKey(deriveKey(item.title), usedChecklist),
              title: item.title,
              required: item.required ?? false,
            },
      ),
      needs: normalizeEdgeRefs(n.needs),
      informedBy: normalizeEdgeRefs(n.informedBy),
      aims: normalizeAims(n.aims, 'node', `nodes[${i}].aims`, issues),
      aimMode: n.aimMode ?? 'all',
      priority: n.priority ?? 'p2',
      tags: n.tags ?? defaults.tags ?? [],
      executor: { ...defaults.executor, ...compactExecutor(n.executor) },
      maxAttempts: n.maxAttempts ?? defaults.maxAttempts ?? policy.maxAttempts,
      onExhausted: n.onExhausted ?? defaults.onExhausted ?? policy.onExhausted,
      leaseTtlSec:
        n.leaseTtl !== undefined
          ? durationToSeconds(n.leaseTtl)
          : (defaults.leaseTtlSec ?? policy.leaseTtlSec),
      metadata: n.metadata ?? {},
    };
    if (n.aim !== undefined) node.aim = n.aim;
    if (n.purpose !== undefined) node.purpose = n.purpose;
    if (n.prompt !== undefined) node.prompt = n.prompt;
    if (n.context !== undefined) node.context = n.context;
    if (n.timeout !== undefined) node.timeoutSec = durationToSeconds(n.timeout);
    if (n.gate !== undefined) node.gate = n.gate;
    if (n.parent !== undefined) node.parent = n.parent;
    if (n.position !== undefined) node.position = n.position;
    return node;
  });

  const loops = (input.loops ?? []).map(
    (l): NormalizedLoop => ({
      key: l.key,
      ...(l.title !== undefined ? { title: l.title } : {}),
      from: l.from,
      to: l.to,
      maxIterations: l.maxIterations ?? 3,
      onExhausted: l.onExhausted ?? 'escalate',
      ...(l.feedback !== undefined ? { feedback: l.feedback } : {}),
    }),
  );

  const orchestrators = (input.orchestrators ?? []).map(
    (o, i): NormalizedOrchestrator => ({
      key: o.key,
      name: o.name,
      role: o.role ?? 'custom',
      ...(o.aim !== undefined ? { aim: o.aim } : {}),
      ...(o.purpose !== undefined ? { purpose: o.purpose } : {}),
      ...(o.prompt !== undefined ? { prompt: o.prompt } : {}),
      scope: o.scope ?? 'all',
      capabilities: o.capabilities ?? [],
      triggers: o.triggers ?? [],
      aims: normalizeAims(o.aims, 'orchestrator', `orchestrators[${i}].aims`, issues),
      executor: compactExecutor(o.executor),
      metadata: o.metadata ?? {},
    }),
  );

  const graphAims = normalizeAims(input.aims, 'graph', 'aims', issues);

  const spec: NormalizedSpec = {
    schema: 'agent-graphs/v1',
    title: input.title,
    tags: input.tags ?? [],
    constraints: input.constraints ?? [],
    aims: graphAims.length > 0 ? graphAims : [{ ...DEFAULT_GRAPH_AIM }],
    policy,
    defaults,
    evolution,
    orchestrators,
    nodes,
    loops,
    metadata: input.metadata ?? {},
  };
  if (input.slug !== undefined) spec.slug = input.slug;
  if (input.description !== undefined) spec.description = input.description;
  if (input.repository !== undefined) spec.repository = input.repository;
  if (input.context !== undefined) spec.context = input.context;
  return spec;
}
