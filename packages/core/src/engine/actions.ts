/**
 * Human and orchestrator actions: graph lifecycle (§2.1), node actions (§3.4), waivers (§6.5),
 * loop extension (§7.2), and request resolution per the option catalog (§11.1).
 */
import { durationToSeconds, type Evidence } from '../schemas/common';
import type { Verdict } from '../vocabulary';
import { manualAttempt, type SubmitEvaluation } from './attempts';
import { createDirective, dismissRequests, recordEvaluation } from './requests';
import {
  aimByKey,
  aimsOf,
  graphAims,
  isTerminal,
  loopByKey,
  loopTriggeredBy,
  nodeByKey,
  openAttempt,
  openRequestsFor,
  prerequisitesSatisfied,
  requiresDescendants,
} from './state';
import {
  afterVerdict,
  applyFailure,
  closeOpenAttempt,
  completeNode,
  decideAttempt,
  endAttempt,
  exhaustLoop,
  failGraph,
  failNode,
  fireLoop,
  newActivation,
  pauseGraph,
  reevaluateMilestone,
  setGraphStatus,
  setNodeStatus,
  skipNode,
  touchGraph,
} from './transitions';
import {
  type Aim,
  EngineError,
  type FeedbackPacket,
  type GraphState,
  type HumanRequest,
  type Node,
  type Tx,
} from './types';

function invalid(message: string, hint?: string): EngineError {
  return new EngineError('INVALID_TRANSITION', message, hint);
}

function requireStatus(node: Node, allowed: readonly string[], action: string): void {
  if (!allowed.includes(node.status)) {
    throw invalid(
      `Cannot ${action} '${node.key}' while it is ${node.status}.`,
      `${action} is allowed from: ${allowed.join(', ')}.`,
    );
  }
}

function requireReason(reason: string | undefined, what: string): string {
  if (!reason?.trim())
    throw new EngineError('BAD_REQUEST', `${what} requires a reason.`, undefined, 400);
  return reason;
}

// ─── Graph lifecycle ──────────────────────────────────────────────────────────

export function startGraph(
  state: GraphState,
  tx: Tx,
): { started: boolean; request?: HumanRequest } {
  const g = state.graph;
  if (g.status !== 'draft') throw invalid(`Graph is ${g.status}; only drafts can be started.`);
  if (g.policy.requirePlanApproval && tx.ctx.actor.kind !== 'human') {
    const existing = [...state.requests.values()].find(
      (r) => r.status === 'open' && r.subject === 'plan',
    );
    if (existing) return { started: false, request: existing };
    g.pendingApproval = true;
    touchGraph(state, tx);
    const request = createPlanRequest(state, tx);
    return { started: false, request };
  }
  g.pendingApproval = false;
  dismissRequests(state, tx, (r) => r.subject === 'plan', 'graph started');
  setGraphStatus(state, tx, 'active', 'graph.started');
  return { started: true };
}

function createPlanRequest(state: GraphState, tx: Tx): HumanRequest {
  const id = tx.ctx.id('rq');
  const request: HumanRequest = {
    id,
    graphId: state.graph.id,
    kind: 'approval',
    subject: 'plan',
    title: `Approve plan: ${state.graph.title}`,
    body: `${state.nodes.size} nodes, ${state.loops.length} loops. Review the graph, edit if needed, then approve to start.`,
    options: [
      { id: 'approve', label: 'Approve and start' },
      { id: 'reject', label: 'Reject', description: 'The comment becomes guidance.' },
    ],
    assignee: 'human',
    blocking: true,
    status: 'open',
    createdBy: tx.ctx.actor,
    createdAt: tx.ctx.now,
  };
  state.requests.set(id, tx.touch('request', request));
  tx.emit('request.created', state.graph.id, 'request', id, {
    kind: 'approval',
    subject: 'plan',
    title: request.title,
  });
  return request;
}

export function pause(state: GraphState, tx: Tx, reason?: string): void {
  if (state.graph.status !== 'active')
    throw invalid(`Graph is ${state.graph.status}; only active graphs pause.`);
  pauseGraph(state, tx, reason);
}

