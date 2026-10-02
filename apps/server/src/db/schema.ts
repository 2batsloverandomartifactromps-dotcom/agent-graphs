/**
 * SQLite schema (docs/data-model.md). Property names match the engine entity fields in
 * @agent-graphs/core, so persistence maps entities to rows generically; SQL columns are
 * snake_case. Times are epoch ms; JSON columns hold JSON text.
 */
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

const json = <T = unknown>(name: string) => text(name, { mode: 'json' }).$type<T>();
const bool = (name: string) => integer(name, { mode: 'boolean' });
const time = (name: string) => integer(name);

export const graphs = sqliteTable(
  'graphs',
  {
    id: text('id').primaryKey(),
    slug: text('slug').unique(),
    title: text('title').notNull(),
    description: text('description'),
    status: text('status').notNull(),
    pendingApproval: bool('pending_approval').notNull().default(false),
    tags: json('tags').notNull(),
    repository: json('repository'),
    context: text('context'),
    constraints: json('constraints').notNull(),
    policy: json('policy').notNull(),
    defaults: json('defaults').notNull(),
    evolution: json('evolution').notNull(),
    metadata: json('metadata').notNull(),
    sourceSpec: json('source_spec'),
    revision: integer('revision').notNull(),
    version: integer('version').notNull(),
    stalled: bool('stalled').notNull().default(false),
    acceptedWithDeviation: bool('accepted_with_deviation').notNull().default(false),
    chainHead: text('chain_head'),
    createdBy: json('created_by').notNull(),
    createdAt: time('created_at').notNull(),
    updatedAt: time('updated_at').notNull(),
    startedAt: time('started_at'),
    completedAt: time('completed_at'),
    archivedAt: time('archived_at'),
    lastActivityAt: time('last_activity_at').notNull(),
  },
  (t) => [
    index('graphs_status_idx').on(t.status, t.archivedAt),
    index('graphs_activity_idx').on(t.lastActivityAt),
  ],
);

