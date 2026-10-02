/**
 * Node, loop, and graph transitions (docs/concepts.md §2.1, §3.3, §7). Commands call these and
 * finish with `settle()`, which recomputes readiness to a fixpoint and runs graph-level checks.
 */
import { lessonDutyFailures } from '../evolution/duties';
import type { AttemptStatus, ExhaustionPolicy, NodeStatus } from '../vocabulary';
import {
  activationVerdicts,
  aimValue,
  attemptVerdicts,
  decide,
  describeTarget,
  quantitativeVerdict,
} from './aims';
import {
  createDirective,
  createNote,
  dismissRequests,
  openRequest,
  recordEvaluation,
} from './requests';
import {
  aimsOf,
  attemptsOf,
  graphAims,
  isTerminal,
  loopTriggeredBy,
  openAttempt,
  openRequestsFor,
  prerequisitesSatisfied,
  requiresSuccessors,
} from './state';
import type { Attempt, FeedbackPacket, GraphState, Loop, Node, Tx } from './types';

export function touchGraph(state: GraphState, tx: Tx): void {
  state.graph.updatedAt = tx.ctx.now;
  state.graph.lastActivityAt = tx.ctx.now;
  tx.touch('graph', state.graph);
}

export function setNodeStatus(
  state: GraphState,
  tx: Tx,
  node: Node,
  to: NodeStatus,
  reason?: string,
): void {
  const from = node.status;
  if (from === to && reason === node.statusReason) return;
  node.status = to;
  if (reason !== undefined) node.statusReason = reason;
  else delete node.statusReason;
  node.updatedAt = tx.ctx.now;
  if (to === 'ready') node.readyAt = tx.ctx.now;
  if (to === 'running' && node.startedAt === undefined) node.startedAt = tx.ctx.now;
  if (isTerminal(to)) node.completedAt = tx.ctx.now;
  else delete node.completedAt;
  if (to !== 'running' && to !== 'evaluating' && to !== 'paused') delete node.currentAttemptId;
  tx.touch('node', node);
  tx.emit('node.status_changed', state.graph.id, 'node', node.id, {
    key: node.key,
    from,
    to,
    reason,
  });
  touchGraph(state, tx);
}

export function setGraphStatus(
  state: GraphState,
  tx: Tx,
  to: GraphState['graph']['status'],
  event: string,
  payload: Record<string, unknown> = {},
): void {
  const g = state.graph;
  const from = g.status;
  g.status = to;
  if (to === 'active' && g.startedAt === undefined) g.startedAt = tx.ctx.now;
  if (to === 'completed' || to === 'failed' || to === 'cancelled') g.completedAt = tx.ctx.now;
  else delete g.completedAt;
  touchGraph(state, tx);
  tx.emit(event, g.id, 'graph', g.id, { from, to, ...payload });
}

/** End an attempt with a final status. The lease always ends here. */
export function endAttempt(
  state: GraphState,
  tx: Tx,
  attempt: Attempt,
  status: AttemptStatus,
  options: { reason?: string; counted?: boolean } = {},
): void {
  attempt.status = status;
  if (status === 'passed') attempt.passedAt = tx.ctx.now;
  attempt.counted = options.counted ?? false;
  if (options.reason !== undefined) attempt.outcomeReason = options.reason;
  delete attempt.leaseExpiresAt;
  attempt.endedAt = tx.ctx.now;
  tx.touch('attempt', attempt);
  tx.emit(`attempt.${status}`, state.graph.id, 'attempt', attempt.id, {
    nodeId: attempt.nodeId,
    number: attempt.number,
    reason: options.reason,
    counted: attempt.counted,
  });
  const node = state.nodes.get(attempt.nodeId);
  if (node && attempt.counted) {
    node.countedAttempts += 1;
    tx.touch('node', node);
  }
  dismissRequests(
    state,
    tx,
    (r) => r.attemptId === attempt.id && (r.subject === 'aim' || r.subject === 'timeout'),
    `attempt ${status}`,
  );
}