export function resume(state: GraphState, tx: Tx): void {
  if (state.graph.status !== 'paused')
    throw invalid(`Graph is ${state.graph.status}; only paused graphs resume.`);
  const guardOpen = [...state.requests.values()].some(
    (r) => r.status === 'open' && r.subject === 'guard',
  );
  if (guardOpen) {
    throw invalid(
      'A guard escalation is open; resuming would re-trip the guard.',
      'Resolve the guard request (raise_target, waive, or fail).',
    );
  }
  setGraphStatus(state, tx, 'active', 'graph.resumed');
  createDirective(state, tx, {
    targetType: 'graph',
    targetId: state.graph.id,
    kind: 'resume',
    title: 'Graph resumed',
    requiresAck: false,
  });
}

export function cancel(state: GraphState, tx: Tx, reason?: string): void {
  const g = state.graph;
  if (!['draft', 'active', 'paused', 'verifying'].includes(g.status)) {
    throw invalid(`Graph is ${g.status}; it cannot be cancelled.`);
  }
  for (const node of state.nodes.values()) {
    closeOpenAttempt(state, tx, node, 'cancelled', 'graph cancelled');
    if (!isTerminal(node.status)) setNodeStatus(state, tx, node, 'cancelled', 'graph cancelled');
  }
  dismissRequests(state, tx, () => true, 'graph cancelled');
  createDirective(state, tx, {
    targetType: 'graph',
    targetId: g.id,
    kind: 'cancel',
    title: 'Graph cancelled',
    requiresAck: false,
  });
  setGraphStatus(state, tx, 'cancelled', 'graph.cancelled', reason ? { reason } : {});
}

export function fail(state: GraphState, tx: Tx, reason: string): void {
  if (!['active', 'paused', 'verifying'].includes(state.graph.status)) {
    throw invalid(`Graph is ${state.graph.status}; it cannot be failed.`);
  }
  failGraph(state, tx, requireReason(reason, 'Failing a graph'));
}

/** completed | failed → active, so nodes can be added or reopened. */
export function reopenGraph(state: GraphState, tx: Tx, reason?: string): void {
  const g = state.graph;
  if (g.status !== 'completed' && g.status !== 'failed' && g.status !== 'verifying') {
    throw invalid(`Graph is ${g.status}; only completed, failed, or verifying graphs reopen.`);
  }
  g.acceptedWithDeviation = false;
  dismissRequests(
    state,
    tx,
    (r) => r.subject === 'verification' || (r.subject === 'aim' && !r.nodeId),
    'graph reopened',
  );
  for (const aim of graphAims(state)) {
    if (aim.status !== 'waived') {
      aim.status = 'pending';
      tx.touch('aim', aim);
    }
  }
  setGraphStatus(state, tx, 'active', 'graph.reopened', reason ? { reason } : {});
}

export function archive(state: GraphState, tx: Tx, archived: boolean): void {
  const g = state.graph;
  if (archived && (g.status === 'active' || g.status === 'verifying')) {
    throw invalid(
      `An ${g.status} graph cannot be archived.`,
      'Pause, complete, or cancel it first.',
    );
  }
  if (archived) g.archivedAt = tx.ctx.now;
  else delete g.archivedAt;
  touchGraph(state, tx);
  tx.emit(archived ? 'graph.archived' : 'graph.unarchived', g.id, 'graph', g.id, {});
}

// ─── Node actions (§3.4) ──────────────────────────────────────────────────────

export function pauseNode(state: GraphState, tx: Tx, nodeId: string): void {
  const node = state.nodes.get(nodeId) as Node;
  requireStatus(
    node,
    ['pending', 'ready', 'running', 'evaluating', 'needs_input', 'blocked'],
    'pause',
  );
  const attempt = openAttempt(state, node.id);
  if (attempt?.status === 'running') {
    createDirective(state, tx, {
      targetType: 'attempt',
      targetId: attempt.id,
      kind: 'pause',
      title: `Node ${node.key} paused: checkpoint, write a handoff, and release`,
      requiresAck: false,
    });
  }
  setNodeStatus(state, tx, node, 'paused', 'paused by decision');
  if (attempt) node.currentAttemptId = attempt.id;
}

