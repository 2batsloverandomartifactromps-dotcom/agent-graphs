/**
 * Engine entities and state. Shapes mirror docs/data-model.md (camelCase, epoch-ms times).
 * The engine mutates a loaded GraphState and records every touched entity and event in a Tx;
 * the server persists `tx.dirty` and `tx.events` in one transaction ("effects").
 */
import type { Evidence, ExecutionAnnotation, Usage } from '../schemas/common';
import type {
  ChecklistItem,
  Deliverable,
  Executor,
  NormalizedScope,
  ResolvedEvolution,
  ResolvedPolicy,
} from '../spec/normalize';
import type {
  Aggregation,
  AimKind,
  AimMode,
  AimSource,
  AimStatus,
  AttemptStatus,
  Comparator,
  DirectiveKind,
  DirectiveStatus,
  DirectiveTarget,
  EdgeKind,
  EdgeRelation,
  Evaluator,
  ExhaustionPolicy,
  GateApprover,
  GraphStatus,
  LoopStatus,
  NodeKind,
  NodeStatus,
  NoteType,
  OrchestratorCapability,
  OrchestratorRole,
  OrchestratorStatus,
  Priority,
  RequestAssignee,
  RequestKind,
  RequestStatus,
  RequestSubject,
  Verdict,
} from '../vocabulary';

export type Graph = {
  id: string;
  slug?: string;
  title: string;
  description?: string;
  status: GraphStatus;
  pendingApproval: boolean;
  tags: string[];
  repository?: { url: string; branch?: string; path?: string };
  context?: string;
  constraints: string[];
  policy: ResolvedPolicy;
  defaults: Record<string, unknown>;
  evolution: ResolvedEvolution;
  metadata: Record<string, unknown>;
  revision: number;
  version: number;
  stalled: boolean;
  acceptedWithDeviation: boolean;
  createdBy: ExecutionAnnotation;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  archivedAt?: number;
  lastActivityAt: number;
};

export type FeedbackPacket = {
  source: 'attempt' | 'loop' | 'gate' | 'escalation' | 'answer';
  attemptId?: string;
  loopKey?: string;
  iteration?: number;
  outcome?: AttemptStatus;
  reason?: string;
  summary?: string;
  unmetAims?: Array<{
    key: string;
    title: string;
    value?: number;
    target?: number;
    rationale?: string;
  }>;
  checkpoint?: unknown;
  comment?: string;
};

export type Node = {
  id: string;
  graphId: string;
  key: string;
  title: string;
  kind: NodeKind;
  aim?: string;
  purpose?: string;
  prompt?: string;
  context?: string;
  deliverables: Deliverable[];
  checklist: ChecklistItem[];
  aimMode: AimMode;
  priority: Priority;
  tags: string[];
  executor: Executor;
  gate?: { approver: GateApprover; approverKey?: string; instructions?: string };
  maxAttempts: number;
  grantedAttempts: number;
  onExhausted: ExhaustionPolicy;
  leaseTtlSec: number;
  timeoutSec?: number;
  parentId?: string;
  position?: { x: number; y: number };
  metadata: Record<string, unknown>;
  status: NodeStatus;
  statusReason?: string;
  activation: number;
  countedAttempts: number;
  attemptsTotal: number;
  currentAttemptId?: string;
  acceptedWithDeviation: boolean;
  manual: boolean;
  /** Feedback handed to the next attempt (retry, loop, escalation edits). */
  feedback?: FeedbackPacket;
  /** A failure decision deferred while paused. */
  deferredFailure?: { attemptId: string; outcome: AttemptStatus };
  version: number;
  createdAt: number;
  updatedAt: number;
  readyAt?: number;
  startedAt?: number;
  completedAt?: number;
};

export type Edge = {
  id: string;
  graphId: string;
  fromNodeId: string;
  toNodeId: string;
  kind: EdgeKind;
  label?: string;
  relation?: EdgeRelation;
  condition?: string;
  guidance?: string;
  pitfalls?: string;
  attrProvenance: Record<string, unknown>;
  version: number;
  createdAt: number;
  updatedAt: number;
};