/** Close an open attempt because its node was skipped, failed, or reset, or the graph ended. */
export function closeOpenAttempt(
  state: GraphState,
  tx: Tx,
  node: Node,
  status: 'cancelled' | 'superseded',
  reason: string,
): void {
  const attempt = openAttempt(state, node.id);
  if (attempt) endAttempt(state, tx, attempt, status, { reason });
}

function resetNodeAims(state: GraphState, tx: Tx, node: Node): void {
  for (const aim of aimsOf(state, 'node', node.id)) {
    if (aim.status === 'pending' && aim.currentValue === undefined) continue;
    aim.status = 'pending';
    delete aim.currentValue;
    aim.updatedAt = tx.ctx.now;
    tx.touch('aim', aim);
  }
}

/** Start a new activation (loop reset or reopen): fresh budget, pending aims. */
export function newActivation(
  state: GraphState,
  tx: Tx,
  node: Node,
  reason: string,
  feedback?: FeedbackPacket,
): void {
  closeOpenAttempt(state, tx, node, 'superseded', reason);
  for (const a of attemptsOf(state, node.id, node.activation)) {
    if (a.status === 'passed') endAttempt(state, tx, a, 'superseded', { reason });
  }
  node.activation += 1;
  node.countedAttempts = 0;
  node.grantedAttempts = 0;
  node.acceptedWithDeviation = false;
  node.manual = false;
  delete node.deferredFailure;
  if (feedback) node.feedback = feedback;
  resetNodeAims(state, tx, node);
  dismissRequests(state, tx, (r) => r.nodeId === node.id, reason);
  tx.emit('node.reset', state.graph.id, 'node', node.id, {
    key: node.key,
    activation: node.activation,
    reason,
  });
  setNodeStatus(state, tx, node, 'pending', reason);
}

/** Mark a node done (aims satisfied, approved, accepted, or manual). */
export function completeNode(
  state: GraphState,
  tx: Tx,
  node: Node,
  options: { acceptedWithDeviation?: boolean; manual?: boolean; reason?: string } = {},
): void {
  if (options.acceptedWithDeviation) node.acceptedWithDeviation = true;
  if (options.manual) node.manual = true;
  delete node.feedback;
  delete node.deferredFailure;
  dismissRequests(state, tx, (r) => r.nodeId === node.id && r.blocking, 'node done');
  setNodeStatus(state, tx, node, 'done', options.reason);
  const loop = loopTriggeredBy(state, node.id);
  if (loop && loop.status !== 'satisfied') {
    loop.status = 'satisfied';
    loop.updatedAt = tx.ctx.now;
    tx.touch('loop', loop);
    tx.emit('loop.satisfied', state.graph.id, 'loop', loop.id, {
      key: loop.key,
      iteration: loop.iteration,
    });
  }
}

/** Terminal failure of a node (exhaustion with `fail`, a decision, or a rejected gate). */
export function failNode(state: GraphState, tx: Tx, node: Node, reason: string): void {
  closeOpenAttempt(state, tx, node, 'cancelled', reason);
  dismissRequests(state, tx, (r) => r.nodeId === node.id && r.blocking, 'node failed');
  setNodeStatus(state, tx, node, 'failed', reason);
  if (state.graph.policy.failFast && state.graph.status === 'active') {
    failGraph(state, tx, `failFast: node '${node.key}' failed`);
  }
}

export function skipNode(state: GraphState, tx: Tx, node: Node, reason: string): void {
  closeOpenAttempt(state, tx, node, 'cancelled', reason);
  dismissRequests(state, tx, (r) => r.nodeId === node.id && r.blocking, 'node skipped');
  createNote(state, tx, {
    type: 'decision',
    title: `Skipped ${node.key}`,
    body: reason,
    nodeId: node.id,
  });
  setNodeStatus(state, tx, node, 'skipped', reason);
}

/** Apply an exhaustion policy to a node (§7.4, node column). */
export function exhaustNode(state: GraphState, tx: Tx, node: Node, reason: string): void {
  applyExhaustion(state, tx, node, node.onExhausted, reason, undefined);
}