export function resumeNode(state: GraphState, tx: Tx, nodeId: string): void {
  const node = state.nodes.get(nodeId) as Node;
  requireStatus(node, ['paused'], 'resume');
  const attempt = openAttempt(state, node.id);
  if (attempt) {
    createDirective(state, tx, {
      targetType: 'attempt',
      targetId: attempt.id,
      kind: 'resume',
      title: `Node ${node.key} resumed`,
      requiresAck: false,
    });
    setNodeStatus(state, tx, node, attempt.status === 'running' ? 'running' : 'evaluating');
    node.currentAttemptId = attempt.id;
    return;
  }
  if (node.deferredFailure) {
    const deferred = state.attempts.get(node.deferredFailure.attemptId);
    delete node.deferredFailure;
    if (deferred) applyFailure(state, tx, node, deferred, { resumed: true });
    else setNodeStatus(state, tx, node, 'pending', 'resumed');
    return;
  }
  const blocking = openRequestsFor(state, node.id).find((r) => r.blocking);
  if (blocking) {
    setNodeStatus(state, tx, node, blocking.kind === 'blocker' ? 'blocked' : 'needs_input');
    return;
  }
  setNodeStatus(state, tx, node, 'pending', 'resumed');
}

export function skip(state: GraphState, tx: Tx, nodeId: string, reason: string): void {
  const node = state.nodes.get(nodeId) as Node;
  requireStatus(
    node,
    ['pending', 'ready', 'running', 'evaluating', 'needs_input', 'blocked', 'failed'],
    'skip',
  );
  skipNode(state, tx, node, requireReason(reason, 'Skipping'));
}

export function failNodeAction(state: GraphState, tx: Tx, nodeId: string, reason: string): void {
  const node = state.nodes.get(nodeId) as Node;
  requireStatus(node, ['ready', 'running', 'evaluating', 'needs_input', 'blocked'], 'fail');
  failNode(state, tx, node, requireReason(reason, 'Failing a node'));
}

export function retry(state: GraphState, tx: Tx, nodeId: string, extraAttempts: number): void {
  const node = state.nodes.get(nodeId) as Node;
  requireStatus(node, ['failed', 'needs_input'], 'retry');
  if (node.kind !== 'task')
    throw invalid(`Only tasks can be retried; '${node.key}' is a ${node.kind}.`);
  if (!Number.isInteger(extraAttempts) || extraAttempts < 1) {
    throw new EngineError('BAD_REQUEST', 'extraAttempts must be an integer ≥ 1.', undefined, 400);
  }
  node.grantedAttempts += extraAttempts;
  tx.touch('node', node);
  tx.emit('node.attempts_granted', state.graph.id, 'node', node.id, {
    key: node.key,
    extraAttempts,
    grantedAttempts: node.grantedAttempts,
  });
  dismissRequests(state, tx, (r) => r.nodeId === node.id && r.blocking, 'retry granted');
  setNodeStatus(state, tx, node, 'ready', `retry granted (+${extraAttempts})`);
}

/** Admin: reset a finished node and cascade to started descendants (§3.3 Reopening). */
export function reopenNode(state: GraphState, tx: Tx, nodeId: string, reason = 'reopened'): void {
  const node = state.nodes.get(nodeId) as Node;
  requireStatus(node, ['done', 'skipped', 'failed'], 'reopen');
  const g = state.graph;
  if (g.status === 'completed' || g.status === 'failed' || g.status === 'verifying') {
    reopenGraph(state, tx, `node '${node.key}' reopened`);
  }
  newActivation(state, tx, node, reason);
  const reset = new Set([node.id]);
  for (const d of requiresDescendants(state, node.id)) {
    if (d.status === 'pending' || d.status === 'skipped' || d.status === 'cancelled') continue;
    if (d.status === 'ready') setNodeStatus(state, tx, d, 'pending', 'upstream reopened');
    else newActivation(state, tx, d, 'upstream reopened');
    reset.add(d.id);
  }
  for (const loop of state.loops) {
    if (loop.status === 'satisfied' && loop.body.some((id) => reset.has(id))) {
      loop.status = 'active';
      loop.updatedAt = tx.ctx.now;
      tx.touch('loop', loop);
    }
  }
}

