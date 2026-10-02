/** Worker-facing attempt commands (docs/concepts.md §4, §6.5, §7.1, §10). */
import type { Evidence, ExecutionAnnotation, Usage } from '../schemas/common';
import type { Verdict } from '../vocabulary';
import { aimValue, attemptVerdicts, quantitativeVerdict } from './aims';
import { createNote, openRequest, recordEvaluation } from './requests';
import { aimsOf, getAttempt, loopsContaining, openAttempt, runningCount } from './state';
import {
  afterVerdict,
  applyFailure,
  decideAttempt,
  endAttempt,
  setNodeStatus,
  touchGraph,
} from './transitions';
import {
  type Attempt,
  type Directive,
  type DirectiveDelivery,
  EngineError,
  type GraphState,
  type Node,
  type Tx,
} from './types';

const MINUTE = 60_000;

function closedError(attempt: Attempt): EngineError {
  const hints: Record<string, string> = {
    submitted: 'Your work is submitted and awaits judgment. You may stop; do not claim again.',
    passed: 'This attempt passed. Nothing more to do here.',
    failed: 'This attempt was judged and failed. Claim the node again if it is ready.',
    errored: 'This attempt ended with an error. Claim the node again if it is ready.',
    abandoned:
      'This attempt was abandoned (lease expired or released). Re-claim the node to continue.',
    blocked: 'This attempt is blocked. Wait for the blocker request to be resolved, then re-claim.',
    superseded: 'The node was reset (loop or reopen). Re-claim it for the new activation.',
    cancelled: 'The attempt was cancelled (node skipped or failed, or graph ended). Stop work.',
  };
  return new EngineError(
    'ATTEMPT_CLOSED',
    `Attempt ${attempt.id} is ${attempt.status}.`,
    hints[attempt.status],
    410,
    { status: attempt.status, reason: attempt.outcomeReason },
  );
}

function requireRunning(state: GraphState, attemptId: string): Attempt {
  const attempt = getAttempt(state, attemptId);
  if (attempt.status !== 'running') throw closedError(attempt);
  return attempt;
}

function nodeOf(state: GraphState, attempt: Attempt): Node {
  return state.nodes.get(attempt.nodeId) as Node;
}

export type ClaimInput = {
  nodeId: string;
  actor: ExecutionAnnotation;
  skills?: string[];
  dispatchedBy?: ExecutionAnnotation & { orchestratorKey?: string };
};

export function missingSkills(node: Node, skills: string[] = []): string[] {
  return (node.executor.requires ?? []).filter((s) => !skills.includes(s));
}

