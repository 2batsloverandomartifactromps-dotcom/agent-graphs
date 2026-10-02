/** Note commands (docs/concepts.md §9.1): append-only records with annotation inheritance. */
import type { Evidence, ExecutionAnnotation, Usage } from '../schemas/common';
import type { FindingSeverity, NoteType, RequestAssignee } from '../vocabulary';
import { reportMetrics } from './attempts';
import { createNote, openRequest } from './requests';
import { EngineError, type GraphState, type Note, type Tx } from './types';

export type AddNoteInput = {
  type: NoteType;
  title: string;
  body?: string;
  severity?: FindingSeverity;
  evidence?: Evidence[];
  metrics?: Record<string, number>;
  replyTo?: string;
  author?: Partial<ExecutionAnnotation>;
  usage?: Usage;
  pinned?: boolean;
  nodeId?: string;
  attemptId?: string;
  orchestratorId?: string;
  assignee?: RequestAssignee;
};

/**
 * Add a note. On an attempt, the author defaults to the attempt's executor annotation (fields
 * in `author` override it). When the caller is not the author, the caller is recorded as
 * `relayedBy`. Metrics are also recorded as metric reports; questions open a request.
 */
export function addNote(state: GraphState, tx: Tx, input: AddNoteInput): Note {
  let nodeId = input.nodeId;
  let base: ExecutionAnnotation = tx.ctx.actor;
  if (input.attemptId) {
    const attempt = state.attempts.get(input.attemptId);
    if (!attempt)
      throw new EngineError('NOT_FOUND', `Attempt ${input.attemptId} not found.`, undefined, 404);
    nodeId = attempt.nodeId;
    base = attempt.executor;
  } else if (nodeId && !state.nodes.has(nodeId)) {
    throw new EngineError('NOT_FOUND', `Node ${nodeId} not found.`, undefined, 404);
  }
  if (input.orchestratorId && !state.orchestrators.has(input.orchestratorId)) {
    throw new EngineError(
      'NOT_FOUND',
      `Orchestrator ${input.orchestratorId} not found.`,
      undefined,
      404,
    );
  }
  if (input.severity && input.type !== 'finding') {
    throw new EngineError('BAD_REQUEST', 'Only findings carry a severity.', undefined, 400);
  }
  const author: ExecutionAnnotation = { ...base, ...input.author } as ExecutionAnnotation;
  const caller = tx.ctx.actor;
  const relayed =
    (caller.sessionId !== undefined && caller.sessionId !== author.sessionId) ||
    (caller.kind !== author.kind && caller.kind !== 'system');
  const note = createNote(state, tx, {
    type: input.type,
    title: input.title,
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(nodeId ? { nodeId } : {}),
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    ...(input.orchestratorId ? { orchestratorId: input.orchestratorId } : {}),
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    ...(input.severity ? { severity: input.severity } : {}),
    ...(input.evidence ? { evidence: input.evidence } : {}),
    ...(input.metrics ? { metrics: input.metrics } : {}),
    ...(input.usage ? { usage: input.usage } : {}),
    ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
    author,
    ...(relayed ? { relayedBy: caller } : {}),
  });
  if (input.metrics && Object.keys(input.metrics).length) {
    const metrics = Object.entries(input.metrics).map(([name, value]) => ({ name, value }));
    const attempt = input.attemptId ? state.attempts.get(input.attemptId) : undefined;
    const open = attempt && (attempt.status === 'running' || attempt.status === 'submitted');
    reportMetrics(
      state,
      tx,
      open ? { attemptId: attempt.id, metrics } : { ...(nodeId ? { nodeId } : {}), metrics },
    );
  }
  if (input.type === 'question') {
    openRequest(state, tx, {
      kind: 'question',
      subject: 'question',
      title: input.title,
      ...(input.body ? { body: input.body } : {}),
      ...(nodeId ? { nodeId } : {}),
      ...(input.attemptId ? { attemptId: input.attemptId } : {}),
      assignee: input.assignee ?? 'any',
      blocking: false,
    });
  }
  return note;
}