export function completeManually(
  state: GraphState,
  tx: Tx,
  input: {
    nodeId: string;
    summary: string;
    evidence?: Evidence[];
    evaluations?: SubmitEvaluation[];
  },
) {
  const node = state.nodes.get(input.nodeId) as Node;
  requireStatus(
    node,
    ['pending', 'ready', 'needs_input', 'blocked', 'failed'],
    'complete manually',
  );
  if (!prerequisitesSatisfied(state, node)) {
    throw invalid(
      `'${node.key}' has unfinished prerequisites.`,
      'Complete or skip its prerequisites first (manually if needed).',
    );
  }
  for (const ev of input.evaluations ?? []) {
    const aim = aimsOf(state, 'node', node.id).find((a) => a.key === ev.aim);
    if (!aim)
      throw new EngineError('BAD_REQUEST', `Aim '${ev.aim}' does not exist.`, undefined, 400);
    if (aim.terminating && ev.verdict !== 'met') {
      throw new EngineError(
        'BAD_REQUEST',
        `Manual completion needs terminating aims met or waived; '${aim.key}' is ${ev.verdict}.`,
        'Omit the verdict to waive it with your summary as justification, or fail the node instead.',
        400,
      );
    }
  }
  if (!input.summary?.trim())
    throw new EngineError('BAD_REQUEST', 'A summary is required.', undefined, 400);
  const attempt = manualAttempt(state, tx, node, input);
  completeNode(state, tx, node, { manual: true, reason: 'completed manually' });
  return { node, attempt };
}

// ─── Aims ─────────────────────────────────────────────────────────────────────

/** Waive a node or graph aim with a justification (an evented, audited decision). */
export function waiveAim(state: GraphState, tx: Tx, aim: Aim, justification: string): void {
  requireReason(justification, 'A waiver');
  if (aim.ownerType === 'orchestrator') throw invalid('Orchestrator aims are informational.');
  const node = aim.ownerType === 'node' ? state.nodes.get(aim.ownerId) : undefined;
  const attempt = node ? openAttempt(state, node.id) : undefined;
  recordEvaluation(state, tx, {
    aim,
    verdict: 'waived',
    activation: node ? node.activation : state.graph.revision,
    rationale: justification,
    evaluatorKind: tx.ctx.actor.kind === 'human' ? 'human' : 'orchestrator',
  });
  dismissRequests(state, tx, (r) => r.aimId === aim.id && r.subject === 'aim', 'aim waived');
  if (node && attempt?.status === 'submitted') decideAttempt(state, tx, attempt);
  else if (node) afterVerdict(state, tx, aim.id);
}

/** A verdict on a graph aim during verification (orchestrator with `evaluate`, or a human). */
export function evaluateGraphAim(
  state: GraphState,
  tx: Tx,
  input: {
    aim: string;
    verdict: Exclude<Verdict, 'waived'>;
    rationale?: string;
    evidence?: Evidence[];
  },
) {
  if (state.graph.status !== 'verifying') {
    throw invalid('Graph aims are judged during verifying.', 'They are displayed live until then.');
  }
  const aim = aimByKey(state, 'graph', state.graph.id, input.aim);
  if (aim.kind !== 'qualitative')
    throw invalid(`Aim '${aim.key}' is quantitative; report its metric.`);
  recordEvaluation(state, tx, {
    aim,
    verdict: input.verdict,
    activation: state.graph.revision,
    evaluatorKind: tx.ctx.actor.kind === 'human' ? 'human' : 'orchestrator',
    ...(input.rationale ? { rationale: input.rationale } : {}),
    ...(input.evidence ? { evidence: input.evidence } : {}),
  });
  dismissRequests(state, tx, (r) => r.aimId === aim.id && r.subject === 'aim', 'aim judged');
  return aim;
}

// ─── Gates and loops ──────────────────────────────────────────────────────────

