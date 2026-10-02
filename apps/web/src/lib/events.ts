/**
 * Human-readable event descriptions for activity feeds (docs/data-model.md § Event catalog).
 */
import type { Annotation, LiveEvent, StoredEvent } from '@agent-graphs/sdk';

export type AnyEvent = Pick<LiveEvent, 'type' | 'actor' | 'payload' | 'createdAt'> & {
  seq: number;
  graphId: string | null;
  entity?: { type: string; id: string };
  entityType?: string;
  entityId?: string;
  snapshot?: unknown;
};

export type EventDescription = {
  /** Status-like tone for the leading icon (an `st-*` family or a note type). */
  tone: string;
  verb: string;
  /** The node, request, or entity the event is about (mono). */
  target?: string;
  detail?: string;
  /** Significant events appear in the Overview feed. */
  significant: boolean;
};

export function fromStored(e: StoredEvent): AnyEvent {
  return { ...e, entity: { type: e.entityType, id: e.entityId } };
}

export function actorName(actor: Annotation | undefined): string {
  if (!actor) return 'unknown';
  if (actor.kind === 'system') return actor.agent ?? 'system';
  return actor.agent ?? actor.role ?? actor.model ?? (actor.kind === 'human' ? 'Human' : 'agent');
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/** Resolve a node key from an event (payload key, snapshot key, or via a lookup). */
export function eventNodeKey(
  e: AnyEvent,
  keyOfId?: (id: string) => string | undefined,
): string | undefined {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const snap = (e.snapshot ?? {}) as Record<string, unknown>;
  const entityType = e.entity?.type ?? e.entityType;
  const entityId = e.entity?.id ?? e.entityId;
  return (
    str(p.key) ??
    str(p.nodeKey) ??
    str(snap.nodeKey) ??
    (entityType === 'node'
      ? (str(snap.key) ?? (entityId ? keyOfId?.(entityId) : undefined))
      : undefined) ??
    (str(p.nodeId) ? keyOfId?.(p.nodeId as string) : undefined)
  );
}

export function describeEvent(
  e: AnyEvent,
  keyOfId?: (id: string) => string | undefined,
): EventDescription {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const key = eventNodeKey(e, keyOfId);
  const t = e.type;
  switch (t) {
    case 'node.status_changed': {
      const to = str(p.to) ?? 'changed';
      return {
        tone: `st-${to}`,
        verb: `moved ${str(p.from) ?? ''} → ${to}`.replace('  ', ' '),
        target: key,
        detail: str(p.reason),
        significant: ['done', 'failed', 'needs_input', 'blocked', 'running'].includes(to),
      };
    }
    case 'attempt.claimed':
      return { tone: 'st-running', verb: 'claimed', target: key, significant: true };
    case 'attempt.progress':
      return {
        tone: 'st-running',
        verb: 'started step',
        target: key,
        detail: str(p.step) ?? str(p.currentStep),
        significant: true,
      };
    case 'attempt.submitted':
      return {
        tone: 'st-evaluating',
        verb: 'submitted',
        target: key,
        detail: str(p.summary),
        significant: true,
      };
    case 'attempt.passed':
      return { tone: 'st-done', verb: 'passed', target: key, significant: true };
    case 'attempt.failed':
      return {
        tone: 'st-failed',
        verb: 'failed aims on',
        target: key,
        detail: str(p.reason),
        significant: true,
      };
    case 'attempt.errored':
      return {
        tone: 'st-errored',
        verb: 'errored on',
        target: key,
        detail: str(p.reason),
        significant: true,
      };
    case 'attempt.blocked':
      return {
        tone: 'st-blocked',
        verb: 'is blocked on',
        target: key,
        detail: str(p.reason),
        significant: true,
      };
    case 'attempt.abandoned':
      return {
        tone: 'st-abandoned',
        verb: 'abandoned',
        target: key,
        detail: str(p.reason),
        significant: true,
      };
    case 'attempt.superseded':
      return {
        tone: 'st-superseded',
        verb: 'superseded attempt on',
        target: key,
        significant: false,
      };
    case 'attempt.cancelled':
      return {
        tone: 'st-cancelled',
        verb: 'cancelled attempt on',
        target: key,
        significant: false,
      };
    case 'aim.evaluated':
      return {
        tone: `st-${str(p.verdict) ?? 'pending'}`,
        verb: `judged ${str(p.verdict) ?? ''}`.trim(),
        target: str(p.key) ?? key,
        detail: str(p.rationale),
        significant: true,
      };
    case 'aim.waived':
      return {
        tone: 'st-waived',
        verb: 'waived aim',
        target: str(p.key) ?? key,
        detail: str(p.justification),
        significant: true,
      };
    case 'aim.guard_violated':
      return { tone: 'st-blocked', verb: 'guard violated', target: str(p.key), significant: true };
    case 'request.created':
      return {
        tone: 'st-needs_input',
        verb: `raised ${str(p.kind) ?? 'a request'}`,
        target: key,
        detail: str(p.title),
        significant: true,
      };
    case 'request.resolved':
      return {
        tone: 'st-done',
        verb: `resolved (${str(p.choice) ?? 'done'})`,
        target: key,
        detail: str(p.comment),
        significant: true,
      };
    case 'request.dismissed':
      return {
        tone: 'st-dismissed',
        verb: 'dismissed a request',
        target: key,
        detail: str(p.reason),
        significant: false,
      };
    case 'directive.created':
      return {
        tone: 'st-delivered',
        verb: `sent a ${str(p.kind) ?? ''} directive`.replace('  ', ' '),
        target: key,
        detail: str(p.title),
        significant: true,
      };
    case 'directive.delivered':
      return {
        tone: 'st-delivered',
        verb: 'received a directive',
        target: key,
        significant: false,
      };
    case 'directive.acknowledged':
      return {
        tone: 'st-acknowledged',
        verb: 'acknowledged a directive',
        target: key,
        detail: str(p.note),
        significant: true,
      };
    case 'loop.iterated':
      return {
        tone: 'st-active',
        verb: `iterated loop to ${String(p.iteration ?? '')}`.trim(),
        target: str(p.key),
        detail: str(p.feedbackSummary),
        significant: true,
      };
    case 'loop.exhausted':
      return {
        tone: 'st-exhausted',
        verb: 'exhausted loop',
        target: str(p.key),
        significant: true,
      };
    case 'loop.satisfied':
      return {
        tone: 'st-satisfied',
        verb: 'satisfied loop',
        target: str(p.key),
        significant: true,
      };
    case 'loop.extended':
      return { tone: 'st-active', verb: 'extended loop', target: str(p.key), significant: true };
    case 'note.created':
      return {
        tone: `nt-${str(p.type) ?? 'comment'}`,
        verb: `posted ${str(p.type) ?? 'a note'}`,
        target: key,
        detail: str(p.title),
        significant: str(p.type) !== 'progress',
      };
    case 'orchestrator.attached':
      return {
        tone: 'st-active',
        verb: 'attached as orchestrator',
        target: str(p.key),
        significant: true,
      };
    case 'orchestrator.dispatched':
      return {
        tone: 'st-active',
        verb: 'dispatched',
        target: str(p.nodeKey) ?? key,
        significant: true,
      };
    case 'graph.created':
    case 'graph.started':
    case 'graph.paused':
    case 'graph.resumed':
    case 'graph.verifying':
    case 'graph.completed':
    case 'graph.failed':
    case 'graph.cancelled':
    case 'graph.reopened':
    case 'graph.archived': {
      const verb = t.slice('graph.'.length);
      const tone =
        verb === 'completed'
          ? 'st-completed'
          : verb === 'failed'
            ? 'st-failed'
            : verb === 'paused'
              ? 'st-paused'
              : 'st-active';
      return { tone, verb: `${verb} the graph`, significant: true };
    }
    case 'node.updated':
      return {
        tone: 'st-delivered',
        verb: 'edited',
        target: key,
        detail: changedKeys(p),
        significant: true,
      };
    default: {
      const [entity, action] = t.split('.');
      return {
        tone: 'st-pending',
        verb: `${(action ?? t).replace(/_/g, ' ')} ${entity ?? ''}`.trim(),
        target: key,
        significant: false,
      };
    }
  }
}

function changedKeys(p: Record<string, unknown>): string | undefined {
  const after = p.after as Record<string, unknown> | undefined;
  if (after && typeof after === 'object') return Object.keys(after).join(', ');
  const changes = p.changes;
  return Array.isArray(changes) ? changes.join(', ') : undefined;
}
