/**
 * HTTP request bodies (docs/api.md). The server validates with these, the SDK and MCP tools
 * derive their input types from them, and the OpenAPI document is generated from them.
 */
import { z } from 'zod';
import {
  DIRECTIVE_KINDS,
  DIRECTIVE_TARGETS,
  FINDING_SEVERITIES,
  NOTE_TYPES,
  REQUEST_ASSIGNEES,
  REQUEST_KINDS,
  TOKEN_ROLES,
} from '../vocabulary';
import { Duration, Evidence, ExecutionAnnotation, Key, Usage } from './common';

const Reason = z.string().min(1).max(4000);
const Metrics = z.union([
  z.record(z.string(), z.number()),
  z.array(
    z.strictObject({
      name: z.string().min(1).max(200),
      value: z.number(),
      unit: z.string().max(50).optional(),
    }),
  ),
]);
const BriefingOptions = z.strictObject({
  budget: z.number().int().min(500).max(200_000).optional(),
  format: z.enum(['md', 'json']).optional(),
  protocol: z.boolean().optional(),
});
const Verdict = z.enum(['met', 'unmet', 'partial']);

export const CreateGraphBody = z.union([
  z.strictObject({ format: z.literal('yaml'), spec: z.string().max(1_000_000) }),
  z.strictObject({ format: z.literal('json').optional(), spec: z.record(z.string(), z.unknown()) }),
]);
export const ValidateSpecBody = CreateGraphBody;

export const ActorBody = z.object({
  actor: ExecutionAnnotation.partial({ kind: true }).optional(),
});

export const ClaimBody = z.strictObject({
  actor: ExecutionAnnotation.partial({ kind: true }).optional(),
  session: z.string().optional(),
  clientSessionId: z.string().max(200).optional(),
  skills: z.array(z.string().max(100)).max(50).optional(),
  dispatchedBy: Key.optional(),
  briefing: BriefingOptions.optional(),
});

export const NextBody = z.strictObject({
  actor: ExecutionAnnotation.partial({ kind: true }).optional(),
  session: z.string().optional(),
  role: z.enum(['worker', 'reviewer']).optional(),
  skills: z.array(z.string().max(100)).max(50).optional(),
  claim: z.boolean().optional(),
  dispatchedBy: Key.optional(),
  briefing: BriefingOptions.optional(),
});

export const ChecklistItems = z.record(
  Key,
  z.strictObject({ done: z.boolean(), evidence: z.array(Evidence).max(20).optional() }),
);

export const HeartbeatBody = z.strictObject({
  progress: z.number().int().min(0).max(100).optional(),
  step: z.string().max(500).optional(),
  checkpoint: z.unknown().optional(),
  usage: Usage.optional(),
  checklist: ChecklistItems.optional(),
});

export const NoteBody = z.strictObject({
  type: z.enum(NOTE_TYPES),
  title: z.string().min(1).max(500),
  body: z.string().max(100_000).optional(),
  severity: z.enum(FINDING_SEVERITIES).optional(),
  evidence: z.array(Evidence).max(50).optional(),
  metrics: z.record(z.string(), z.number()).optional(),
  replyTo: z.string().optional(),
  author: ExecutionAnnotation.partial({ kind: true }).optional(),
  usage: Usage.optional(),
  pinned: z.boolean().optional(),
  /** For `question` notes: who should answer. */
  assignee: z.enum(REQUEST_ASSIGNEES).optional(),
});

export const SubmitBody = z.strictObject({
  summary: z.string().min(1).max(20_000),
  evaluations: z
    .array(
      z.strictObject({
        aim: Key,
        verdict: Verdict,
        rationale: z.string().max(10_000).optional(),
        evidence: z.array(Evidence).max(50).optional(),
        score: z.number().optional(),
      }),
    )
    .max(50)
    .optional(),
  metrics: Metrics.optional(),
  notes: z.array(NoteBody).max(50).optional(),
  usage: Usage.optional(),
});

export const EvaluateBody = z.strictObject({
  aim: Key,
  verdict: Verdict,
  rationale: z.string().max(10_000).optional(),
  evidence: z.array(Evidence).max(50).optional(),
  score: z.number().optional(),
});

export const MetricsBody = z.union([
  z.strictObject({ metrics: Metrics }),
  z.array(z.strictObject({ name: z.string(), value: z.number(), unit: z.string().optional() })),
]);
export const ChecklistBody = z.strictObject({ items: ChecklistItems });
export const FailBody = z.strictObject({
  reason: Reason,
  retryable: z.boolean().optional(),
  usage: Usage.optional(),
});
export const BlockBody = z.strictObject({
  reason: Reason,
  request: z.strictObject({
    title: z.string().min(1).max(500),
    body: z.string().max(20_000).optional(),
  }),
});
export const ReleaseBody = z.strictObject({
  reason: Reason,
  handoff: z.string().max(20_000).optional(),
});
export const ReasonBody = z.strictObject({ reason: Reason });
export const OptionalReasonBody = z.strictObject({ reason: z.string().max(4000).optional() });
export const RetryBody = z.strictObject({ extraAttempts: z.number().int().min(1).max(50) });
export const ExtendLoopBody = z.strictObject({
  extraIterations: z.number().int().min(1).max(50),
  reason: z.string().max(4000).optional(),
});
export const WaiveBody = z.strictObject({ justification: Reason });
export const CompleteManuallyBody = z.strictObject({
  summary: z.string().min(1).max(20_000),
  evidence: z.array(Evidence).max(50).optional(),
  evaluations: SubmitBody.shape.evaluations,
  notes: z.array(NoteBody).max(50).optional(),
});
export const GraphAimEvaluationBody = EvaluateBody.omit({ aim: true, score: true });