export function decideGate(
  state: GraphState,
  tx: Tx,
  node: Node,
  approve: boolean,
  comment?: string,
  evidence?: Evidence[],
): void {
  if (node.kind !== 'gate' || node.status !== 'needs_input') {
    throw invalid(`'${node.key}' is not a gate awaiting approval.`);
  }
  const aim = aimsOf(state, 'node', node.id).find((a) => a.implicit) as Aim;
  if (!approve) requireReason(comment, 'Rejecting a gate');
  recordEvaluation(state, tx, {
    aim,
    verdict: approve ? 'met' : 'unmet',
    activation: node.activation,
    evaluatorKind: tx.ctx.actor.kind === 'human' ? 'human' : 'orchestrator',
    ...(comment ? { rationale: comment } : {}),
    ...(evidence ? { evidence } : {}),
  });
  dismissRequests(
    state,
    tx,
    (r) => r.nodeId === node.id && r.subject === 'gate',
    approve ? 'approved' : 'rejected',
  );
  if (approve) {
    completeNode(state, tx, node, { reason: 'approved' });
    return;
  }
  const loop = loopTriggeredBy(state, node.id);
  if (!loop) {
    failNode(state, tx, node, `rejected: ${comment}`);
    return;
  }
  const feedback: FeedbackPacket = {
    source: 'gate',
    loopKey: loop.key,
    iteration: loop.iteration,
    ...(comment ? { comment } : {}),
  };
  if (loop.iteration < loop.maxIterations + loop.grantedIterations)
    fireLoop(state, tx, loop, feedback);
  else {
    loop.lastFeedback = feedback;
    exhaustLoop(state, tx, loop, node, `gate rejected on final iteration ${loop.iteration}`);
  }
}

/** Grant iterations; an exhausted loop fires immediately with its latest feedback. */
export function extendLoop(
  state: GraphState,
  tx: Tx,
  loopKey: string,
  extraIterations: number,
  reason?: string,
): void {
  const loop = loopByKey(state, loopKey);
  if (!Number.isInteger(extraIterations) || extraIterations < 1) {
    throw new EngineError('BAD_REQUEST', 'extraIterations must be an integer ≥ 1.', undefined, 400);
  }
  loop.grantedIterations += extraIterations;
  loop.updatedAt = tx.ctx.now;
  tx.touch('loop', loop);
  tx.emit('loop.extended', state.graph.id, 'loop', loop.id, {
    key: loop.key,
    extraIterations,
    grantedIterations: loop.grantedIterations,
    reason,
  });
  if (loop.status === 'exhausted') {
    dismissRequests(state, tx, (r) => r.loopId === loop.id, 'loop extended');
    fireLoop(state, tx, loop, loop.lastFeedback ?? { source: 'loop', loopKey: loop.key });
  }
}

// ─── Configuration patches ────────────────────────────────────────────────────

const PATCHABLE = [
  'title',
  'aim',
  'purpose',
  'prompt',
  'context',
  'deliverables',
  'checklist',
  'executor',
  'priority',
  'tags',
  'maxAttempts',
  'onExhausted',
  'leaseTtlSec',
  'timeoutSec',
  'metadata',
  'position',
] as const;
export type NodePatch = Partial<Pick<Node, (typeof PATCHABLE)[number]>>;

/** Patch node configuration (never aims: those are protected). Emits a diff and a `change` directive. */
export function patchNode(
  state: GraphState,
  tx: Tx,
  node: Node,
  patch: Record<string, unknown>,
): void {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(patch)) {
    if (!(PATCHABLE as readonly string[]).includes(field)) {
      throw new EngineError(
        'BAD_REQUEST',
        `Field '${field}' cannot be patched here.`,
        field === 'aims'
          ? 'Aims are protected: an admin edits them through the node endpoint.'
          : `Patchable: ${PATCHABLE.join(', ')}.`,
        400,
      );
    }
    before[field] = (node as Record<string, unknown>)[field];
    after[field] = value;
    (node as Record<string, unknown>)[field] = value;
  }
  node.version += 1;
  node.updatedAt = tx.ctx.now;
  tx.touch('node', node);
  tx.emit('node.updated', state.graph.id, 'node', node.id, { key: node.key, before, after });
  const attempt = openAttempt(state, node.id);
  if (attempt?.status === 'running') {
    createDirective(state, tx, {
      targetType: 'node',
      targetId: node.id,
      kind: 'change',
      title: `Configuration changed: ${Object.keys(after).join(', ')}`,
      data: { before, after },
      requiresAck: true,
    });
  }
}