function applyExhaustion(
  state: GraphState,
  tx: Tx,
  node: Node,
  policy: ExhaustionPolicy,
  reason: string,
  loop: Loop | undefined,
): void {
  switch (policy) {
    case 'escalate': {
      setNodeStatus(state, tx, node, 'needs_input', reason);
      const limit = loop
        ? `${loop.maxIterations + loop.grantedIterations} iterations of loop '${loop.key}'`
        : `${node.maxAttempts + node.grantedAttempts} attempts`;
      openRequest(state, tx, {
        kind: 'escalation',
        subject: loop ? 'loop' : 'exhaustion',
        title: `${node.title}: exhausted ${limit}`,
        body: reason,
        nodeId: node.id,
        ...(loop ? { loopId: loop.id } : {}),
      });
      break;
    }
    case 'fail':
      failNode(state, tx, node, reason);
      break;
    case 'skip':
      skipNode(state, tx, node, `exhausted: ${reason}`);
      break;
    case 'accept':
      completeNode(state, tx, node, { acceptedWithDeviation: true, reason: `accepted: ${reason}` });
      break;
  }
}

export function exhaustLoop(state: GraphState, tx: Tx, loop: Loop, trigger: Node, reason: string) {
  loop.status = 'exhausted';
  loop.updatedAt = tx.ctx.now;
  tx.touch('loop', loop);
  tx.emit('loop.exhausted', state.graph.id, 'loop', loop.id, {
    key: loop.key,
    iteration: loop.iteration,
  });
  applyExhaustion(state, tx, trigger, loop.onExhausted, reason, loop);
}

/** Fire a loop (§7.2 Firing): reset its body and nested loops in this transaction. */
export function fireLoop(state: GraphState, tx: Tx, loop: Loop, feedback: FeedbackPacket): void {
  const failedIteration = loop.iteration;
  loop.iteration += 1;
  loop.status = 'active';
  loop.lastFeedback = feedback;
  loop.updatedAt = tx.ctx.now;
  tx.touch('loop', loop);
  const body = new Set(loop.body);
  for (const inner of state.loops) {
    if (inner.id === loop.id || !inner.body.every((id) => body.has(id))) continue;
    inner.iteration = 1;
    inner.grantedIterations = 0;
    inner.status = 'idle';
    delete inner.lastFeedback;
    inner.updatedAt = tx.ctx.now;
    tx.touch('loop', inner);
  }
  const reason = `loop '${loop.key}' iteration ${loop.iteration}`;
  for (const id of loop.body) {
    const node = state.nodes.get(id);
    if (!node || node.status === 'skipped') continue;
    if (node.status === 'pending' && node.id !== loop.fromNodeId) continue;
    newActivation(state, tx, node, reason, feedback);
  }
  tx.emit('loop.iterated', state.graph.id, 'loop', loop.id, {
    key: loop.key,
    from: failedIteration,
    iteration: loop.iteration,
    max: loop.maxIterations + loop.grantedIterations,
  });
}

/** Loop feedback for a failed task trigger (unmet aims, values, rationales, summary). */
export function attemptFeedback(state: GraphState, attempt: Attempt): FeedbackPacket {
  const verdicts = attemptVerdicts(state, attempt);
  const unmetAims: NonNullable<FeedbackPacket['unmetAims']> = [];
  for (const aim of aimsOf(state, 'node', attempt.nodeId)) {
    const v = verdicts.get(aim.id);
    if (v !== 'unmet' && v !== 'partial') continue;
    const ev = [...state.evaluations]
      .reverse()
      .find((e) => e.aimId === aim.id && e.attemptId === attempt.id);
    unmetAims.push({
      key: aim.key,
      title: aim.metric ? describeTarget(aim) : aim.title,
      ...(ev?.value !== undefined ? { value: ev.value } : {}),
      ...(aim.target !== undefined ? { target: aim.target } : {}),
      ...(ev?.rationale ? { rationale: ev.rationale } : {}),
    });
  }
  const packet: FeedbackPacket = {
    source: 'attempt',
    attemptId: attempt.id,
    outcome: attempt.status,
    unmetAims,
  };
  if (attempt.summary !== undefined) packet.summary = attempt.summary;
  if (attempt.outcomeReason !== undefined) packet.reason = attempt.outcomeReason;
  if (attempt.checkpoint !== undefined) packet.checkpoint = attempt.checkpoint;
  return packet;
}

