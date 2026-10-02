/**
 * Status display metadata (docs/ui.md §6.1, §6.6). Every status pairs a hue family (the `st-*`
 * CSS class that sets --c / --c-fg), an icon glyph, a label, and a fill treatment, so status is
 * never shown by color alone.
 */
import type { NodeStatus } from '@agent-graphs/core';

export type StatusIconName =
  | 'pending'
  | 'ready'
  | 'running'
  | 'evaluating'
  | 'needs_input'
  | 'blocked'
  | 'paused'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'cancelled'
  | 'met'
  | 'unmet'
  | 'partial'
  | 'waived'
  | 'aimpending';

export type Treatment = 'plain' | 'outline' | 'solid' | 'striped';

export type StatusMeta = {
  label: string;
  icon: StatusIconName;
  /** The `st-*` class carrying the hue family. */
  cls: string;
  treatment: Treatment;
};

const NODE: Record<NodeStatus, StatusMeta> = {
  pending: { label: 'Pending', icon: 'pending', cls: 'st-pending', treatment: 'plain' },
  ready: { label: 'Ready', icon: 'ready', cls: 'st-ready', treatment: 'plain' },
  running: { label: 'Running', icon: 'running', cls: 'st-running', treatment: 'plain' },
  evaluating: { label: 'Evaluating', icon: 'evaluating', cls: 'st-evaluating', treatment: 'plain' },
  needs_input: {
    label: 'Needs input',
    icon: 'needs_input',
    cls: 'st-needs_input',
    treatment: 'plain',
  },
  blocked: { label: 'Blocked', icon: 'blocked', cls: 'st-blocked', treatment: 'outline' },
  paused: { label: 'Paused', icon: 'paused', cls: 'st-paused', treatment: 'plain' },
  done: { label: 'Done', icon: 'done', cls: 'st-done', treatment: 'plain' },
  failed: { label: 'Failed', icon: 'failed', cls: 'st-failed', treatment: 'solid' },
  skipped: { label: 'Skipped', icon: 'skipped', cls: 'st-skipped', treatment: 'striped' },
  cancelled: { label: 'Cancelled', icon: 'cancelled', cls: 'st-cancelled', treatment: 'plain' },
};

const OTHER: Record<string, StatusMeta> = {
  // aims
  met: { label: 'Met', icon: 'met', cls: 'st-met', treatment: 'plain' },
  unmet: { label: 'Unmet', icon: 'unmet', cls: 'st-unmet', treatment: 'plain' },
  partial: { label: 'Partial', icon: 'partial', cls: 'st-partial', treatment: 'plain' },
  waived: { label: 'Waived', icon: 'waived', cls: 'st-waived', treatment: 'plain' },
  // attempts
  passed: { label: 'Passed', icon: 'done', cls: 'st-passed', treatment: 'plain' },
  submitted: { label: 'Submitted', icon: 'evaluating', cls: 'st-submitted', treatment: 'plain' },
  errored: { label: 'Errored', icon: 'blocked', cls: 'st-errored', treatment: 'plain' },
  abandoned: { label: 'Abandoned', icon: 'cancelled', cls: 'st-abandoned', treatment: 'plain' },
  superseded: { label: 'Superseded', icon: 'skipped', cls: 'st-superseded', treatment: 'plain' },
  // graphs
  draft: { label: 'Draft', icon: 'pending', cls: 'st-draft', treatment: 'plain' },
  active: { label: 'Active', icon: 'running', cls: 'st-active', treatment: 'plain' },
  verifying: { label: 'Verifying', icon: 'evaluating', cls: 'st-verifying', treatment: 'plain' },
  completed: { label: 'Completed', icon: 'done', cls: 'st-completed', treatment: 'plain' },
  // loops, orchestrators, sessions
  idle: { label: 'Idle', icon: 'pending', cls: 'st-idle', treatment: 'plain' },
  satisfied: { label: 'Satisfied', icon: 'done', cls: 'st-satisfied', treatment: 'plain' },
  exhausted: { label: 'Exhausted', icon: 'failed', cls: 'st-exhausted', treatment: 'solid' },
  stopped: { label: 'Stopped', icon: 'cancelled', cls: 'st-stopped', treatment: 'plain' },
  ended: { label: 'Ended', icon: 'cancelled', cls: 'st-ended', treatment: 'plain' },
  lost: { label: 'Lost', icon: 'blocked', cls: 'st-lost', treatment: 'outline' },
  // directives and requests
  delivered: { label: 'Delivered', icon: 'ready', cls: 'st-delivered', treatment: 'plain' },
  acknowledged: { label: 'Acknowledged', icon: 'done', cls: 'st-acknowledged', treatment: 'plain' },
  expired: { label: 'Expired', icon: 'cancelled', cls: 'st-expired', treatment: 'plain' },
  open: { label: 'Open', icon: 'needs_input', cls: 'st-needs_input', treatment: 'plain' },
  resolved: { label: 'Resolved', icon: 'done', cls: 'st-resolved', treatment: 'plain' },
  dismissed: { label: 'Dismissed', icon: 'cancelled', cls: 'st-dismissed', treatment: 'plain' },
};