export function claim(state: GraphState, tx: Tx, input: ClaimInput): Attempt {
  const node = state.nodes.get(input.nodeId);
  if (!node) throw new EngineError('NOT_FOUND', `Node ${input.nodeId} not found.`, undefined, 404);
  const g = state.graph;
  if (g.status !== 'active') {
    throw new EngineError(
      'INVALID_TRANSITION',
      `Graph is ${g.status}; nothing can be claimed.`,
      g.status === 'draft' ? 'Start the graph first.' : 'Wait for the graph to be active.',
    );
  }
  if (node.kind !== 'task') {
    throw new EngineError(
      'INVALID_TRANSITION',
      `'${node.key}' is a ${node.kind}; only tasks are claimed.`,
      node.kind === 'gate' ? 'Gates are approved through their approval request.' : undefined,
    );
  }
  if (openAttempt(state, node.id)) {
    throw new EngineError(
      'ALREADY_CLAIMED',
      `'${node.key}' already has an open attempt.`,
      'Pick another node with work_next.',
    );
  }
  if (node.status !== 'ready') {
    throw new EngineError(
      'INVALID_TRANSITION',
      `'${node.key}' is ${node.status}, not ready.`,
      'Call work_next to get a ready node.',
    );
  }
  const missing = missingSkills(node, input.skills);
  if (missing.length > 0) {
    throw new EngineError(
      'POLICY_DENIED',
      `'${node.key}' requires skills you did not declare: ${missing.join(', ')}.`,
      'Declare the skills if your session has them, or pick another node.',
      403,
    );
  }
  const max = g.policy.maxParallel;
  if (max !== null && runningCount(state) >= max) {
    throw new EngineError(
      'MAX_PARALLEL_REACHED',
      `maxParallel (${max}) attempts are already running.`,
      'Wait for a running attempt to finish.',
    );
  }
  const { now } = tx.ctx;
  node.attemptsTotal += 1;
  const attempt: Attempt = {
    id: tx.ctx.id('at'),
    graphId: g.id,
    nodeId: node.id,
    number: node.attemptsTotal,
    activation: node.activation,
    status: 'running',
    counted: false,
    executor: input.actor,
    leaseExpiresAt: now + node.leaseTtlSec * 1000,
    lastHeartbeatAt: now,
    checklistState: {},
    manual: false,
    startedAt: now,
  };
  if (input.actor.sessionId) attempt.sessionId = input.actor.sessionId;
  if (input.dispatchedBy) attempt.dispatchedBy = input.dispatchedBy;
  if (node.feedback) attempt.feedbackIn = node.feedback;
  state.attempts.set(attempt.id, tx.touch('attempt', attempt));
  node.currentAttemptId = attempt.id;
  tx.emit('attempt.claimed', g.id, 'attempt', attempt.id, {
    nodeId: node.id,
    key: node.key,
    number: attempt.number,
    activation: attempt.activation,
    executor: input.actor,
    dispatchedBy: input.dispatchedBy?.orchestratorKey,
  });
  if (input.dispatchedBy) {
    tx.emit('orchestrator.dispatched', g.id, 'attempt', attempt.id, {
      orchestratorKey: input.dispatchedBy.orchestratorKey,
      nodeKey: node.key,
    });
  }
  setNodeStatus(state, tx, node, 'running');
  node.currentAttemptId = attempt.id;
  for (const loop of loopsContaining(state, node.id)) {
    if (loop.status === 'idle') {
      loop.status = 'active';
      loop.updatedAt = now;
      tx.touch('loop', loop);
    }
  }
  return attempt;
}