/**
 * After an attempt ends (failed, errored, abandoned), apply the first matching rule of §7.1.
 * A failure while the node is paused is deferred until resume.
 */
export function applyFailure(
  state: GraphState,
  tx: Tx,
  node: Node,
  attempt: Attempt,
  options: { nonRetryable?: boolean; resumed?: boolean } = {},
): void {
  if (node.status === 'paused' && !options.resumed) {
    node.deferredFailure = { attemptId: attempt.id, outcome: attempt.status };
    tx.touch('node', node);
    return;
  }
  const feedback = attemptFeedback(state, attempt);
  const loop = loopTriggeredBy(state, node.id);
  if (attempt.status === 'failed' && loop) {
    const loopFeedback: FeedbackPacket = {
      ...feedback,
      source: 'loop',
      loopKey: loop.key,
      iteration: loop.iteration,
    };
    if (loop.iteration < loop.maxIterations + loop.grantedIterations) {
      fireLoop(state, tx, loop, loopFeedback);
    } else {
      loop.lastFeedback = loopFeedback;
      exhaustLoop(state, tx, loop, node, `trigger aims unmet on final iteration ${loop.iteration}`);
    }
    return;
  }
  if (!attempt.counted) {
    setNodeStatus(state, tx, node, 'ready', attempt.outcomeReason);
    return;
  }
  node.feedback = feedback;
  tx.touch('node', node);
  if (options.nonRetryable) {
    exhaustNode(
      state,
      tx,
      node,
      `not retryable: ${attempt.outcomeReason ?? 'impossible as specified'}`,
    );
  } else if (node.countedAttempts < node.maxAttempts + node.grantedAttempts) {
    setNodeStatus(state, tx, node, 'ready', `retry after ${attempt.status} attempt`);
  } else {
    exhaustNode(
      state,
      tx,
      node,
      `${node.countedAttempts} counted attempts used (last: ${attempt.status})`,
    );
  }
}

/** Decide a submitted attempt once verdicts change; finalize when decided. */
export function decideAttempt(
  state: GraphState,
  tx: Tx,
  attempt: Attempt,
): 'passed' | 'failed' | 'evaluating' {
  const node = state.nodes.get(attempt.nodeId) as Node;
  const terminating = aimsOf(state, 'node', node.id).filter((a) => a.terminating);
  const decision = decide(node.aimMode, terminating, attemptVerdicts(state, attempt));
  if (decision === 'pending') return 'evaluating';
  if (decision === 'satisfied') {
    endAttempt(state, tx, attempt, 'passed');
    completeNode(state, tx, node);
    maybeLessonDuty(state, tx, node, attempt);
    return 'passed';
  }
  const loop = loopTriggeredBy(state, node.id);
  endAttempt(state, tx, attempt, 'failed', {
    counted: !loop,
    reason: 'terminating aims unmet',
  });
  applyFailure(state, tx, node, attempt);
  return 'failed';
}

/** In learn mode and above, passing after counted failures opens a lesson duty (§16). */
function maybeLessonDuty(state: GraphState, tx: Tx, node: Node, passed: Attempt): void {
  const failed = lessonDutyFailures(state, node.id, passed.id);
  if (failed.length === 0) return;
  const duty = {
    id: tx.ctx.id('ld'),
    graphId: state.graph.id,
    nodeId: node.id,
    passedAttemptId: passed.id,
    failedAttemptIds: failed,
    status: 'open' as const,
    assignee: 'worker' as const,
    createdAt: tx.ctx.now,
  };
  state.lessonDuties.set(duty.id, tx.touch('lessonDuty', duty));
  tx.emit('lesson.duty_created', state.graph.id, 'lessonDuty', duty.id, {
    nodeId: node.id,
    passedAttemptId: passed.id,
    failedAttemptIds: duty.failedAttemptIds,
  });
}

