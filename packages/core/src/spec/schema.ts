/**
 * Graph spec input schema (`agent-graphs/v1`), including authoring shorthands.
 * Syntax: docs/spec-format.md. Normalization to the canonical form lives in normalize.ts.
 */
import { z } from 'zod';
import { Duration, Key } from '../schemas/common';
import {
  AGGREGATIONS,
  AIM_KINDS,
  AIM_MODES,
  AIM_SOURCES,
  COMPARATORS,
  EDGE_RELATIONS,
  EVALUATORS,
  EVOLUTION_MODES,
  EVOLUTION_SCOPES,
  EXHAUSTION_POLICIES,
  GATE_APPROVERS,
  MUTATION_POLICIES,
  NODE_KINDS,
  ORCHESTRATOR_CAPABILITIES,
  ORCHESTRATOR_ROLES,
  PRIORITIES,
  SPEC_SCHEMA,
  VALIDATION_STAGES,
} from '../vocabulary';

const Text = z.string().max(100_000);
const ShortText = z.string().min(1).max(500);

export const AimObjectInput = z.strictObject({
  key: Key.optional(),
  title: ShortText.optional(),
  description: Text.optional(),
  kind: z.enum(AIM_KINDS).optional(),
  terminating: z.boolean().optional(),
  guard: z.boolean().optional(),
  weight: z.number().optional(),
  check: z.string().max(200).optional(),
  metric: z
    .string()
    .regex(/^[a-z][a-z0-9_.]*$/)
    .optional(),
  comparator: z.enum(COMPARATORS).optional(),
  target: z.number().optional(),
  targetMax: z.number().optional(),
  unit: z.string().max(50).optional(),
  source: z.enum(AIM_SOURCES).optional(),
  aggregation: z.enum(AGGREGATIONS).optional(),
  criteria: z.array(ShortText).max(50).optional(),
  evaluator: z.enum(EVALUATORS).optional(),
  evaluatorKey: Key.optional(),
});
export const AimInput = z.union([ShortText, AimObjectInput]);
export type AimInput = z.infer<typeof AimInput>;

export const EdgeRefInput = z.union([
  Key,
  z.strictObject({
    key: Key,
    label: z.string().max(200).optional(),
    relation: z.enum(EDGE_RELATIONS).optional(),
    condition: z.string().max(2000).optional(),
    guidance: z.string().max(4000).optional(),
    pitfalls: z.string().max(4000).optional(),
  }),
]);
export type EdgeRefInput = z.infer<typeof EdgeRefInput>;

export const ChecklistItemInput = z.union([
  ShortText,
  z.strictObject({ key: Key.optional(), title: ShortText, required: z.boolean().optional() }),
]);

export const DeliverableInput = z.union([
  ShortText,
  z.strictObject({
    name: ShortText,
    description: z.string().max(2000).optional(),
    required: z.boolean().optional(),
  }),
]);

export const ExecutorInput = z.strictObject({
  role: z.string().max(100).optional(),
  model: z.string().max(200).optional(),
  thinking: z.string().max(50).optional(),
  provider: z.string().max(100).optional(),
  mechanism: z.string().max(100).optional(),
  requires: z.array(z.string().max(100)).max(50).optional(),
  instructions: z.string().max(4000).optional(),
});
export type ExecutorInput = z.infer<typeof ExecutorInput>;

export const GateInput = z.strictObject({
  approver: z.enum(GATE_APPROVERS),
  approverKey: Key.optional(),
  instructions: z.string().max(4000).optional(),
});