export const nodes = sqliteTable(
  'nodes',
  {
    id: text('id').primaryKey(),
    graphId: text('graph_id')
      .notNull()
      .references(() => graphs.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    title: text('title').notNull(),
    kind: text('kind').notNull(),
    aim: text('aim'),
    purpose: text('purpose'),
    prompt: text('prompt'),
    context: text('context'),
    deliverables: json('deliverables').notNull(),
    checklist: json('checklist').notNull(),
    aimMode: text('aim_mode').notNull(),
    priority: text('priority').notNull(),
    tags: json('tags').notNull(),
    executor: json('executor').notNull(),
    gate: json('gate'),
    maxAttempts: integer('max_attempts').notNull(),
    grantedAttempts: integer('granted_attempts').notNull(),
    onExhausted: text('on_exhausted').notNull(),
    leaseTtlSec: integer('lease_ttl_sec').notNull(),
    timeoutSec: integer('timeout_sec'),
    parentId: text('parent_id'),
    position: json('position'),
    metadata: json('metadata').notNull(),
    status: text('status').notNull(),
    statusReason: text('status_reason'),
    activation: integer('activation').notNull(),
    countedAttempts: integer('counted_attempts').notNull(),
    attemptsTotal: integer('attempts_total').notNull(),
    currentAttemptId: text('current_attempt_id'),
    acceptedWithDeviation: bool('accepted_with_deviation').notNull(),
    manual: bool('manual').notNull(),
    feedback: json('feedback'),
    deferredFailure: json('deferred_failure'),
    version: integer('version').notNull(),
    createdAt: time('created_at').notNull(),
    updatedAt: time('updated_at').notNull(),
    readyAt: time('ready_at'),
    startedAt: time('started_at'),
    completedAt: time('completed_at'),
  },
  (t) => [
    uniqueIndex('nodes_graph_key_uq').on(t.graphId, t.key),
    index('nodes_graph_status_idx').on(t.graphId, t.status),
    index('nodes_graph_priority_idx').on(t.graphId, t.priority),
  ],
);

export const edges = sqliteTable(
  'edges',
  {
    id: text('id').primaryKey(),
    graphId: text('graph_id')
      .notNull()
      .references(() => graphs.id, { onDelete: 'cascade' }),
    fromNodeId: text('from_node_id').notNull(),
    toNodeId: text('to_node_id').notNull(),
    kind: text('kind').notNull(),
    label: text('label'),
    relation: text('relation'),
    condition: text('condition'),
    guidance: text('guidance'),
    pitfalls: text('pitfalls'),
    attrProvenance: json('attr_provenance').notNull(),
    version: integer('version').notNull(),
    createdAt: time('created_at').notNull(),
    updatedAt: time('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('edges_uq').on(t.graphId, t.fromNodeId, t.toNodeId, t.kind),
    index('edges_from_idx').on(t.fromNodeId),
    index('edges_to_idx').on(t.toNodeId),
  ],
);

export const loops = sqliteTable(
  'loops',
  {
    id: text('id').primaryKey(),
    graphId: text('graph_id')
      .notNull()
      .references(() => graphs.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    title: text('title'),
    fromNodeId: text('from_node_id').notNull(),
    toNodeId: text('to_node_id').notNull(),
    body: json('body').notNull(),
    maxIterations: integer('max_iterations').notNull(),
    grantedIterations: integer('granted_iterations').notNull(),
    iteration: integer('iteration').notNull(),
    onExhausted: text('on_exhausted').notNull(),
    feedbackInstructions: text('feedback_instructions'),
    status: text('status').notNull(),
    lastFeedback: json('last_feedback'),
    version: integer('version').notNull(),
    createdAt: time('created_at').notNull(),
    updatedAt: time('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('loops_graph_key_uq').on(t.graphId, t.key),
    uniqueIndex('loops_trigger_uq').on(t.fromNodeId),
  ],
);

export const aims = sqliteTable(
  'aims',
  {
    id: text('id').primaryKey(),
    graphId: text('graph_id')
      .notNull()
      .references(() => graphs.id, { onDelete: 'cascade' }),
    ownerType: text('owner_type').notNull(),
    ownerId: text('owner_id').notNull(),
    key: text('key').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    kind: text('kind').notNull(),
    terminating: bool('terminating').notNull(),
    guard: bool('guard').notNull(),
    weight: real('weight'),
    metric: text('metric'),
    comparator: text('comparator'),
    target: real('target'),
    targetMax: real('target_max'),
    unit: text('unit'),
    source: text('source').notNull(),
    aggregation: text('aggregation').notNull(),
    criteria: json('criteria'),
    evaluator: text('evaluator').notNull(),
    evaluatorKey: text('evaluator_key'),
    implicit: bool('implicit').notNull(),
    sortOrder: integer('sort_order').notNull(),
    status: text('status').notNull(),
    currentValue: real('current_value'),
    lastEvaluationId: text('last_evaluation_id'),
    version: integer('version').notNull(),
    createdAt: time('created_at').notNull(),
    updatedAt: time('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('aims_owner_key_uq').on(t.ownerType, t.ownerId, t.key),
    index('aims_graph_idx').on(t.graphId),
  ],
);

export const attempts = sqliteTable(
  'attempts',
  {
    id: text('id').primaryKey(),
    graphId: text('graph_id')
      .notNull()
      .references(() => graphs.id, { onDelete: 'cascade' }),
    nodeId: text('node_id').notNull(),
    number: integer('number').notNull(),
    activation: integer('activation').notNull(),
    status: text('status').notNull(),
    counted: bool('counted').notNull(),
    sessionId: text('session_id'),
    executor: json('executor').notNull(),
    dispatchedBy: json('dispatched_by'),
    leaseExpiresAt: time('lease_expires_at'),
    lastHeartbeatAt: time('last_heartbeat_at'),
    progress: integer('progress'),
    currentStep: text('current_step'),
    checkpoint: json('checkpoint'),
    checklistState: json('checklist_state').notNull(),
    feedbackIn: json('feedback_in'),
    summary: text('summary'),
    outcomeReason: text('outcome_reason'),
    usage: json('usage'),
    manual: bool('manual').notNull(),
    briefingHash: text('briefing_hash'),
    lastProgressEventAt: time('last_progress_event_at'),
    timeoutEscalated: bool('timeout_escalated'),
    startedAt: time('started_at').notNull(),
    submittedAt: time('submitted_at'),
    passedAt: time('passed_at'),
    endedAt: time('ended_at'),
  },
  (t) => [
    uniqueIndex('attempts_node_number_uq').on(t.nodeId, t.number),
    index('attempts_graph_status_idx').on(t.graphId, t.status),
    index('attempts_lease_idx').on(t.status, t.leaseExpiresAt),
    index('attempts_session_idx').on(t.sessionId),
  ],
);

export const evaluations = sqliteTable(
  'evaluations',
  {
    id: text('id').primaryKey(),
    graphId: text('graph_id')
      .notNull()
      .references(() => graphs.id, { onDelete: 'cascade' }),
    aimId: text('aim_id').notNull(),
    attemptId: text('attempt_id'),
    activation: integer('activation').notNull(),
    verdict: text('verdict').notNull(),
    value: real('value'),
    score: real('score'),
    rationale: text('rationale'),
    evidence: json('evidence').notNull(),
    evaluatorKind: text('evaluator_kind').notNull(),
    actor: json('actor').notNull(),
    createdAt: time('created_at').notNull(),
  },
  (t) => [
    index('evaluations_aim_idx').on(t.aimId, t.createdAt),
    index('evaluations_attempt_idx').on(t.attemptId),
  ],
);

export const metrics = sqliteTable(
  'metrics',
  {
    id: text('id').primaryKey(),
    graphId: text('graph_id')
      .notNull()
      .references(() => graphs.id, { onDelete: 'cascade' }),
    nodeId: text('node_id'),
    attemptId: text('attempt_id'),
    name: text('name').notNull(),
    value: real('value').notNull(),
    unit: text('unit'),
    actor: json('actor').notNull(),
    noteId: text('note_id'),
    recordedAt: time('recorded_at').notNull(),
  },
  (t) => [
    index('metrics_graph_name_idx').on(t.graphId, t.name, t.recordedAt),
    index('metrics_attempt_idx').on(t.attemptId, t.name),
  ],
);

export const notes = sqliteTable(
  'notes',
  {
    id: text('id').primaryKey(),
    graphId: text('graph_id')
      .notNull()
      .references(() => graphs.id, { onDelete: 'cascade' }),
    nodeId: text('node_id'),
    attemptId: text('attempt_id'),
    orchestratorId: text('orchestrator_id'),
    replyTo: text('reply_to'),
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    severity: text('severity'),
    evidence: json('evidence').notNull(),
    metrics: json('metrics'),
    author: json('author').notNull(),
    relayedBy: json('relayed_by'),
    usage: json('usage'),
    pinned: bool('pinned').notNull(),
    retractedAt: time('retracted_at'),
    retractedReason: text('retracted_reason'),
    retractedBy: json('retracted_by'),
    resolvedAt: time('resolved_at'),
    resolvedBy: json('resolved_by'),
    resolutionNoteId: text('resolution_note_id'),
    createdAt: time('created_at').notNull(),
  },
  (t) => [
    index('notes_graph_idx').on(t.graphId, t.createdAt),
    index('notes_node_idx').on(t.nodeId, t.createdAt),
    index('notes_type_idx').on(t.graphId, t.type),
  ],
);

export const orchestrators = sqliteTable(
  'orchestrators',
  {
    id: text('id').primaryKey(),
    graphId: text('graph_id')
      .notNull()
      .references(() => graphs.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    role: text('role').notNull(),
    aim: text('aim'),
    purpose: text('purpose'),
    prompt: text('prompt'),
    scope: json('scope').notNull(),
    capabilities: json('capabilities').notNull(),
    triggers: json('triggers').notNull(),
    executor: json('executor').notNull(),
    metadata: json('metadata').notNull(),
    status: text('status').notNull(),
    sessionId: text('session_id'),
    leaseExpiresAt: time('lease_expires_at'),
    lastHeartbeatAt: time('last_heartbeat_at'),
    version: integer('version').notNull(),
    createdAt: time('created_at').notNull(),
    updatedAt: time('updated_at').notNull(),
  },
  (t) => [uniqueIndex('orchestrators_graph_key_uq').on(t.graphId, t.key)],
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    name: text('name'),
    role: text('role'),
    provider: text('provider'),
    model: text('model'),
    thinking: text('thinking'),
    thinkingBudget: integer('thinking_budget'),
    mechanism: text('mechanism'),
    version: text('version'),
    clientSessionId: text('client_session_id'),
    parentSessionId: text('parent_session_id'),
    tokenId: text('token_id'),
    skills: json('skills').notNull(),
    meta: json('meta').notNull(),
    status: text('status').notNull(),
    usage: json('usage'),
    startedAt: time('started_at').notNull(),
    lastSeenAt: time('last_seen_at').notNull(),
    endedAt: time('ended_at'),
  },
  (t) => [
    index('sessions_client_idx').on(t.clientSessionId),
    index('sessions_status_idx').on(t.status, t.lastSeenAt),
  ],
);

export const requests = sqliteTable(
  'requests',
  {
    id: text('id').primaryKey(),
    graphId: text('graph_id')
      .notNull()
      .references(() => graphs.id, { onDelete: 'cascade' }),
    nodeId: text('node_id'),
    attemptId: text('attempt_id'),
    aimId: text('aim_id'),
    loopId: text('loop_id'),
    kind: text('kind').notNull(),
    subject: text('subject').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    options: json('options').notNull(),
    assignee: text('assignee').notNull(),
    assigneeKey: text('assignee_key'),
    blocking: bool('blocking').notNull(),
    status: text('status').notNull(),
    createdBy: json('created_by').notNull(),
    resolution: json('resolution'),
    resolvedBy: json('resolved_by'),
    createdAt: time('created_at').notNull(),
    resolvedAt: time('resolved_at'),
    expiresAt: time('expires_at'),
  },
  (t) => [
    index('requests_status_idx').on(t.status, t.graphId),
    index('requests_node_idx').on(t.nodeId),
  ],
);

export const directives = sqliteTable(
  'directives',
  {
    id: text('id').primaryKey(),
    graphId: text('graph_id')
      .notNull()
      .references(() => graphs.id, { onDelete: 'cascade' }),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    data: json('data'),
    requiresAck: bool('requires_ack').notNull(),
    status: text('status').notNull(),
    requestId: text('request_id'),
    supersedes: text('supersedes'),
    expiresAt: time('expires_at'),
    createdBy: json('created_by').notNull(),
    createdAt: time('created_at').notNull(),
  },
  (t) => [index('directives_target_idx').on(t.graphId, t.targetType, t.targetId, t.status)],
);

export const directiveDeliveries = sqliteTable(
  'directive_deliveries',
  {
    directiveId: text('directive_id').notNull(),
    recipient: text('recipient').notNull(),
    graphId: text('graph_id').notNull(),
    deliveredAt: time('delivered_at').notNull(),
    deliveredVia: text('delivered_via').notNull(),
    ackedAt: time('acked_at'),
    ackedBy: json('acked_by'),
    ackNote: text('ack_note'),
  },
  (t) => [
    primaryKey({ columns: [t.directiveId, t.recipient] }),
    index('deliveries_graph_idx').on(t.graphId),
  ],
);

export const lessonDuties = sqliteTable(
  'lesson_duties',
  {
    id: text('id').primaryKey(),
    graphId: text('graph_id')
      .notNull()
      .references(() => graphs.id, { onDelete: 'cascade' }),
    nodeId: text('node_id').notNull(),
    passedAttemptId: text('passed_attempt_id').notNull(),
    failedAttemptIds: json('failed_attempt_ids').notNull(),
    status: text('status').notNull(),
    lessonId: text('lesson_id'),
    assignee: text('assignee').notNull(),
    createdAt: time('created_at').notNull(),
    closedAt: time('closed_at'),
  },
  (t) => [index('lesson_duties_graph_idx').on(t.graphId, t.status)],
);

export const lessons = sqliteTable(
  'lessons',
  {
    id: text('id').primaryKey(),
    scope: json('scope').notNull(),
    kind: text('kind').notNull(),
    condition: text('condition'),
    content: text('content').notNull(),
    evidence: json('evidence').notNull(),
    source: text('source').notNull(),
    counters: json('counters').notNull(),
    status: text('status').notNull(),
    version: integer('version').notNull(),
    supersedes: text('supersedes'),
    author: json('author').notNull(),
    createdAt: time('created_at').notNull(),
    updatedAt: time('updated_at').notNull(),
  },
  (t) => [index('lessons_status_idx').on(t.status)],
);

export const lessonApplications = sqliteTable(
  'lesson_applications',
  {
    lessonId: text('lesson_id').notNull(),
    attemptId: text('attempt_id').notNull(),
    outcome: text('outcome').notNull(),
    tag: text('tag'),
    createdAt: time('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.lessonId, t.attemptId] })],
);

export const events = sqliteTable(
  'events',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    id: text('id').notNull().unique(),
    graphId: text('graph_id'),
    type: text('type').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    actor: json('actor').notNull(),
    payload: json('payload').notNull(),
    createdAt: time('created_at').notNull(),
    prevHash: text('prev_hash').notNull(),
    hash: text('hash').notNull(),
  },
  (t) => [
    index('events_graph_idx').on(t.graphId, t.seq),
    index('events_entity_idx').on(t.entityType, t.entityId, t.seq),
    index('events_type_idx').on(t.type, t.seq),
  ],
);

export const apiTokens = sqliteTable('api_tokens', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  role: text('role').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  prefix: text('prefix').notNull(),
  createdBy: json('created_by'),
  createdAt: time('created_at').notNull(),
  lastUsedAt: time('last_used_at'),
  revokedAt: time('revoked_at'),
});

export const idempotencyKeys = sqliteTable(
  'idempotency_keys',
  {
    tokenId: text('token_id').notNull(),
    key: text('key').notNull(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    requestHash: text('request_hash').notNull(),
    statusCode: integer('status_code').notNull(),
    responseBody: text('response_body').notNull(),
    createdAt: time('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.tokenId, t.key] })],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: json('value').notNull(),
});