/** Evaluate a milestone's (or group's) aims without an attempt. */
function evaluateMilestone(state: GraphState, tx: Tx, node: Node): void {
  const aims = aimsOf(state, 'node', node.id);
  if (node.kind === 'group') {
    const children = [...state.nodes.values()].filter((n) => n.parentId === node.id);
    if (!children.every((c) => c.status === 'done' || c.status === 'skipped')) return;
  }
  for (const aim of aims) {
    if (activationVerdicts(state, node).has(aim.id)) continue;
    if (aim.kind === 'quantitative') {
      const value = aimValue(state, aim);
      const verdict = quantitativeVerdict(aim, value);
      if (verdict) {
        recordEvaluation(state, tx, {
          aim,
          verdict,
          activation: node.activation,
          value: value as number,
          evaluatorKind: 'system',
        });
      }
    } else if (
      !openRequestsFor(state, node.id).some((r) => r.aimId === aim.id && r.subject === 'aim')
    ) {
      const assignee = aim.evaluator === 'orchestrator' ? 'orchestrator' : 'human';
      openRequest(state, tx, {
        kind: 'approval',
        subject: 'aim',
        title: `${node.title}: judge "${aim.title}"`,
        nodeId: node.id,
        aimId: aim.id,
        assignee,
        ...(aim.evaluatorKey ? { assigneeKey: aim.evaluatorKey } : {}),
      });
    }
  }
  const terminating = aims.filter((a) => a.terminating);
  const decision = decide('all', terminating, activationVerdicts(state, node));
  if (decision === 'satisfied') {
    completeNode(state, tx, node);
  } else if (decision === 'unsatisfied') {
    if (node.status !== 'needs_input') {
      setNodeStatus(state, tx, node, 'needs_input', 'milestone aims unmet');
      openRequest(state, tx, {
        kind: 'escalation',
        subject: 'milestone',
        title: `${node.title}: milestone aims unmet`,
        nodeId: node.id,
      });
    }
  } else if (node.status !== 'evaluating') {
    setNodeStatus(state, tx, node, 'evaluating', 'awaiting judgment');
  }
}

/** Re-check a milestone after a verdict or waiver. */
export function reevaluateMilestone(state: GraphState, tx: Tx, node: Node): void {
  if (node.status === 'evaluating' || node.status === 'ready' || node.status === 'needs_input') {
    if (node.status === 'needs_input') {
      const terminating = aimsOf(state, 'node', node.id).filter((a) => a.terminating);
      if (decide('all', terminating, activationVerdicts(state, node)) !== 'satisfied') return;
    }
    evaluateMilestone(state, tx, node);
  }
}

function becomeReady(state: GraphState, tx: Tx, node: Node): void {
  if (node.kind === 'gate') {
    setNodeStatus(state, tx, node, 'needs_input', 'awaiting approval');
    const approval = aimsOf(state, 'node', node.id).find((a) => a.implicit);
    if (!openRequestsFor(state, node.id).some((r) => r.subject === 'gate')) {
      openRequest(state, tx, {
        kind: 'approval',
        subject: 'gate',
        title: `Approve: ${node.title}`,
        ...(node.gate?.instructions ? { body: node.gate.instructions } : {}),
        nodeId: node.id,
        ...(approval ? { aimId: approval.id } : {}),
        assignee: node.gate?.approver === 'orchestrator' ? 'orchestrator' : 'human',
        ...(node.gate?.approverKey ? { assigneeKey: node.gate.approverKey } : {}),
      });
    }
    return;
  }
  setNodeStatus(state, tx, node, 'ready');
  if (node.kind === 'milestone' || node.kind === 'group') evaluateMilestone(state, tx, node);
}

