/**
 * Response shapes (the server's read models). Entities come from @agent-graphs/core with their
 * epoch-ms `…At` fields serialized as ISO-8601 strings (`Wire<T>`).
 */
import type * as C from '@agent-graphs/core';

/** Map `…At: number` fields to ISO strings, recursively. */
export type Wire<T> =
  T extends Array<infer U>
    ? Wire<U>[]
    : T extends Record<string, unknown>
      ? {
          [K in keyof T]: K extends `${string}At`
            ? T[K] extends number
              ? string
              : T[K] extends number | undefined
                ? string | undefined
                : Wire<T[K]>
            : Wire<T[K]>;
        }
      : T;

export type Evidence = C.Evidence;
export type Annotation = C.ExecutionAnnotation;
export type Attempt = Wire<C.Attempt>;
export type Aim = Wire<C.Aim>;
export type Loop = Wire<C.Loop> & { from?: string; to?: string; bodyKeys?: string[] };
export type Edge = Wire<C.Edge> & { from?: string; to?: string };
export type Note = Wire<C.Note>;
export type HumanRequest = Wire<C.HumanRequest> & {
  graph?: { id: string; title: string; slug?: string };
};
export type Directive = Wire<C.Directive> & {
  deliveries?: Wire<C.DirectiveDelivery>[];
  delivery?: Wire<C.DirectiveDelivery>;
};
export type Orchestrator = Wire<C.Orchestrator> & { aims?: Aim[]; queue?: number };
export type MetricReport = Wire<C.MetricReport>;
export type Evaluation = Wire<C.Evaluation>;
export type Lesson = Wire<C.Lesson>;

export type AttemptSummary = Pick<
  Attempt,
  | 'id'
  | 'number'
  | 'activation'
  | 'status'
  | 'counted'
  | 'executor'
  | 'dispatchedBy'
  | 'progress'
  | 'currentStep'
  | 'leaseExpiresAt'
  | 'lastHeartbeatAt'
  | 'usage'
  | 'summary'
  | 'outcomeReason'
  | 'manual'
  | 'startedAt'
  | 'submittedAt'
  | 'endedAt'
>;

export type NodeSummary = {
  id: string;
  key: string;
  title: string;
  kind: C.NodeKind;
  aim?: string;
  status: C.NodeStatus;
  statusReason?: string;
  priority: C.Priority;
  tags: string[];
  executor: C.Executor;
  activation: number;
  countedAttempts: number;
  maxAttempts: number;
  attemptsTotal: number;
  acceptedWithDeviation: boolean;
  manual: boolean;
  parentId?: string;
  position?: { x: number; y: number };
  aims: Array<
    Pick<
      Aim,
      | 'key'
      | 'title'
      | 'kind'
      | 'terminating'
      | 'status'
      | 'metric'
      | 'comparator'
      | 'target'
      | 'currentValue'
      | 'evaluator'
      | 'implicit'
    >
  >;
  loop?: { key: string; iteration: number; max: number };
  triggersLoop?: string;
  currentAttempt?: AttemptSummary;
  openRequests: number;
  readyAt?: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
};

export type GraphSummary = {
  id: string;
  slug?: string;
  title: string;
  description?: string;
  status: C.GraphStatus;
  stalled: boolean;
  pendingApproval: boolean;
  acceptedWithDeviation: boolean;
  tags: string[];
  revision: number;
  counts: Partial<Record<C.NodeStatus, number>>;
  total: number;
  progress: number;
  aims: { met: number; total: number };
  agents: Array<{
    attemptId: string;
    nodeKey?: string;
    kind?: string;
    agent?: string;
    model?: string;
    thinking?: string;
    provider?: string;
    mechanism?: string;
  }>;
  openRequests: number;
  costUsd: number;
  loops: Array<{ key: string; iteration: number; max: number; status: C.LoopStatus }>;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  archivedAt?: string;
  lastActivityAt: string;
};

export type GraphView = {
  graph: Wire<C.Graph> & GraphSummary;
  aims: Aim[];
  nodes: NodeSummary[];
  edges: Edge[];
  loops: Loop[];
  orchestrators: Orchestrator[];
  requests: HumanRequest[];
  criticalPath: string[];
};