export type Loop = {
  id: string;
  graphId: string;
  key: string;
  title?: string;
  fromNodeId: string;
  toNodeId: string;
  body: string[];
  maxIterations: number;
  grantedIterations: number;
  iteration: number;
  onExhausted: ExhaustionPolicy;
  feedbackInstructions?: string;
  status: LoopStatus;
  lastFeedback?: FeedbackPacket;
  version: number;
  createdAt: number;
  updatedAt: number;
};

export type Aim = {
  id: string;
  graphId: string;
  ownerType: 'graph' | 'node' | 'orchestrator';
  ownerId: string;
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
  /** Gates get one implicit approval aim. */
  implicit: boolean;
  sortOrder: number;
  status: AimStatus;
  currentValue?: number;
  lastEvaluationId?: string;
  version: number;
  createdAt: number;
  updatedAt: number;
};

export type Attempt = {
  id: string;
  graphId: string;
  nodeId: string;
  number: number;
  activation: number;
  status: AttemptStatus;
  counted: boolean;
  sessionId?: string;
  executor: ExecutionAnnotation;
  dispatchedBy?: ExecutionAnnotation & { orchestratorKey?: string };
  leaseExpiresAt?: number;
  lastHeartbeatAt?: number;
  progress?: number;
  currentStep?: string;
  checkpoint?: unknown;
  checklistState: Record<string, { done: boolean; evidence?: Evidence[]; at: number }>;
  feedbackIn?: FeedbackPacket;
  summary?: string;
  outcomeReason?: string;
  usage?: Usage;
  manual: boolean;
  /** Rate limit for `attempt.progress` events (one per minute). */
  lastProgressEventAt?: number;
  /** A timeout escalation is open or was answered with `ignore`. */
  timeoutEscalated?: boolean;
  startedAt: number;
  submittedAt?: number;
  endedAt?: number;
};

export type Evaluation = {
  id: string;
  graphId: string;
  aimId: string;
  attemptId?: string;
  activation: number;
  verdict: Verdict;
  value?: number;
  score?: number;
  rationale?: string;
  evidence: Evidence[];
  evaluatorKind: Evaluator | 'system';
  actor: ExecutionAnnotation;
  createdAt: number;
};

export type MetricReport = {
  id: string;
  graphId: string;
  nodeId?: string;
  attemptId?: string;
  name: string;
  value: number;
  unit?: string;
  actor: ExecutionAnnotation;
  recordedAt: number;
};

export type Orchestrator = {
  id: string;
  graphId: string;
  key: string;
  name: string;
  role: OrchestratorRole;
  aim?: string;
  purpose?: string;
  prompt?: string;
  scope: NormalizedScope;
  capabilities: OrchestratorCapability[];
  triggers: string[];
  executor: Executor;
  metadata: Record<string, unknown>;
  status: OrchestratorStatus;
  sessionId?: string;
  leaseExpiresAt?: number;
  lastHeartbeatAt?: number;
  version: number;
  createdAt: number;
  updatedAt: number;
};

export type RequestOption = { id: string; label: string; description?: string };

export type HumanRequest = {
  id: string;
  graphId: string;
  nodeId?: string;
  attemptId?: string;
  aimId?: string;
  loopId?: string;
  kind: RequestKind;
  subject: RequestSubject;
  title: string;
  body?: string;
  options: RequestOption[];
  assignee: RequestAssignee;
  assigneeKey?: string;
  blocking: boolean;
  status: RequestStatus;
  createdBy: ExecutionAnnotation;
  resolution?: { choice: string; comment?: string; data?: Record<string, unknown> };
  resolvedBy?: ExecutionAnnotation;
  createdAt: number;
  resolvedAt?: number;
  expiresAt?: number;
};

export type Directive = {
  id: string;
  graphId: string;
  targetType: DirectiveTarget;
  targetId: string;
  kind: DirectiveKind;
  title: string;
  body?: string;
  data?: Record<string, unknown>;
  requiresAck: boolean;
  status: DirectiveStatus;
  requestId?: string;
  supersedes?: string;
  expiresAt?: number;
  createdBy: ExecutionAnnotation;
  createdAt: number;
};

