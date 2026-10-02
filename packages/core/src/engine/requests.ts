/** Requests, directives, notes, and evaluations: the record-keeping primitives. */
import type { Evidence } from '../schemas/common';
import type {
  DirectiveKind,
  DirectiveTarget,
  NoteType,
  RequestAssignee,
  RequestKind,
  RequestSubject,
  Verdict,
} from '../vocabulary';
import type {
  Aim,
  Directive,
  Evaluation,
  GraphState,
  HumanRequest,
  Note,
  RequestOption,
  Tx,
} from './types';

/** Option ids per subject: the resolution contract of concepts §11.1. */
export const REQUEST_OPTIONS: Record<RequestSubject, RequestOption[]> = {
  gate: [
    { id: 'approve', label: 'Approve' },
    { id: 'reject', label: 'Reject', description: 'Comment required; fires the loop if any.' },
  ],
  aim: [
    { id: 'approve', label: 'Met' },
    { id: 'reject', label: 'Not met', description: 'Comment required.' },
  ],
  plan: [
    { id: 'approve', label: 'Approve and start' },
    { id: 'reject', label: 'Reject', description: 'The comment becomes guidance.' },
  ],
  proposal: [
    { id: 'approve', label: 'Commit proposal' },
    { id: 'reject', label: 'Reject proposal' },
  ],
  question: [{ id: 'answer', label: 'Answer' }],
  exhaustion: [
    { id: 'retry', label: 'Retry', description: 'Grant more attempts.' },
    { id: 'accept', label: 'Accept as-is', description: 'Done with deviation.' },
    { id: 'skip', label: 'Skip' },
    { id: 'fail', label: 'Fail' },
    { id: 'edit_retry', label: 'Edit & retry' },
  ],
  loop: [
    { id: 'extend', label: 'Extend', description: 'Grant iterations; fires immediately.' },
    { id: 'accept', label: 'Accept as-is' },
    { id: 'fail', label: 'Fail' },
    { id: 'edit_retry', label: 'Edit & retry' },
  ],
  guard: [
    { id: 'raise_target', label: 'Raise target', description: 'Human only.' },
    { id: 'waive', label: 'Waive guard' },
    { id: 'fail', label: 'Fail graph' },
  ],
  stall: [
    { id: 'retry', label: 'Retry node' },
    { id: 'skip', label: 'Skip node' },
    { id: 'fail', label: 'Fail node' },
    { id: 'fail_graph', label: 'Fail graph' },
  ],
  verification: [
    { id: 'add_work', label: 'Add work' },
    { id: 'waive', label: 'Waive aim' },
    { id: 'accept', label: 'Accept with deviation' },
    { id: 'fail', label: 'Fail graph' },
  ],
  timeout: [
    { id: 'extend', label: 'Extend timeout' },
    { id: 'fail_attempt', label: 'Fail attempt' },
    { id: 'ignore', label: 'Ignore' },
  ],
  milestone: [
    { id: 'waive', label: 'Waive aim' },
    { id: 'add_work', label: 'Add work' },
    { id: 'fail', label: 'Fail' },
  ],
  blocker: [
    { id: 'unblock', label: 'Unblock' },
    { id: 'skip', label: 'Skip node' },
    { id: 'fail', label: 'Fail node' },
  ],
};

export type OpenRequestInput = {
  kind: RequestKind;
  subject: RequestSubject;
  title: string;
  body?: string;
  nodeId?: string;
  attemptId?: string;
  aimId?: string;
  loopId?: string;
  assignee?: RequestAssignee;
  assigneeKey?: string;
  blocking?: boolean;
  options?: RequestOption[];
};

export function openRequest(state: GraphState, tx: Tx, input: OpenRequestInput): HumanRequest {
  const request: HumanRequest = {
    id: tx.ctx.id('rq'),
    graphId: state.graph.id,
    kind: input.kind,
    subject: input.subject,
    title: input.title,
    options: input.options ?? REQUEST_OPTIONS[input.subject],
    assignee: input.assignee ?? 'any',
    blocking: input.blocking ?? true,
    status: 'open',
    createdBy: tx.ctx.actor,
    createdAt: tx.ctx.now,
  };
  for (const k of ['body', 'nodeId', 'attemptId', 'aimId', 'loopId', 'assigneeKey'] as const) {
    if (input[k] !== undefined) request[k] = input[k];
  }
  state.requests.set(request.id, tx.touch('request', request));
  tx.emit('request.created', state.graph.id, 'request', request.id, {
    kind: request.kind,
    subject: request.subject,
    title: request.title,
    nodeId: request.nodeId,
    assignee: request.assignee,
  });
  return request;
}