export type NodeDetail = NodeSummary & {
  purpose?: string;
  prompt?: string;
  context?: string;
  deliverables: C.Deliverable[];
  checklist: C.ChecklistItem[];
  aimMode: C.AimMode;
  gate?: C.Node['gate'];
  onExhausted: C.ExhaustionPolicy;
  leaseTtlSec: number;
  timeoutSec?: number;
  metadata: Record<string, unknown>;
  feedback?: C.FeedbackPacket;
  version: number;
  aims: Aim[];
  attempts: Array<Attempt & { evaluations: Evaluation[]; metrics: MetricReport[] }>;
  evaluations: Evaluation[];
  needs: Edge[];
  dependents: Edge[];
  requests: HumanRequest[];
  directives: Directive[];
  notes: Note[];
};

export type ClaimResult = {
  attempt: Attempt;
  lease: { expiresAt: string; ttlSeconds: number; heartbeatEvery: number };
  directives: Directive[];
  session?: string;
  briefing?: string | Record<string, unknown>;
};

export type HeartbeatResult = {
  leaseExpiresAt: string;
  directives: Directive[];
  pauseRequested: boolean;
  cancelRequested: boolean;
  briefingChanged: boolean;
};

export type SubmitResult = {
  outcome: 'passed' | 'failed' | 'evaluating';
  attempt: AttemptSummary;
  node: NodeSummary;
  next: string;
  lessonDuty?: { id: string; ask: string };
};

export type NextResult = {
  node: { key: string; title: string; priority: string; reason: string } | null;
  reason?: string;
  running?: Array<{ key?: string; holder: string; progress: number }>;
  needsInput?: string[];
  blocked?: string[];
  suggestion?: string;
  attempt?: Attempt | null;
  lease?: ClaimResult['lease'];
  directives?: Directive[];
  briefing?: string | Record<string, unknown>;
  session?: string;
  aims?: Aim[];
};

export type DutyItem = C.engine.DutyItem;

export type AttachResult = {
  orchestrator: Orchestrator;
  session: string;
  lease: { expiresAt: string; ttlSeconds: number; heartbeatEvery: number };
  queue: DutyItem[];
};

export type Session = {
  id: string;
  kind: string;
  name?: string | null;
  role?: string | null;
  model?: string | null;
  thinking?: string | null;
  provider?: string | null;
  mechanism?: string | null;
  clientSessionId?: string | null;
  parentSessionId?: string | null;
  skills: string[];
  status: string;
  startedAt: string;
  lastSeenAt: string;
  annotation: Annotation;
};

export type SessionHeartbeat = {
  attempts: Array<{
    id: string;
    nodeKey?: string;
    graph: string;
    leaseExpiresAt?: string;
    newDirectives: Directive[];
    pauseRequested: boolean;
    cancelRequested: boolean;
  }>;
};

export type GraphStats = {
  counts: Record<string, number>;
  costUsd: number;
  tokens: number;
  elapsedHours: number;
  failedAttempts: number;
  byModel: Record<string, { attempts: number; costUsd: number; tokens: number }>;
  attemptsPerNode: Record<string, number>;
  loops: Array<{ key: string; iteration: number; status: string }>;
  throughput: { done: number };
};

export type AuditGaps = {
  doneWithoutProof: string[];
  acceptedWithDeviation: string[];
  graphAcceptedWithDeviation: boolean;
  waivedAims: Array<{
    aimId: string;
    key?: string;
    rationale?: string;
    actor: Annotation;
    createdAt: string;
  }>;
  manualCompletions: string[];
  openHighFindings: Note[];
};

export type StoredEvent = {
  seq: number;
  id: string;
  graphId: string | null;
  type: string;
  entityType: string;
  entityId: string;
  actor: Annotation;
  payload: Record<string, unknown>;
  createdAt: string;
  prevHash: string;
  hash: string;
};

export type LiveEvent = {
  seq: number;
  type: string;
  graphId: string | null;
  entity: { type: string; id: string };
  actor: Annotation;
  payload: Record<string, unknown>;
  createdAt: string;
  snapshot?: unknown;
};

export type ValidationOutput = {
  ok: boolean;
  normalized?: C.NormalizedSpec;
  errors: C.Issue[];
  warnings: C.Issue[];
  stats?: Record<string, number>;
};

export type Vocab = ReturnType<typeof C.vocabPayload> & { overrides: Record<string, unknown> };