export const ResolveBody = z.strictObject({
  choice: z.string().min(1).max(50),
  comment: z.string().max(20_000).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});
export const RaiseRequestBody = z.strictObject({
  kind: z
    .enum(REQUEST_KINDS)
    .refine((k) => k === 'question' || k === 'approval', 'Agents raise questions or approvals'),
  title: z.string().min(1).max(500),
  body: z.string().max(20_000).optional(),
  node: Key.optional(),
  attempt: z.string().optional(),
  assignee: z.enum(REQUEST_ASSIGNEES).optional(),
  blocking: z.boolean().optional(),
});

export const DirectiveBody = z.strictObject({
  target: z.strictObject({
    type: z.enum(DIRECTIVE_TARGETS),
    key: z.string().optional(),
    id: z.string().optional(),
  }),
  kind: z.enum(DIRECTIVE_KINDS),
  title: z.string().min(1).max(500),
  body: z.string().max(20_000).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  requiresAck: z.boolean().optional(),
  expiresAt: z.string().datetime().optional(),
  supersedes: z.string().optional(),
});
export const AckBody = z.strictObject({
  note: z.string().max(4000).optional(),
  attemptId: z.string().optional(),
});

export const MutationBody = z.strictObject({
  graph: z.record(z.string(), z.unknown()).optional(),
  addNodes: z.array(z.record(z.string(), z.unknown())).max(500).optional(),
  updateNodes: z
    .array(z.object({ key: Key }).passthrough())
    .max(500)
    .optional(),
  removeNodes: z.array(Key).max(500).optional(),
  addEdges: z
    .array(z.object({ from: Key, to: Key }).passthrough())
    .max(2000)
    .optional(),
  updateEdges: z
    .array(z.object({ from: Key, to: Key }).passthrough())
    .max(2000)
    .optional(),
  removeEdges: z
    .array(z.object({ from: Key, to: Key, kind: z.enum(['requires', 'informs']).optional() }))
    .max(2000)
    .optional(),
  addLoops: z.array(z.record(z.string(), z.unknown())).max(50).optional(),
  updateLoops: z
    .array(z.object({ key: Key }).passthrough())
    .max(50)
    .optional(),
  removeLoops: z.array(Key).max(50).optional(),
  addOrchestrators: z.array(z.record(z.string(), z.unknown())).max(50).optional(),
  updateOrchestrators: z
    .array(z.object({ key: Key }).passthrough())
    .max(50)
    .optional(),
  removeOrchestrators: z.array(Key).max(50).optional(),
  addGraphAims: z.array(z.record(z.string(), z.unknown())).max(50).optional(),
  updateGraphAims: z
    .array(z.object({ key: Key }).passthrough())
    .max(50)
    .optional(),
  removeGraphAims: z.array(Key).max(50).optional(),
});
export const PatchNodeBody = z.record(z.string(), z.unknown());
export const PatchGraphBody = z.record(z.string(), z.unknown());
export const PatchEdgeBody = z.strictObject({
  label: z.string().max(200).nullable().optional(),
  relation: z.string().nullable().optional(),
  condition: z.string().max(2000).nullable().optional(),
  guidance: z.string().max(4000).nullable().optional(),
  pitfalls: z.string().max(4000).nullable().optional(),
});

export const AttachBody = z.strictObject({
  actor: ExecutionAnnotation.partial({ kind: true }).optional(),
  session: z.string().optional(),
});
export const DetachBody = z.strictObject({ handoff: z.string().max(20_000).optional() });

export const SessionBody = ExecutionAnnotation.partial({ kind: true }).extend({
  skills: z.array(z.string().max(100)).max(50).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export const SessionEventBody = z.strictObject({
  type: z.enum(['compacted', 'resumed', 'started']),
  detail: z.string().max(2000).optional(),
});

export const TokenBody = z.strictObject({
  name: z.string().min(1).max(200),
  role: z.enum(TOKEN_ROLES),
});
export const RetractBody = z.strictObject({ reason: Reason });
export const ResolveNoteBody = z.strictObject({ comment: Reason });
export const LeaseDurationBody = z.strictObject({ duration: Duration });

export type ClaimBody = z.infer<typeof ClaimBody>;
export type NextBody = z.infer<typeof NextBody>;
export type HeartbeatBody = z.infer<typeof HeartbeatBody>;
export type SubmitBody = z.infer<typeof SubmitBody>;
export type NoteBody = z.infer<typeof NoteBody>;
export type EvaluateBody = z.infer<typeof EvaluateBody>;
export type ResolveBody = z.infer<typeof ResolveBody>;
export type DirectiveBody = z.infer<typeof DirectiveBody>;
export type MutationBody = z.infer<typeof MutationBody>;

/** Normalize the two metric shapes to `[{name, value, unit?}]`. */
export function metricList(
  metrics: z.infer<typeof Metrics> | undefined,
): Array<{ name: string; value: number; unit?: string }> {
  if (!metrics) return [];
  if (Array.isArray(metrics)) return metrics;
  return Object.entries(metrics).map(([name, value]) => ({ name, value }));
}