/** Metadata for any status string (node, attempt, aim, graph, loop, directive, …). */
export function statusMeta(status: string | undefined): StatusMeta {
  if (!status) return NODE.pending;
  return (NODE as Record<string, StatusMeta>)[status] ?? OTHER[status] ?? fallback(status);
}

/** Aim verdict metadata: a pending aim uses the dashed "not yet evaluated" glyph. */
export function aimMeta(status: string | undefined): StatusMeta {
  if (!status || status === 'pending')
    return { label: 'Pending', icon: 'aimpending', cls: 'st-pending', treatment: 'plain' };
  return statusMeta(status);
}

function fallback(status: string): StatusMeta {
  const label = status.replace(/_/g, ' ');
  return {
    label: label.charAt(0).toUpperCase() + label.slice(1),
    icon: 'pending',
    cls: 'st-pending',
    treatment: 'plain',
  };
}

/** Segment order for progress bars and legends (mockup ORDER). */
export const STATUS_ORDER: NodeStatus[] = [
  'done',
  'running',
  'evaluating',
  'needs_input',
  'blocked',
  'ready',
  'paused',
  'failed',
  'skipped',
  'cancelled',
  'pending',
];

export type Segment = { status: NodeStatus; count: number; label: string };

/** Non-empty status segments in display order. */
export function segments(counts: Partial<Record<string, number>>): Segment[] {
  return STATUS_ORDER.filter((s) => (counts[s] ?? 0) > 0).map((s) => ({
    status: s,
    count: counts[s] as number,
    label: NODE[s].label.toLowerCase(),
  }));
}

/** Pill modifier class: failed is solid, blocked is outlined (docs/ui.md §1.2). */
export function pillTreatmentClass(status: string): string {
  const t = statusMeta(status).treatment;
  return t === 'solid' ? 'solid' : t === 'outline' ? 'outline' : '';
}

/** Node statuses that count as "needs attention". */
export const ATTENTION_STATUSES: ReadonlySet<string> = new Set([
  'needs_input',
  'blocked',
  'failed',
]);

/** Terminal node statuses. */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'done',
  'skipped',
  'failed',
  'cancelled',
]);

/** Node actions allowed from each status (docs/concepts.md §3.4). */
export function allowedNodeActions(status: string, kind = 'task'): Set<NodeAction> {
  const out = new Set<NodeAction>();
  if (['pending', 'ready', 'running', 'evaluating', 'needs_input', 'blocked'].includes(status))
    out.add('pause');
  if (status === 'paused') out.add('resume');
  if (
    ['pending', 'ready', 'running', 'evaluating', 'needs_input', 'blocked', 'failed'].includes(
      status,
    )
  )
    out.add('skip');
  if (status === 'failed' || status === 'needs_input') out.add('retry');
  if (['ready', 'running', 'evaluating', 'needs_input', 'blocked'].includes(status))
    out.add('fail');
  if (['done', 'skipped', 'failed'].includes(status)) out.add('reopen');
  if (
    kind !== 'milestone' &&
    ['pending', 'ready', 'needs_input', 'blocked', 'failed'].includes(status)
  )
    out.add('complete-manually');
  return out;
}

export type NodeAction =
  | 'pause'
  | 'resume'
  | 'skip'
  | 'fail'
  | 'retry'
  | 'reopen'
  | 'complete-manually';

/** Graph lifecycle actions allowed from each status (docs/concepts.md §2.1). */
export function allowedGraphActions(status: string, archived: boolean): Set<GraphAction> {
  const out = new Set<GraphAction>();
  if (status === 'draft') out.add('start');
  if (status === 'active') out.add('pause');
  if (status === 'paused') out.add('resume');
  if (['active', 'paused', 'verifying'].includes(status)) out.add('cancel');
  if (status === 'completed' || status === 'failed') out.add('reopen');
  if (!archived && status !== 'active' && status !== 'verifying') out.add('archive');
  if (archived) out.add('unarchive');
  return out;
}

export type GraphAction =
  | 'start'
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'reopen'
  | 'archive'
  | 'unarchive';

/**
 * Attempts made in the node's current activation, for the `k/max` badge. Passing and open
 * attempts are not counted toward `maxAttempts` (concepts §4) but are still attempts.
 */
export function attemptsInActivation(n: {
  status: string;
  kind: string;
  countedAttempts: number;
  activation: number;
  currentAttempt?: { counted: boolean; activation: number; status: string };
}): number {
  const a = n.currentAttempt;
  if (a && a.activation === n.activation && !a.counted) return n.countedAttempts + 1;
  if (!a && n.kind === 'task' && (n.status === 'done' || n.status === 'evaluating'))
    return n.countedAttempts + 1;
  return n.countedAttempts;
}