/** Promote pending nodes whose prerequisites are satisfied, to a fixpoint. */
export function recomputeReadiness(state: GraphState, tx: Tx): void {
  if (state.graph.status !== 'active') return;
  for (let changed = true; changed; ) {
    changed = false;
    for (const node of state.nodes.values()) {
      if (node.status === 'pending' && prerequisitesSatisfied(state, node)) {
        becomeReady(state, tx, node);
        changed = true;
      } else if (node.kind === 'group' && node.status === 'ready') {
        const before = node.status;
        evaluateMilestone(state, tx, node);
        changed ||= node.status !== before;
      }
    }
  }
}

/** Evaluate graph aims in `verifying` (§2.1 Verification). */
export function checkVerification(state: GraphState, tx: Tx): void {
  if (state.graph.status !== 'verifying') return;
  const terminating = graphAims(state).filter((a) => a.terminating);
  for (const aim of terminating) {
    if (aim.status !== 'pending') continue;
    if (aim.kind === 'quantitative') {
      const value = aimValue(state, aim);
      const verdict = quantitativeVerdict(aim, value);
      if (verdict) {
        recordEvaluation(state, tx, {
          aim,
          verdict,
          activation: state.graph.revision,
          value: value as number,
          evaluatorKind: 'system',
        });
      }
    } else if (
      ![...state.requests.values()].some(
        (r) => r.status === 'open' && r.aimId === aim.id && r.subject === 'aim',
      )
    ) {
      openRequest(state, tx, {
        kind: 'approval',
        subject: 'aim',
        title: `Graph aim: ${aim.title}`,
        aimId: aim.id,
        assignee: aim.evaluator === 'orchestrator' ? 'orchestrator' : 'human',
        ...(aim.evaluatorKey ? { assigneeKey: aim.evaluatorKey } : {}),
      });
    }
  }
  const statuses = terminating.map((a) => a.status);
  if (statuses.every((s) => s === 'met' || s === 'waived')) {
    dismissRequests(
      state,
      tx,
      (r) => r.nodeId === undefined && r.subject === 'aim',
      'graph completed',
    );
    setGraphStatus(state, tx, 'completed', 'graph.completed');
    return;
  }
  const decided = statuses.every((s) => s !== 'pending');
  const open = [...state.requests.values()].some(
    (r) => r.status === 'open' && r.subject === 'verification',
  );
  if (decided && !open) {
    const unmet = terminating.filter((a) => a.status === 'unmet' || a.status === 'partial');
    openRequest(state, tx, {
      kind: 'escalation',
      subject: 'verification',
      title: `Verification failed: ${unmet.map((a) => a.key).join(', ')}`,
    });
  }
}

/** Guard aims (§6.6): pause the graph and escalate when one becomes unmet. */
export function checkGuards(state: GraphState, tx: Tx): void {
  if (state.graph.status !== 'active') return;
  for (const aim of state.aims.values()) {
    if (!aim.guard || aim.kind !== 'quantitative' || aim.status === 'waived') continue;
    const value = aimValue(state, aim);
    const verdict = quantitativeVerdict(aim, value);
    if (value !== undefined && aim.currentValue !== value) {
      aim.currentValue = value;
      tx.touch('aim', aim);
    }
    if (verdict !== 'unmet') continue;
    const open = [...state.requests.values()].some(
      (r) => r.status === 'open' && r.subject === 'guard' && r.aimId === aim.id,
    );
    if (open) continue;
    aim.status = 'unmet';
    tx.touch('aim', aim);
    tx.emit('aim.guard_violated', state.graph.id, 'aim', aim.id, {
      key: aim.key,
      value,
      target: aim.target,
    });
    pauseGraph(state, tx, `guard '${aim.key}' violated`);
    openRequest(state, tx, {
      kind: 'escalation',
      subject: 'guard',
      title: `Guard violated: ${describeTarget(aim)} (now ${value})`,
      aimId: aim.id,
      ...(aim.ownerType === 'node' ? { nodeId: aim.ownerId } : {}),
    });
    return;
  }
}