/** Dismiss open requests matching a predicate (their subject was handled another way). */
export function dismissRequests(
  state: GraphState,
  tx: Tx,
  match: (r: HumanRequest) => boolean,
  reason: string,
): void {
  for (const r of state.requests.values()) {
    if (r.status !== 'open' || !match(r)) continue;
    r.status = 'dismissed';
    r.resolution = { choice: 'dismissed', comment: reason };
    r.resolvedBy = tx.ctx.actor;
    r.resolvedAt = tx.ctx.now;
    tx.touch('request', r);
    tx.emit('request.dismissed', state.graph.id, 'request', r.id, { reason });
  }
}

export type DirectiveInput = {
  targetType: DirectiveTarget;
  targetId: string;
  kind: DirectiveKind;
  title: string;
  body?: string;
  data?: Record<string, unknown>;
  requiresAck?: boolean;
  requestId?: string;
  supersedes?: string;
  expiresAt?: number;
};

export function createDirective(state: GraphState, tx: Tx, input: DirectiveInput): Directive {
  const directive: Directive = {
    id: tx.ctx.id('dr'),
    graphId: state.graph.id,
    targetType: input.targetType,
    targetId: input.targetId,
    kind: input.kind,
    title: input.title,
    requiresAck: input.requiresAck ?? (input.kind === 'guidance' || input.kind === 'answer'),
    status: 'pending',
    createdBy: tx.ctx.actor,
    createdAt: tx.ctx.now,
  };
  for (const k of ['body', 'data', 'requestId', 'supersedes', 'expiresAt'] as const) {
    if (input[k] !== undefined) (directive as Record<string, unknown>)[k] = input[k];
  }
  if (input.supersedes) {
    const old = state.directives.get(input.supersedes);
    if (old && old.status !== 'superseded') {
      old.status = 'superseded';
      tx.touch('directive', old);
      tx.emit('directive.superseded', state.graph.id, 'directive', old.id, { by: directive.id });
    }
  }
  state.directives.set(directive.id, tx.touch('directive', directive));
  tx.emit('directive.created', state.graph.id, 'directive', directive.id, {
    kind: directive.kind,
    targetType: directive.targetType,
    targetId: directive.targetId,
    title: directive.title,
  });
  return directive;
}

export type NoteInput = {
  type: NoteType;
  title: string;
  body?: string;
  nodeId?: string;
  attemptId?: string;
  orchestratorId?: string;
  replyTo?: string;
  severity?: string;
  evidence?: Evidence[];
  metrics?: Record<string, number>;
};

/** Notes are append-only and live outside GraphState; the engine only emits new ones. */
export function createNote(state: GraphState, tx: Tx, input: NoteInput): Note {
  const note: Note = {
    id: tx.ctx.id('nt'),
    graphId: state.graph.id,
    type: input.type,
    title: input.title,
    evidence: input.evidence ?? [],
    author: tx.ctx.actor,
    pinned: false,
    createdAt: tx.ctx.now,
  };
  for (const k of [
    'body',
    'nodeId',
    'attemptId',
    'orchestratorId',
    'replyTo',
    'severity',
    'metrics',
  ] as const) {
    if (input[k] !== undefined) (note as Record<string, unknown>)[k] = input[k];
  }
  tx.touch('note', note);
  tx.emit('note.created', state.graph.id, 'note', note.id, {
    type: note.type,
    title: note.title,
    nodeId: note.nodeId,
    attemptId: note.attemptId,
    severity: note.severity,
  });
  return note;
}

export type EvaluationInput = {
  aim: Aim;
  verdict: Verdict;
  attemptId?: string;
  activation: number;
  value?: number;
  score?: number;
  rationale?: string;
  evidence?: Evidence[];
  evaluatorKind: Evaluation['evaluatorKind'];
};

/** Record a verdict and mirror it onto the aim's live status. */
export function recordEvaluation(state: GraphState, tx: Tx, input: EvaluationInput): Evaluation {
  const evaluation: Evaluation = {
    id: tx.ctx.id('ev'),
    graphId: state.graph.id,
    aimId: input.aim.id,
    activation: input.activation,
    verdict: input.verdict,
    evidence: input.evidence ?? [],
    evaluatorKind: input.evaluatorKind,
    actor: tx.ctx.actor,
    createdAt: tx.ctx.now,
  };
  for (const k of ['attemptId', 'value', 'score', 'rationale'] as const) {
    if (input[k] !== undefined) (evaluation as Record<string, unknown>)[k] = input[k];
  }
  state.evaluations.push(tx.touch('evaluation', evaluation));
  const aim = input.aim;
  aim.status = input.verdict;
  if (input.value !== undefined) aim.currentValue = input.value;
  aim.lastEvaluationId = evaluation.id;
  aim.updatedAt = tx.ctx.now;
  tx.touch('aim', aim);
  tx.emit(
    input.verdict === 'waived' ? 'aim.waived' : 'aim.evaluated',
    state.graph.id,
    'aim',
    aim.id,
    {
      key: aim.key,
      verdict: input.verdict,
      value: input.value,
      attemptId: input.attemptId,
      rationale: input.rationale,
      evaluatorKind: input.evaluatorKind,
    },
  );
  return evaluation;
}