// ─── Request resolution (§11.1) ───────────────────────────────────────────────

export type Resolution = { choice: string; comment?: string; data?: Record<string, unknown> };

function dataNumber(
  data: Record<string, unknown> | undefined,
  key: string,
  fallback?: number,
): number {
  const v = data?.[key] ?? fallback;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new EngineError('BAD_REQUEST', `data.${key} must be a number.`, undefined, 400);
  }
  return v;
}

function dataString(
  data: Record<string, unknown> | undefined,
  key: string,
  fallback?: string,
): string {
  const v = data?.[key] ?? fallback;
  if (typeof v !== 'string' || !v.trim()) {
    throw new EngineError('BAD_REQUEST', `data.${key} is required.`, undefined, 400);
  }
  return v;
}

export function resolveRequest(
  state: GraphState,
  tx: Tx,
  requestId: string,
  resolution: Resolution,
) {
  const request = state.requests.get(requestId);
  if (!request)
    throw new EngineError('NOT_FOUND', `Request ${requestId} not found.`, undefined, 404);
  if (request.status !== 'open') throw invalid(`Request is ${request.status}.`);
  const valid = request.options.map((o) => o.id);
  if (!valid.includes(resolution.choice)) {
    throw new EngineError(
      'BAD_REQUEST',
      `Unknown choice '${resolution.choice}'.`,
      `Options: ${valid.join(', ')}.`,
      400,
    );
  }
  // Mark resolved first so effects that dismiss related requests skip this one; restore it if
  // the resolution is refused (the caller discards the rest of the state on any throw).
  const before = { ...request };
  request.status = 'resolved';
  try {
    applyResolution(state, tx, request, resolution);
  } catch (error) {
    Object.assign(request, before);
    throw error;
  }
  request.resolution = {
    choice: resolution.choice,
    ...(resolution.comment ? { comment: resolution.comment } : {}),
    ...(resolution.data ? { data: resolution.data } : {}),
  };
  request.resolvedBy = tx.ctx.actor;
  request.resolvedAt = tx.ctx.now;
  tx.touch('request', request);
  tx.emit('request.resolved', state.graph.id, 'request', request.id, {
    subject: request.subject,
    choice: resolution.choice,
    comment: resolution.comment,
  });
  return request;
}