/** Maintain the derived `stalled` flag (§2.1) and open a stall escalation for failed blockers. */
export function updateStall(state: GraphState, tx: Tx): void {
  const g = state.graph;
  const nodes = [...state.nodes.values()];
  const moving = nodes.some((n) => ['ready', 'running', 'evaluating'].includes(n.status));
  const escalated = (n: Node) =>
    n.status === 'needs_input' && openRequestsFor(state, n.id).some((r) => r.kind === 'escalation');
  const failedBlockers = nodes.filter(
    (n) =>
      n.status === 'failed' && requiresSuccessors(state, n.id).some((s) => s.status === 'pending'),
  );
  const stalled =
    g.status === 'active' &&
    !moving &&
    nodes.some((n) => n.status === 'blocked' || n.status === 'failed' || escalated(n));
  if (stalled !== g.stalled) {
    g.stalled = stalled;
    touchGraph(state, tx);
    tx.emit(stalled ? 'graph.stalled' : 'graph.unstalled', g.id, 'graph', g.id, {});
  }
  if (!stalled) return;
  for (const n of failedBlockers) {
    const open = [...state.requests.values()].some(
      (r) => r.status === 'open' && r.subject === 'stall' && r.nodeId === n.id,
    );
    if (!open) {
      openRequest(state, tx, {
        kind: 'escalation',
        subject: 'stall',
        title: `Stalled: '${n.key}' failed and blocks its dependents`,
        nodeId: n.id,
      });
    }
  }
}

export function pauseGraph(state: GraphState, tx: Tx, reason?: string): void {
  setGraphStatus(state, tx, 'paused', 'graph.paused', reason ? { reason } : {});
  createDirective(state, tx, {
    targetType: 'graph',
    targetId: state.graph.id,
    kind: 'pause',
    title: reason ? `Graph paused: ${reason}` : 'Graph paused',
    requiresAck: false,
  });
}

export function failGraph(state: GraphState, tx: Tx, reason: string): void {
  for (const node of state.nodes.values()) {
    closeOpenAttempt(state, tx, node, 'cancelled', `graph failed: ${reason}`);
  }
  dismissRequests(state, tx, () => true, 'graph failed');
  setGraphStatus(state, tx, 'failed', 'graph.failed', { reason });
}

const VERIFY_TRIGGERS = new Set([
  'node.status_changed',
  'node.removed',
  'graph.started',
  'graph.resumed',
]);

/** Run after every command: readiness fixpoint, verification, guards, stall. */
export function settle(state: GraphState, tx: Tx): void {
  recomputeReadiness(state, tx);
  const g = state.graph;
  // Enter verification only when work moved in this command: after `add_work` the graph stays
  // active, so nodes can be added, until something changes.
  const moved = tx.events.some((e) => VERIFY_TRIGGERS.has(e.type));
  if (g.status === 'active' && moved) {
    const all = [...state.nodes.values()];
    if (all.every((n) => n.status === 'done' || n.status === 'skipped')) {
      for (const aim of graphAims(state)) {
        if (aim.status === 'waived' || aim.status === 'pending') continue;
        aim.status = 'pending';
        tx.touch('aim', aim);
      }
      setGraphStatus(state, tx, 'verifying', 'graph.verifying');
    }
  }
  checkVerification(state, tx);
  checkGuards(state, tx);
  updateStall(state, tx);
}

/** External verdicts that make an attempt decidable also apply to milestones in evaluation. */
export function afterVerdict(state: GraphState, tx: Tx, aimId: string, attemptId?: string): void {
  const aim = state.aims.get(aimId);
  if (!aim) return;
  if (aim.ownerType === 'graph') return;
  const node = state.nodes.get(aim.ownerId);
  if (!node) return;
  if (attemptId) {
    const attempt = state.attempts.get(attemptId);
    if (attempt?.status === 'submitted') decideAttempt(state, tx, attempt);
  } else if (node.kind === 'milestone' || node.kind === 'group') {
    reevaluateMilestone(state, tx, node);
  }
}