/** Directives that apply to an attempt: graph, node, attempt, and session targets. */
export function activeDirectives(state: GraphState, attempt: Attempt): Directive[] {
  return [...state.directives.values()]
    .filter((d) => {
      if (d.status === 'superseded' || d.status === 'expired') return false;
      switch (d.targetType) {
        case 'graph':
          return d.targetId === state.graph.id;
        case 'node':
          return d.targetId === attempt.nodeId;
        case 'attempt':
          return d.targetId === attempt.id;
        case 'session':
          return attempt.sessionId !== undefined && d.targetId === attempt.sessionId;
        default:
          return false;
      }
    })
    .filter((d) => {
      // Transient control directives only matter while they are new.
      if (d.kind === 'pause' || d.kind === 'resume' || d.kind === 'cancel') {
        return d.createdAt >= attempt.startedAt;
      }
      return true;
    })
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Mark directives delivered to this attempt; returns the ones that were new. */
export function deliverDirectives(
  state: GraphState,
  tx: Tx,
  attempt: Attempt,
  via: DirectiveDelivery['deliveredVia'],
): Directive[] {
  const fresh: Directive[] = [];
  for (const d of activeDirectives(state, attempt)) {
    if (state.deliveries.some((x) => x.directiveId === d.id && x.recipient === attempt.id))
      continue;
    const delivery: DirectiveDelivery = {
      directiveId: d.id,
      recipient: attempt.id,
      deliveredAt: tx.ctx.now,
      deliveredVia: via,
    };
    state.deliveries.push(tx.touch('delivery', delivery));
    if (d.status === 'pending') {
      d.status = 'delivered';
      tx.touch('directive', d);
    }
    tx.emit('directive.delivered', state.graph.id, 'directive', d.id, {
      recipient: attempt.id,
      via,
    });
    fresh.push(d);
  }
  return fresh;
}

export function ackDirective(
  state: GraphState,
  tx: Tx,
  input: { directiveId: string; recipient: string; note?: string },
): DirectiveDelivery {
  const d = state.directives.get(input.directiveId);
  if (!d)
    throw new EngineError('NOT_FOUND', `Directive ${input.directiveId} not found.`, undefined, 404);
  let delivery = state.deliveries.find(
    (x) => x.directiveId === d.id && x.recipient === input.recipient,
  );
  if (!delivery) {
    delivery = {
      directiveId: d.id,
      recipient: input.recipient,
      deliveredAt: tx.ctx.now,
      deliveredVia: 'briefing',
    };
    state.deliveries.push(delivery);
  }
  delivery.ackedAt = tx.ctx.now;
  delivery.ackedBy = tx.ctx.actor;
  if (input.note !== undefined) delivery.ackNote = input.note;
  tx.touch('delivery', delivery);
  if (d.status !== 'superseded' && d.status !== 'expired') {
    d.status = 'acknowledged';
    tx.touch('directive', d);
  }
  tx.emit('directive.acknowledged', state.graph.id, 'directive', d.id, {
    recipient: input.recipient,
    note: input.note,
  });
  return delivery;
}

export type ChecklistInput = Record<string, { done: boolean; evidence?: Evidence[] }>;

function applyChecklist(state: GraphState, tx: Tx, attempt: Attempt, items: ChecklistInput) {
  const node = nodeOf(state, attempt);
  const known = new Set(node.checklist.map((c) => c.key));
  for (const [key, value] of Object.entries(items)) {
    if (!known.has(key)) {
      throw new EngineError(
        'BAD_REQUEST',
        `Checklist item '${key}' does not exist on '${node.key}'.`,
        `Known items: ${[...known].join(', ') || '(none)'}.`,
        400,
      );
    }
    attempt.checklistState[key] = {
      done: value.done,
      ...(value.evidence ? { evidence: value.evidence } : {}),
      at: tx.ctx.now,
    };
  }
  tx.touch('attempt', attempt);
  tx.emit('attempt.checklist_updated', state.graph.id, 'attempt', attempt.id, {
    items: Object.keys(items),
  });
}

export function updateChecklist(
  state: GraphState,
  tx: Tx,
  attemptId: string,
  items: ChecklistInput,
) {
  const attempt = requireRunning(state, attemptId);
  applyChecklist(state, tx, attempt, items);
  return attempt;
}

export type HeartbeatInput = {
  attemptId: string;
  progress?: number;
  step?: string;
  checkpoint?: unknown;
  usage?: Usage;
  checklist?: ChecklistInput;
};

export type HeartbeatResult = {
  leaseExpiresAt: number;
  directives: Directive[];
  pauseRequested: boolean;
  cancelRequested: boolean;
  briefingChanged: boolean;
};

/** Renew the lease and record progress. Writes an event only when progress or step changed. */
export function heartbeat(state: GraphState, tx: Tx, input: HeartbeatInput): HeartbeatResult {
  const attempt = requireRunning(state, input.attemptId);
  const node = nodeOf(state, attempt);
  const { now } = tx.ctx;
  const changed =
    (input.progress !== undefined && input.progress !== attempt.progress) ||
    (input.step !== undefined && input.step !== attempt.currentStep);
  if (input.progress !== undefined) attempt.progress = input.progress;
  if (input.step !== undefined) attempt.currentStep = input.step;
  if (input.checkpoint !== undefined) attempt.checkpoint = input.checkpoint;
  if (input.usage !== undefined) attempt.usage = input.usage;
  attempt.lastHeartbeatAt = now;
  attempt.leaseExpiresAt = now + node.leaseTtlSec * 1000;
  tx.touch('attempt', attempt);
  if (changed && (attempt.lastProgressEventAt ?? 0) + MINUTE <= now) {
    attempt.lastProgressEventAt = now;
    tx.emit('attempt.progress', state.graph.id, 'attempt', attempt.id, {
      progress: attempt.progress,
      step: attempt.currentStep,
    });
  }
  if (input.checklist) applyChecklist(state, tx, attempt, input.checklist);
  const directives = deliverDirectives(state, tx, attempt, 'heartbeat');
  return {
    leaseExpiresAt: attempt.leaseExpiresAt,
    directives,
    pauseRequested: node.status === 'paused' || state.graph.status === 'paused',
    cancelRequested: directives.some((d) => d.kind === 'cancel'),
    briefingChanged: directives.some((d) => d.kind === 'change'),
  };
}

/** Renew every running lease held by these sessions (a session and its descendants). */
export function renewSessionLeases(state: GraphState, tx: Tx, sessionIds: string[]): Attempt[] {
  const renewed: Attempt[] = [];
  for (const attempt of state.attempts.values()) {
    if (attempt.status !== 'running' || !attempt.sessionId) continue;
    if (!sessionIds.includes(attempt.sessionId)) continue;
    const node = nodeOf(state, attempt);
    attempt.lastHeartbeatAt = tx.ctx.now;
    attempt.leaseExpiresAt = tx.ctx.now + node.leaseTtlSec * 1000;
    tx.touch('attempt', attempt);
    renewed.push(attempt);
  }
  return renewed;
}

export type MetricInput = { name: string; value: number; unit?: string };

/** Record metric reports for an attempt, a node, or the graph (`attemptId` and `nodeId` omitted). */
export function reportMetrics(
  state: GraphState,
  tx: Tx,
  input: { attemptId?: string; nodeId?: string; metrics: MetricInput[] },
): void {
  let nodeId = input.nodeId;
  if (input.attemptId) {
    const attempt = getAttempt(state, input.attemptId);
    if (attempt.status !== 'running' && attempt.status !== 'submitted') throw closedError(attempt);
    nodeId = attempt.nodeId;
  }
  for (const m of input.metrics) {
    if (!Number.isFinite(m.value)) {
      throw new EngineError(
        'BAD_REQUEST',
        `Metric '${m.name}' must be a finite number.`,
        undefined,
        400,
      );
    }
    state.metrics.push(
      tx.touch('metric', {
        id: tx.ctx.id('mt'),
        graphId: state.graph.id,
        ...(nodeId ? { nodeId } : {}),
        ...(input.attemptId ? { attemptId: input.attemptId } : {}),
        name: m.name,
        value: m.value,
        ...(m.unit ? { unit: m.unit } : {}),
        actor: tx.ctx.actor,
        recordedAt: tx.ctx.now,
      }),
    );
  }
  tx.emit(
    'metric.reported',
    state.graph.id,
    input.attemptId ? 'attempt' : nodeId ? 'node' : 'graph',
    input.attemptId ?? nodeId ?? state.graph.id,
    {
      metrics: Object.fromEntries(input.metrics.map((m) => [m.name, m.value])),
    },
  );
  touchGraph(state, tx);
}

export type SubmitEvaluation = {
  aim: string;
  verdict: Exclude<Verdict, 'waived'>;
  rationale?: string;
  evidence?: Evidence[];
  score?: number;
};

export type SubmitInput = {
  attemptId: string;
  summary: string;
  evaluations?: SubmitEvaluation[];
  metrics?: MetricInput[];
  usage?: Usage;
  /** Number of proof notes on this attempt, including ones in this submission (server-computed). */
  proofNotes?: number;
};

export type SubmitResult = {
  attempt: Attempt;
  node: Node;
  outcome: 'passed' | 'failed' | 'evaluating';
  next: string;
};

export function submit(state: GraphState, tx: Tx, input: SubmitInput): SubmitResult {
  const attempt = requireRunning(state, input.attemptId);
  const node = nodeOf(state, attempt);
  if (!input.summary?.trim()) {
    throw new EngineError(
      'BAD_REQUEST',
      'A submission needs a summary.',
      'Describe what you did and how you verified it.',
      400,
    );
  }
  const required = node.checklist.filter((c) => c.required && !attempt.checklistState[c.key]?.done);
  if (required.length > 0) {
    throw new EngineError(
      'CHECKLIST_INCOMPLETE',
      `Required checklist items are not ticked: ${required.map((c) => c.key).join(', ')}.`,
      `Tick them with evidence: POST /attempts/${attempt.id}/checklist {"items":{"${required[0]?.key}":{"done":true,"evidence":[…]}}}.`,
      422,
    );
  }
  if (state.graph.policy.requireProofForDone && (input.proofNotes ?? 0) < 1) {
    throw new EngineError(
      'PROOF_REQUIRED',
      'This graph requires at least one proof note per attempt before submit.',
      `Add one: POST /attempts/${attempt.id}/notes {"type":"proof","title":…,"evidence":[…]}.`,
      422,
    );
  }

  const aims = aimsOf(state, 'node', node.id);
  const byKey = new Map(aims.map((a) => [a.key, a]));
  const given = new Map<string, SubmitEvaluation>();
  for (const ev of input.evaluations ?? []) {
    const aim = byKey.get(ev.aim);
    if (!aim) {
      throw new EngineError(
        'BAD_REQUEST',
        `Aim '${ev.aim}' does not exist on '${node.key}'.`,
        `Aims: ${[...byKey.keys()].join(', ')}.`,
        400,
      );
    }
    if (aim.kind !== 'qualitative' || aim.evaluator !== 'self') {
      throw new EngineError(
        'POLICY_DENIED',
        `Aim '${aim.key}' is ${aim.kind === 'quantitative' ? 'quantitative (report its metric instead)' : `judged by ${aim.evaluator}`}; you cannot submit its verdict.`,
        aim.kind === 'quantitative'
          ? `Report '${aim.metric}' in metrics.`
          : 'Leave it to the evaluator.',
        403,
      );
    }
    given.set(aim.key, ev);
  }

  // Values and verdicts available at submit time, before anything is recorded.
  const pendingMetrics = new Map<string, number>();
  for (const m of input.metrics ?? []) pendingMetrics.set(m.name, m.value);
  const valueFor = (aimKey: string): number | undefined => {
    const aim = byKey.get(aimKey);
    if (!aim?.metric) return undefined;
    if (
      aim.source === 'reported' &&
      aim.aggregation === 'latest' &&
      pendingMetrics.has(aim.metric)
    ) {
      return pendingMetrics.get(aim.metric);
    }
    return undefined;
  };
  const decidable = (aimKey: string): boolean => {
    const aim = byKey.get(aimKey);
    if (!aim) return false;
    if (aim.kind === 'quantitative') {
      if (aim.source === 'derived') return true;
      return (
        valueFor(aimKey) !== undefined ||
        state.metrics.some((m) => m.attemptId === attempt.id && m.name === aim.metric) ||
        (input.metrics ?? []).some((m) => m.name === aim.metric)
      );
    }
    return aim.evaluator === 'self' ? given.has(aimKey) : true;
  };
  const terminating = aims.filter((a) => a.terminating);
  const missing = terminating.filter((a) => !decidable(a.key));
  if (
    node.aimMode === 'all'
      ? missing.length > 0
      : missing.length === terminating.length && terminating.length > 0
  ) {
    const first = missing[0];
    const what = missing
      .map((a) =>
        a.kind === 'quantitative'
          ? `metric '${a.metric}' (aim '${a.key}')`
          : `a verdict for aim '${a.key}'`,
      )
      .join(', ');
    throw new EngineError(
      'AIM_EVIDENCE_MISSING',
      `Submission is missing ${what}.`,
      first?.kind === 'quantitative'
        ? `Report it with POST /attempts/${attempt.id}/metrics {"metrics":{"${first.metric}":<value>}} or call /fail if you cannot measure it.`
        : `Include {"aim":"${first?.key}","verdict":"met|unmet|partial","rationale":…} in evaluations.`,
      422,
      missing.map((a) => a.key),
    );
  }

  // Record everything.
  if (input.metrics?.length)
    reportMetrics(state, tx, { attemptId: attempt.id, metrics: input.metrics });
  if (input.usage) attempt.usage = input.usage;
  attempt.summary = input.summary;
  attempt.submittedAt = tx.ctx.now;
  attempt.status = 'submitted';
  delete attempt.leaseExpiresAt;
  tx.touch('attempt', attempt);
  tx.emit('attempt.submitted', state.graph.id, 'attempt', attempt.id, {
    nodeId: node.id,
    summary: input.summary,
  });

  const verdicts = attemptVerdicts(state, attempt);
  for (const aim of aims) {
    if (verdicts.has(aim.id)) continue;
    if (aim.kind === 'quantitative') {
      const value = aimValue(state, aim, attempt);
      const verdict = quantitativeVerdict(aim, value);
      if (verdict) {
        recordEvaluation(state, tx, {
          aim,
          verdict,
          attemptId: attempt.id,
          activation: attempt.activation,
          value: value as number,
          evaluatorKind: 'system',
        });
      }
    } else if (aim.evaluator === 'self') {
      const ev = given.get(aim.key);
      if (ev) {
        recordEvaluation(state, tx, {
          aim,
          verdict: ev.verdict,
          attemptId: attempt.id,
          activation: attempt.activation,
          evaluatorKind: 'self',
          ...(ev.rationale ? { rationale: ev.rationale } : {}),
          ...(ev.evidence ? { evidence: ev.evidence } : {}),
          ...(ev.score !== undefined ? { score: ev.score } : {}),
        });
      }
    }
  }

  const outcome = decideAttempt(state, tx, attempt);
  if (outcome === 'evaluating') {
    if (node.status !== 'paused') setNodeStatus(state, tx, node, 'evaluating', 'awaiting judgment');
    for (const aim of terminating) {
      if (aim.kind === 'qualitative' && aim.evaluator === 'human') {
        openRequest(state, tx, {
          kind: 'approval',
          subject: 'aim',
          title: `${node.title}: judge "${aim.title}"`,
          body: input.summary,
          nodeId: node.id,
          attemptId: attempt.id,
          aimId: aim.id,
          assignee: 'human',
        });
      }
    }
  }
  const waiting = terminating
    .filter((a) => !attemptVerdicts(state, attempt).has(a.id))
    .map((a) => `'${a.key}' (${a.evaluator}${a.evaluatorKey ? ` '${a.evaluatorKey}'` : ''})`);
  const next =
    outcome === 'passed'
      ? 'Passed. Call work_next for more work.'
      : outcome === 'evaluating'
        ? `Awaiting judgment on ${waiting.join(', ')}. You may stop; do not claim this node again.`
        : node.status === 'ready'
          ? 'Failed: see the unmet aims. The node is ready for another attempt with this feedback.'
          : `Failed. The node is now ${node.status}.`;
  return { attempt, node, outcome, next };
}

export type EvaluateInput = {
  attemptId: string;
  aim: string;
  verdict: Exclude<Verdict, 'waived'>;
  rationale?: string;
  evidence?: Evidence[];
  score?: number;
};

/** An external judge's verdict on a submitted attempt (§6.4). */
export function evaluate(state: GraphState, tx: Tx, input: EvaluateInput) {
  const attempt = getAttempt(state, input.attemptId);
  if (attempt.status !== 'submitted') throw closedError(attempt);
  const node = nodeOf(state, attempt);
  const aim = aimsOf(state, 'node', node.id).find((a) => a.key === input.aim);
  if (!aim)
    throw new EngineError(
      'NOT_FOUND',
      `Aim '${input.aim}' does not exist on '${node.key}'.`,
      undefined,
      404,
    );
  if (aim.kind !== 'qualitative' || aim.evaluator === 'self') {
    throw new EngineError(
      'POLICY_DENIED',
      `Aim '${aim.key}' is not externally judged.`,
      undefined,
      403,
    );
  }
  const actor = tx.ctx.actor;
  if (aim.evaluator === 'human' && actor.kind !== 'human') {
    throw new EngineError(
      'POLICY_DENIED',
      `Aim '${aim.key}' is judged by a human.`,
      'Leave it in the Inbox.',
      403,
    );
  }
  if (
    state.graph.policy.evaluation.independent &&
    (aim.evaluator === 'agent' || aim.evaluator === 'orchestrator') &&
    actor.sessionId !== undefined &&
    actor.sessionId === attempt.executor.sessionId
  ) {
    throw new EngineError(
      'POLICY_DENIED',
      'Independence policy: you cannot judge an attempt your own session executed.',
      'Ask a different session (for example a judge subagent) to evaluate it.',
      403,
    );
  }
  if (attemptVerdicts(state, attempt).has(aim.id)) {
    throw new EngineError('CONFLICT', `Aim '${aim.key}' already has a verdict for this attempt.`);
  }
  recordEvaluation(state, tx, {
    aim,
    verdict: input.verdict,
    attemptId: attempt.id,
    activation: attempt.activation,
    evaluatorKind: aim.evaluator,
    ...(input.rationale ? { rationale: input.rationale } : {}),
    ...(input.evidence ? { evidence: input.evidence } : {}),
    ...(input.score !== undefined ? { score: input.score } : {}),
  });
  afterVerdict(state, tx, aim.id, attempt.id);
  return { attempt, node };
}

/** The agent cannot complete the work: counted `errored` (§7.1 rule 2/3). */
export function failAttempt(
  state: GraphState,
  tx: Tx,
  input: { attemptId: string; reason: string; retryable?: boolean; usage?: Usage },
) {
  const attempt = requireRunning(state, input.attemptId);
  const node = nodeOf(state, attempt);
  if (input.usage) attempt.usage = input.usage;
  endAttempt(state, tx, attempt, 'errored', { reason: input.reason, counted: true });
  applyFailure(state, tx, node, attempt, { nonRetryable: input.retryable === false });
  return { attempt, node };
}

export function blockAttempt(
  state: GraphState,
  tx: Tx,
  input: { attemptId: string; reason: string; request: { title: string; body?: string } },
) {
  const attempt = requireRunning(state, input.attemptId);
  const node = nodeOf(state, attempt);
  endAttempt(state, tx, attempt, 'blocked', { reason: input.reason });
  createNote(state, tx, {
    type: 'blocker',
    title: input.request.title,
    body: input.request.body ?? input.reason,
    nodeId: node.id,
    attemptId: attempt.id,
  });
  const request = openRequest(state, tx, {
    kind: 'blocker',
    subject: 'blocker',
    title: input.request.title,
    body: input.request.body ?? input.reason,
    nodeId: node.id,
    attemptId: attempt.id,
    assignee: 'human',
  });
  if (node.status !== 'paused') setNodeStatus(state, tx, node, 'blocked', input.reason);
  return { attempt, node, request };
}

/** Voluntary release: `abandoned`, not counted. The node returns to ready (or stays paused). */
export function releaseAttempt(
  state: GraphState,
  tx: Tx,
  input: { attemptId: string; reason: string; handoff?: string },
) {
  const attempt = requireRunning(state, input.attemptId);
  const node = nodeOf(state, attempt);
  if (input.handoff) {
    createNote(state, tx, {
      type: 'handoff',
      title: `Handoff: ${node.key}`,
      body: input.handoff,
      nodeId: node.id,
      attemptId: attempt.id,
    });
  }
  endAttempt(state, tx, attempt, 'abandoned', { reason: `released: ${input.reason}` });
  if (node.status !== 'paused') setNodeStatus(state, tx, node, 'ready', 'attempt released');
  return { attempt, node };
}

/** Sweeper (every 30 s): lease expiry, attempt timeouts, orchestrator leases, expiries. */
export function sweep(state: GraphState, tx: Tx): { expired: string[] } {
  const { now } = tx.ctx;
  const expired: string[] = [];
  for (const attempt of [...state.attempts.values()]) {
    if (attempt.status !== 'running') continue;
    const node = nodeOf(state, attempt);
    if (attempt.leaseExpiresAt !== undefined && attempt.leaseExpiresAt <= now) {
      const paused = node.status === 'paused' || state.graph.status === 'paused';
      endAttempt(state, tx, attempt, 'abandoned', { reason: 'lease expired', counted: !paused });
      expired.push(attempt.id);
      if (node.status === 'paused') continue;
      if (attempt.counted) applyFailure(state, tx, node, attempt);
      else setNodeStatus(state, tx, node, 'ready', 'lease expired');
      continue;
    }
    if (
      node.timeoutSec !== undefined &&
      !attempt.timeoutEscalated &&
      attempt.startedAt + node.timeoutSec * 1000 <= now
    ) {
      attempt.timeoutEscalated = true;
      tx.touch('attempt', attempt);
      openRequest(state, tx, {
        kind: 'escalation',
        subject: 'timeout',
        title: `${node.title}: attempt ${attempt.number} exceeded its ${Math.round(node.timeoutSec / 60)} min timeout`,
        nodeId: node.id,
        attemptId: attempt.id,
        blocking: false,
      });
    }
  }
  for (const orch of state.orchestrators.values()) {
    if (
      orch.status === 'active' &&
      orch.leaseExpiresAt !== undefined &&
      orch.leaseExpiresAt <= now
    ) {
      orch.status = 'idle';
      delete orch.leaseExpiresAt;
      delete orch.sessionId;
      orch.updatedAt = now;
      tx.touch('orchestrator', orch);
      tx.emit('orchestrator.lease_expired', state.graph.id, 'orchestrator', orch.id, {
        key: orch.key,
      });
    }
  }
  for (const d of state.directives.values()) {
    if (
      d.expiresAt !== undefined &&
      d.expiresAt <= now &&
      d.status !== 'acknowledged' &&
      d.status !== 'superseded' &&
      d.status !== 'expired'
    ) {
      d.status = 'expired';
      tx.touch('directive', d);
      tx.emit('directive.expired', state.graph.id, 'directive', d.id, {});
    }
  }
  for (const r of state.requests.values()) {
    if (r.status === 'open' && r.expiresAt !== undefined && r.expiresAt <= now) {
      r.status = 'expired';
      r.resolvedAt = now;
      tx.touch('request', r);
      tx.emit('request.expired', state.graph.id, 'request', r.id, {});
    }
  }
  return { expired };
}

/** Admin: the attempt record for a manual completion (§3.3); terminating aims without a verdict are waived. */
export function manualAttempt(
  state: GraphState,
  tx: Tx,
  node: Node,
  input: { summary: string; evidence?: Evidence[]; evaluations?: SubmitEvaluation[] },
): Attempt {
  node.attemptsTotal += 1;
  const attempt: Attempt = {
    id: tx.ctx.id('at'),
    graphId: state.graph.id,
    nodeId: node.id,
    number: node.attemptsTotal,
    activation: node.activation,
    status: 'passed',
    counted: false,
    executor: tx.ctx.actor,
    checklistState: {},
    summary: input.summary,
    manual: true,
    startedAt: tx.ctx.now,
    submittedAt: tx.ctx.now,
    passedAt: tx.ctx.now,
    endedAt: tx.ctx.now,
  };
  if (tx.ctx.actor.sessionId) attempt.sessionId = tx.ctx.actor.sessionId;
  state.attempts.set(attempt.id, tx.touch('attempt', attempt));
  tx.emit('attempt.passed', state.graph.id, 'attempt', attempt.id, {
    nodeId: node.id,
    number: attempt.number,
    manual: true,
  });
  const given = new Map((input.evaluations ?? []).map((e) => [e.aim, e]));
  for (const aim of aimsOf(state, 'node', node.id)) {
    const ev = given.get(aim.key);
    if (ev) {
      recordEvaluation(state, tx, {
        aim,
        verdict: ev.verdict,
        attemptId: attempt.id,
        activation: node.activation,
        evaluatorKind: tx.ctx.actor.kind === 'human' ? 'human' : 'orchestrator',
        ...(ev.rationale ? { rationale: ev.rationale } : {}),
        evidence: ev.evidence ?? input.evidence ?? [],
      });
    } else if (aim.terminating) {
      recordEvaluation(state, tx, {
        aim,
        verdict: 'waived',
        attemptId: attempt.id,
        activation: node.activation,
        rationale: `manual completion: ${input.summary}`,
        evidence: input.evidence ?? [],
        evaluatorKind: tx.ctx.actor.kind === 'human' ? 'human' : 'orchestrator',
      });
    }
  }
  return attempt;
}