export type DirectiveDelivery = {
  directiveId: string;
  recipient: string;
  deliveredAt: number;
  deliveredVia: 'claim' | 'briefing' | 'heartbeat' | 'hook';
  ackedAt?: number;
  ackedBy?: ExecutionAnnotation;
  ackNote?: string;
};

export type Note = {
  id: string;
  graphId: string;
  nodeId?: string;
  attemptId?: string;
  orchestratorId?: string;
  replyTo?: string;
  type: NoteType;
  title: string;
  body?: string;
  severity?: string;
  evidence: Evidence[];
  metrics?: Record<string, number>;
  author: ExecutionAnnotation;
  relayedBy?: ExecutionAnnotation;
  usage?: Usage;
  pinned: boolean;
  retractedAt?: number;
  retractedReason?: string;
  resolvedAt?: number;
  createdAt: number;
};

export type LessonDuty = {
  id: string;
  graphId: string;
  nodeId: string;
  passedAttemptId: string;
  failedAttemptIds: string[];
  status: 'open' | 'fulfilled' | 'dismissed';
  lessonId?: string;
  assignee: 'worker' | 'evolver';
  createdAt: number;
  closedAt?: number;
};

/** Everything the engine needs about one graph. Notes/events stay in the database. */
export type GraphState = {
  graph: Graph;
  nodes: Map<string, Node>;
  edges: Edge[];
  loops: Loop[];
  aims: Map<string, Aim>;
  attempts: Map<string, Attempt>;
  evaluations: Evaluation[];
  metrics: MetricReport[];
  orchestrators: Map<string, Orchestrator>;
  requests: Map<string, HumanRequest>;
  directives: Map<string, Directive>;
  deliveries: DirectiveDelivery[];
  lessonDuties: Map<string, LessonDuty>;
  /** Supplied by the loader: unresolved high/critical findings (for `open_findings_high`). */
  openHighFindings?: number;
};

export type EntityKind =
  | 'graph'
  | 'node'
  | 'edge'
  | 'loop'
  | 'aim'
  | 'attempt'
  | 'evaluation'
  | 'metric'
  | 'orchestrator'
  | 'request'
  | 'directive'
  | 'delivery'
  | 'note'
  | 'lessonDuty';

export type DomainEvent = {
  type: string;
  graphId: string;
  entityType: string;
  entityId: string;
  actor: ExecutionAnnotation;
  payload: Record<string, unknown>;
  createdAt: number;
};

export type IdPrefix =
  | 'gr'
  | 'nd'
  | 'ed'
  | 'lp'
  | 'am'
  | 'at'
  | 'ev'
  | 'mt'
  | 'nt'
  | 'or'
  | 'se'
  | 'rq'
  | 'dr'
  | 'ld';

export type EngineCtx = {
  now: number;
  id: (prefix: IdPrefix) => string;
  actor: ExecutionAnnotation;
};

/** Collects touched entities (upserts) and events for one command. */
export class Tx {
  readonly dirty = new Map<string, { kind: EntityKind; entity: { id?: string } }>();
  readonly events: DomainEvent[] = [];
  constructor(readonly ctx: EngineCtx) {}

  touch<T extends object>(kind: EntityKind, entity: T): T {
    const e = entity as { id?: string; directiveId?: string; recipient?: string };
    const key = `${kind}:${e.id ?? `${e.directiveId}:${e.recipient}`}`;
    this.dirty.set(key, { kind, entity: entity as { id?: string } });
    return entity;
  }

  emit(
    type: string,
    graphId: string,
    entityType: string,
    entityId: string,
    payload: Record<string, unknown> = {},
  ): void {
    this.events.push({
      type,
      graphId,
      entityType,
      entityId,
      actor: this.ctx.actor,
      payload,
      createdAt: this.ctx.now,
    });
  }

  touched<K extends EntityKind>(kind: K): Array<{ id?: string }> {
    return [...this.dirty.values()].filter((d) => d.kind === kind).map((d) => d.entity);
  }
}

export const SYSTEM_ACTOR: ExecutionAnnotation = { kind: 'system', agent: 'agent-graphs' };

export class EngineError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly status = 409,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}