function applyResolution(state: GraphState, tx: Tx, r: HumanRequest, res: Resolution): void {
  const { choice, comment, data } = res;
  const node = r.nodeId ? (state.nodes.get(r.nodeId) as Node) : undefined;
  const need = (): Node => {
    if (!node) throw new EngineError('BAD_REQUEST', 'This request has no node.', undefined, 400);
    return node;
  };
  const humanOnly = (what: string) => {
    if (tx.ctx.actor.kind !== 'human') {
      throw new EngineError(
        'POLICY_DENIED',
        `${what} is human-only (protected field).`,
        undefined,
        403,
      );
    }
  };
  switch (r.subject) {
    case 'gate':
      decideGate(state, tx, need(), choice === 'approve', comment);
      return;
    case 'aim': {
      const aim = state.aims.get(r.aimId as string) as Aim;
      if (choice === 'reject') requireReason(comment, 'Rejecting');
      const verdict: Verdict =
        choice === 'approve' ? ((data?.verdict as Verdict) ?? 'met') : 'unmet';
      if (aim.ownerType === 'graph') {
        evaluateGraphAim(state, tx, {
          aim: aim.key,
          verdict: verdict as 'met',
          ...(comment ? { rationale: comment } : {}),
        });
        return;
      }
      const attempt = r.attemptId ? state.attempts.get(r.attemptId) : undefined;
      recordEvaluation(state, tx, {
        aim,
        verdict,
        activation: attempt?.activation ?? need().activation,
        evaluatorKind: 'human',
        ...(attempt ? { attemptId: attempt.id } : {}),
        ...(comment ? { rationale: comment } : {}),
      });
      afterVerdict(state, tx, aim.id, attempt?.id);
      return;
    }
    case 'plan':
      if (choice === 'approve') {
        state.graph.pendingApproval = false;
        setGraphStatus(state, tx, 'active', 'graph.started', { approvedBy: tx.ctx.actor });
      } else {
        state.graph.pendingApproval = false;
        touchGraph(state, tx);
        if (comment) {
          createDirective(state, tx, {
            targetType: 'graph',
            targetId: state.graph.id,
            kind: 'guidance',
            title: 'Plan rejected',
            body: comment,
          });
        }
      }
      return;
    case 'proposal':
      throw new EngineError('NOT_IMPLEMENTED', 'Proposals arrive in M5.', undefined, 501);
    case 'question': {
      const text = dataString(data, 'text', comment);
      const attempt = r.attemptId ? state.attempts.get(r.attemptId) : undefined;
      const open = attempt && (attempt.status === 'running' || attempt.status === 'submitted');
      createDirective(state, tx, {
        targetType: open ? 'attempt' : node ? 'node' : 'graph',
        targetId: open ? (attempt?.id as string) : (node?.id ?? state.graph.id),
        kind: 'answer',
        title: `Answer: ${r.title}`,
        body: text,
        requestId: r.id,
        ...(data?.choice !== undefined ? { data: { choice: data.choice } } : {}),
      });
      return;
    }
    case 'exhaustion': {
      const n = need();
      if (choice === 'retry') retry(state, tx, n.id, dataNumber(data, 'extraAttempts'));
      else if (choice === 'accept') {
        completeNode(state, tx, n, {
          acceptedWithDeviation: true,
          reason: `accepted: ${dataString(data, 'justification', comment)}`,
        });
      } else if (choice === 'skip') skipNode(state, tx, n, dataString(data, 'reason', comment));
      else if (choice === 'fail') failNode(state, tx, n, dataString(data, 'reason', comment));
      else if (choice === 'edit_retry') {
        patchNode(state, tx, n, (data?.patch as Record<string, unknown>) ?? {});
        retry(state, tx, n.id, dataNumber(data, 'extraAttempts', 1));
      }
      return;
    }
    case 'loop': {
      const loop = state.loops.find((l) => l.id === r.loopId);
      if (!loop) throw new EngineError('BAD_REQUEST', 'This request has no loop.', undefined, 400);
      const trigger = state.nodes.get(loop.fromNodeId) as Node;
      if (choice === 'extend')
        extendLoop(state, tx, loop.key, dataNumber(data, 'extraIterations'), comment);
      else if (choice === 'accept') {
        completeNode(state, tx, trigger, {
          acceptedWithDeviation: true,
          reason: `accepted: ${comment ?? 'loop exhausted'}`,
        });
      } else if (choice === 'fail') failNode(state, tx, trigger, comment ?? 'loop exhausted');
      else if (choice === 'edit_retry') {
        const target =
          typeof data?.nodeKey === 'string'
            ? nodeByKey(state, data.nodeKey)
            : (state.nodes.get(loop.toNodeId) as Node);
        patchNode(state, tx, target, (data?.patch as Record<string, unknown>) ?? {});
        extendLoop(state, tx, loop.key, dataNumber(data, 'extraIterations', 1), comment);
      }
      return;
    }
    case 'guard': {
      const aim = state.aims.get(r.aimId as string) as Aim;
      if (choice === 'raise_target') {
        humanOnly('raise_target');
        const target = dataNumber(data, 'target');
        const before = aim.target;
        aim.target = target;
        aim.status = 'pending';
        aim.version += 1;
        aim.updatedAt = tx.ctx.now;
        tx.touch('aim', aim);
        tx.emit('aim.updated', state.graph.id, 'aim', aim.id, {
          key: aim.key,
          before: { target: before },
          after: { target },
        });
      } else if (choice === 'waive') {
        recordEvaluation(state, tx, {
          aim,
          verdict: 'waived',
          activation: state.graph.revision,
          rationale: dataString(data, 'justification', comment),
          evaluatorKind: tx.ctx.actor.kind === 'human' ? 'human' : 'orchestrator',
        });
      } else {
        failGraph(state, tx, comment ?? `guard '${aim.key}' violated`);
        return;
      }
      if (state.graph.status === 'paused') resume(state, tx);
      return;
    }
    case 'stall': {
      if (choice === 'fail_graph') {
        failGraph(state, tx, comment ?? 'stalled');
        return;
      }
      const target = typeof data?.nodeKey === 'string' ? nodeByKey(state, data.nodeKey) : need();
      if (choice === 'retry') retry(state, tx, target.id, dataNumber(data, 'extraAttempts', 1));
      else if (choice === 'skip') skip(state, tx, target.id, dataString(data, 'reason', comment));
      else failNodeAction(state, tx, target.id, dataString(data, 'reason', comment));
      return;
    }
    case 'verification':
      if (choice === 'add_work') reopenGraph(state, tx, comment);
      else if (choice === 'waive') {
        const aim = aimByKey(state, 'graph', state.graph.id, dataString(data, 'aimKey'));
        recordEvaluation(state, tx, {
          aim,
          verdict: 'waived',
          activation: state.graph.revision,
          rationale: dataString(data, 'justification', comment),
          evaluatorKind: tx.ctx.actor.kind === 'human' ? 'human' : 'orchestrator',
        });
      } else if (choice === 'accept') {
        state.graph.acceptedWithDeviation = true;
        setGraphStatus(state, tx, 'completed', 'graph.completed', {
          acceptedWithDeviation: true,
          justification: dataString(data, 'justification', comment),
        });
      } else failGraph(state, tx, comment ?? 'verification failed');
      return;
    case 'timeout': {
      const attempt = state.attempts.get(r.attemptId as string);
      if (attempt?.status !== 'running') return;
      if (choice === 'extend') {
        const n = need();
        const seconds = durationToSeconds(data?.duration as string | number);
        n.timeoutSec = (n.timeoutSec ?? 0) + seconds;
        attempt.timeoutEscalated = false;
        tx.touch('node', n);
        tx.touch('attempt', attempt);
        tx.emit('node.updated', state.graph.id, 'node', n.id, {
          key: n.key,
          after: { timeoutSec: n.timeoutSec },
        });
      } else if (choice === 'fail_attempt') {
        failAttemptInternal(state, tx, attempt.id, comment ?? 'timeout');
      }
      return;
    }
    case 'milestone': {
      const n = need();
      if (choice === 'waive') {
        waiveAim(
          state,
          tx,
          aimByKey(state, 'node', n.id, dataString(data, 'aimKey')),
          dataString(data, 'justification', comment),
        );
        reevaluateMilestone(state, tx, n);
      } else if (choice === 'add_work') setNodeStatus(state, tx, n, 'pending', 'add work');
      else failNode(state, tx, n, comment ?? 'milestone aims unmet');
      return;
    }
    case 'blocker': {
      const n = need();
      if (choice === 'unblock') {
        createDirective(state, tx, {
          targetType: 'node',
          targetId: n.id,
          kind: 'answer',
          title: `Unblocked: ${r.title}`,
          body: dataString(data, 'info', comment),
          requestId: r.id,
        });
        if (n.status === 'blocked') setNodeStatus(state, tx, n, 'ready', 'unblocked');
      } else if (choice === 'skip') skipNode(state, tx, n, dataString(data, 'reason', comment));
      else failNode(state, tx, n, dataString(data, 'reason', comment));
      return;
    }
  }
}

function failAttemptInternal(state: GraphState, tx: Tx, attemptId: string, reason: string): void {
  const attempt = state.attempts.get(attemptId);
  if (attempt?.status !== 'running') return;
  const node = state.nodes.get(attempt.nodeId) as Node;
  endAttempt(state, tx, attempt, 'errored', { reason, counted: true });
  applyFailure(state, tx, node, attempt);
}
