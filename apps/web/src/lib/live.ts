/**
 * Live updates (docs/ui.md §8): one SSE subscription feeds the Query cache. Snapshots patch
 * GraphViews, graph lists and the inbox in place; everything else is invalidated (debounced).
 */
import type { GraphSummary, GraphView, HumanRequest, LiveEvent } from '@agent-graphs/sdk';
import type { QueryClient } from '@tanstack/react-query';
import { create } from 'zustand';
import {
  patchGraphList,
  patchGraphView,
  patchOpenRequests,
  REFETCH,
  touchedNodeIds,
} from './cache-patch';

export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

type LiveState = {
  status: LiveStatus;
  events: LiveEvent[];
  /** Node id → time of last change (for the 600 ms highlight). */
  touched: Record<string, number>;
  lastEventAt?: number;
  setStatus: (s: LiveStatus) => void;
  push: (e: LiveEvent, touched: string[]) => void;
};

const MAX_EVENTS = 300;

export const useLive = create<LiveState>()((set) => ({
  status: 'connecting',
  events: [],
  touched: {},
  setStatus: (status) => set((s) => (s.status === status ? s : { status })),
  push: (e, ids) =>
    set((s) => {
      const now = Date.now();
      const touched = ids.length ? { ...s.touched } : s.touched;
      for (const id of ids) touched[id] = now;
      return {
        events: [e, ...s.events].slice(0, MAX_EVENTS),
        touched,
        lastEventAt: now,
        status: 'live',
      };
    }),
}));

/** Query families invalidated (debounced) by any graph event. */
const GRAPH_FAMILIES = [
  'graphs',
  'node',
  'events',
  'directives',
  'stats',
  'queue',
  'aims',
  'metrics',
  'audit',
  'audit-gaps',
];

export function createLiveHandler(qc: QueryClient, onEvent?: (e: LiveEvent) => void) {
  const pending = new Set<string>();
  // Snapshots keep views live instantly; a debounced refetch reconciles server-derived fields
  // (cost, aims, loop counters) that snapshots of other entities cannot express.
  const reconcile = new Map<string, ReturnType<typeof setTimeout>>();
  const scheduleReconcile = (key: readonly unknown[]) => {
    const id = JSON.stringify(key);
    if (reconcile.has(id)) return;
    reconcile.set(
      id,
      setTimeout(() => {
        reconcile.delete(id);
        void qc.invalidateQueries({ queryKey: key, exact: true });
      }, 1500),
    );
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const invalidate = (family: string) => {
    pending.add(family);
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      const families = [...pending];
      pending.clear();
      for (const f of families) void qc.invalidateQueries({ queryKey: [f] });
    }, 250);
  };

  return (event: LiveEvent) => {
    let touched: string[] = [];
    // Graph views (keyed by id or slug).
    for (const [key, view] of qc.getQueriesData<GraphView>({ queryKey: ['graph'] })) {
      if (!view || view.graph.id !== event.graphId) continue;
      const out = patchGraphView(view, event);
      if (out === REFETCH) void qc.invalidateQueries({ queryKey: key, exact: true });
      else if (out) {
        qc.setQueryData(key, out);
        scheduleReconcile(key);
      }
      touched = touchedNodeIds(view, event);
    }
    // Graph lists.
    for (const [key, items] of qc.getQueriesData<GraphSummary[]>({ queryKey: ['graphs'] })) {
      if (!items) continue;
      const out = patchGraphList(items, event);
      if (out === REFETCH) invalidate('graphs');
      else if (out) qc.setQueryData(key, out);
    }
    // Inbox.
    if (event.entity.type === 'request') {
      const key = ['requests', 'open'];
      const items = qc.getQueryData<HumanRequest[]>(key);
      const out = items ? patchOpenRequests(items, event) : REFETCH;
      if (out === REFETCH) void qc.invalidateQueries({ queryKey: key, exact: true });
      else if (out) qc.setQueryData(key, out);
      for (const status of ['resolved', 'dismissed'])
        void qc.invalidateQueries({ queryKey: ['requests', status], exact: true });
    }
    if (event.graphId) for (const f of GRAPH_FAMILIES) invalidate(f);
    if (event.type.startsWith('note.')) invalidate('notes');
    if (event.type.startsWith('session.') || event.type === 'attempt.claimed')
      invalidate('sessions');
    if (
      event.type.startsWith('graph.') ||
      event.type.startsWith('node.') ||
      event.type.startsWith('edge.') ||
      event.type.startsWith('loop.')
    )
      invalidate('spec');
    if (event.entity.type === 'node' || event.type.startsWith('directive.')) invalidate('briefing');
    useLive.getState().push(event, touched);
    onEvent?.(event);
  };
}
