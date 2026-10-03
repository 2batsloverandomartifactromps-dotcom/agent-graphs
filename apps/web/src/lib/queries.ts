/** Query keys and hooks over the SDK (TanStack Query). Graph refs are ids or slugs. */
import type { AgentGraphsClient, StoredEvent } from '@agent-graphs/sdk';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useClient } from './api';

export type GraphFilters = {
  status?: string;
  archived?: 'true' | 'false' | 'all';
  q?: string;
  stalled?: 'true' | 'false';
  sort?: string;
};
export type NotesQuery = Parameters<AgentGraphsClient['notes']>[0];

export const qk = {
  graphs: (f: GraphFilters = {}) => ['graphs', f] as const,
  graph: (g: string) => ['graph', g] as const,
  node: (g: string, key: string) => ['node', g, key] as const,
  requests: (status: string) => ['requests', status] as const,
  vocab: ['vocab'] as const,
  me: ['me'] as const,
  health: ['health'] as const,
  notes: (q: NotesQuery) => ['notes', q] as const,
  events: (g: string) => ['events', g] as const,
  directives: (g: string) => ['directives', g] as const,
  spec: (g: string) => ['spec', g] as const,
  stats: (g: string) => ['stats', g] as const,
  sessions: (q: { status?: string; graph?: string } = {}) => ['sessions', q] as const,
  briefing: (g: string, key: string, budget: number) => ['briefing', g, key, budget] as const,
  queue: (g: string, orch: string) => ['queue', g, orch] as const,
  audit: (g: string) => ['audit', g] as const,
  auditGaps: (g: string) => ['audit-gaps', g] as const,
  aims: (g: string) => ['aims', g] as const,
  metrics: (g: string, node?: string) => ['metrics', g, node ?? ''] as const,
};

export function useGraphs(filters: GraphFilters = {}) {
  const client = useClient();
  return useQuery({
    queryKey: qk.graphs(filters),
    queryFn: () => client.listGraphs(filters).then((r) => r.items),
    placeholderData: keepPreviousData,
  });
}

export function useGraph(graph: string | undefined) {
  const client = useClient();
  return useQuery({
    queryKey: qk.graph(graph ?? ''),
    queryFn: () => client.getGraph(graph as string),
    enabled: Boolean(graph),
  });
}

export function useNode(graph: string, key: string | undefined) {
  const client = useClient();
  return useQuery({
    queryKey: qk.node(graph, key ?? ''),
    queryFn: () => client.getNode(graph, key as string),
    enabled: Boolean(key),
    placeholderData: keepPreviousData,
  });
}

export function useRequests(status = 'open') {
  const client = useClient();
  return useQuery({
    queryKey: qk.requests(status),
    queryFn: () => client.requests({ status }).then((r) => r.items),
  });
}

export function useVocab() {
  const client = useClient();
  return useQuery({ queryKey: qk.vocab, queryFn: () => client.vocab(), staleTime: 5 * 60_000 });
}

export function useMe() {
  const client = useClient();
  return useQuery({ queryKey: qk.me, queryFn: () => client.me(), staleTime: 60_000, retry: false });
}

export function useNotes(query: NotesQuery) {
  const client = useClient();
  return useQuery({
    queryKey: qk.notes(query),
    queryFn: () => client.notes(query).then((r) => r.items),
    placeholderData: keepPreviousData,
  });
}

/**
 * Full event history of a graph, newest first. The endpoint pages ascending by seq and applies
 * its filters after the page limit, so page through unfiltered history and filter client-side.
 */
export async function fetchHistory(
  client: AgentGraphsClient,
  graph: string,
): Promise<StoredEvent[]> {
  const PAGE = 1000;
  let items: StoredEvent[] = [];
  let after = 0;
  for (let i = 0; i < 20; i++) {
    const page = await client.events(graph, { after, limit: PAGE });
    items = items.concat(page.items);
    if (page.items.length < PAGE || page.nextCursor === null) break;
    after = page.nextCursor;
  }
  return items.reverse();
}

export function filterEvents(
  items: StoredEvent[],
  filter: { types?: string; entity?: string; limit?: number },
): StoredEvent[] {
  const types = filter.types ? new Set(filter.types.split(',')) : undefined;
  return items
    .filter(
      (e) =>
        (!types || types.has(e.type) || types.has(`${e.type.split('.')[0]}.*`)) &&
        (!filter.entity || e.entityId === filter.entity),
    )
    .slice(0, filter.limit ?? 300);
}

export function useEvents(
  graph: string,
  filter: { types?: string; entity?: string; limit?: number } = {},
) {
  const client = useClient();
  return useQuery({
    queryKey: qk.events(graph),
    queryFn: () => fetchHistory(client, graph),
    select: (items) => filterEvents(items, filter),
  });
}

export function useDirectives(graph: string) {
  const client = useClient();
  return useQuery({
    queryKey: qk.directives(graph),
    queryFn: () => client.directives(graph).then((r) => r.items),
  });
}

export function useSessions(query: { status?: string; graph?: string } = {}) {
  const client = useClient();
  return useQuery({
    queryKey: qk.sessions(query),
    queryFn: () => client.sessions(query).then((r) => r.items),
  });
}

export function useStats(graph: string | undefined) {
  const client = useClient();
  return useQuery({
    queryKey: qk.stats(graph ?? ''),
    queryFn: () => client.stats(graph as string),
    enabled: Boolean(graph),
  });
}