export const NodeInput = z.strictObject({
  key: Key,
  title: ShortText,
  kind: z.enum(NODE_KINDS).optional(),
  aim: z.string().max(2000).optional(),
  purpose: z.string().max(4000).optional(),
  prompt: Text.optional(),
  context: Text.optional(),
  deliverables: z.array(DeliverableInput).max(100).optional(),
  checklist: z.array(ChecklistItemInput).max(100).optional(),
  needs: z.array(EdgeRefInput).max(200).optional(),
  informedBy: z.array(EdgeRefInput).max(200).optional(),
  aims: z.array(AimInput).max(50).optional(),
  aimMode: z.enum(AIM_MODES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  tags: z.array(z.string().max(100)).max(50).optional(),
  executor: ExecutorInput.optional(),
  maxAttempts: z.number().int().optional(),
  onExhausted: z.enum(EXHAUSTION_POLICIES).optional(),
  leaseTtl: Duration.optional(),
  timeout: Duration.optional(),
  gate: GateInput.optional(),
  parent: Key.optional(),
  position: z.strictObject({ x: z.number(), y: z.number() }).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type NodeInput = z.infer<typeof NodeInput>;

export const LoopInput = z.strictObject({
  key: Key,
  title: z.string().max(200).optional(),
  from: Key,
  to: Key,
  maxIterations: z.number().int().optional(),
  onExhausted: z.enum(EXHAUSTION_POLICIES).optional(),
  feedback: z.string().max(4000).optional(),
});
export type LoopInput = z.infer<typeof LoopInput>;

export const ScopeInput = z.union([
  z.literal('all'),
  z.strictObject({ nodes: z.array(Key).min(1) }),
  z.strictObject({ tags: z.array(z.string()).min(1) }),
]);
export type ScopeInput = z.infer<typeof ScopeInput>;

export const OrchestratorInput = z.strictObject({
  key: Key,
  name: ShortText,
  role: z.enum(ORCHESTRATOR_ROLES).optional(),
  aim: z.string().max(2000).optional(),
  purpose: z.string().max(4000).optional(),
  prompt: Text.optional(),
  scope: ScopeInput.optional(),
  capabilities: z.array(z.enum(ORCHESTRATOR_CAPABILITIES)).optional(),
  triggers: z.array(z.string().max(100)).optional(),
  aims: z.array(AimInput).max(50).optional(),
  executor: ExecutorInput.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type OrchestratorInput = z.infer<typeof OrchestratorInput>;

export const PolicyInput = z.strictObject({
  maxAttempts: z.number().int().optional(),
  onExhausted: z.enum(EXHAUSTION_POLICIES).optional(),
  leaseTtl: Duration.optional(),
  maxParallel: z.number().int().positive().nullable().optional(),
  mutations: z.enum(MUTATION_POLICIES).optional(),
  requirePlanApproval: z.boolean().optional(),
  evaluation: z.strictObject({ independent: z.boolean().optional() }).optional(),
  skippedSatisfiesDeps: z.boolean().optional(),
  requireProofForDone: z.boolean().optional(),
  failFast: z.boolean().optional(),
});

export const DefaultsInput = z.strictObject({
  executor: ExecutorInput.optional(),
  tags: z.array(z.string().max(100)).optional(),
  maxAttempts: z.number().int().optional(),
  onExhausted: z.enum(EXHAUSTION_POLICIES).optional(),
  leaseTtl: Duration.optional(),
});

export const EvolutionInput = z.strictObject({
  mode: z.enum(EVOLUTION_MODES).optional(),
  scope: z.array(z.string()).optional(),
  online: z.boolean().optional(),
  harvest: z.boolean().optional(),
  approval: z.enum(['human', 'orchestrator']).optional(),
  validation: z
    .strictObject({
      ladder: z.array(z.enum(VALIDATION_STAGES)).optional(),
      suite: z.string().nullable().optional(),
      minRuns: z.number().int().positive().optional(),
      maxRounds: z.number().int().positive().optional(),
      maxOpsPerProposal: z.number().int().positive().optional(),
    })
    .optional(),
  objective: z
    .strictObject({
      graphSuccess: z.number().nonnegative().optional(),
      firstPassYield: z.number().nonnegative().optional(),
      loopIterations: z.number().nonnegative().optional(),
      humanInterventions: z.number().nonnegative().optional(),
      cost: z.number().nonnegative().optional(),
      wallTime: z.number().nonnegative().optional(),
    })
    .optional(),
  budget: z
    .strictObject({
      costUsd: z.number().nonnegative().optional(),
      tokens: z.number().nonnegative().optional(),
    })
    .optional(),
});

export const SpecInput = z.strictObject({
  $schema: z.string().optional(),
  schema: z.literal(SPEC_SCHEMA),
  title: z.string().min(1).max(200),
  slug: Key.optional(),
  description: Text.optional(),
  tags: z.array(z.string().max(100)).max(50).optional(),
  repository: z
    .strictObject({
      url: z.string().max(500),
      branch: z.string().max(200).optional(),
      path: z.string().max(500).optional(),
    })
    .optional(),
  context: Text.optional(),
  constraints: z.array(z.string().max(2000)).max(100).optional(),
  aims: z.array(AimInput).max(50).optional(),
  policy: PolicyInput.optional(),
  defaults: DefaultsInput.optional(),
  evolution: EvolutionInput.optional(),
  orchestrators: z.array(OrchestratorInput).max(50).optional(),
  nodes: z.array(NodeInput).min(1).max(2000),
  loops: z.array(LoopInput).max(500).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type SpecInput = z.infer<typeof SpecInput>;

/** Allowed scope classes for self-evolution (protected classes are rejected separately). */
export const KNOWN_EVOLUTION_SCOPES = new Set<string>(EVOLUTION_SCOPES);
