/**
 * Notes explorer (docs/ui.md §2): cross-graph search and filters (type, severity, model,
 * provider, mechanism, graph, node, time). The list is virtualized.
 */
import { FINDING_SEVERITIES, MECHANISMS, NOTE_TYPES, PROVIDERS } from '@agent-graphs/core';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Search } from 'lucide-react';
import { useRef } from 'react';
import { NoteCard } from '../../components/display';
import { Empty, Skeleton } from '../../components/ui';
import { useGraphs, useNotes, useVocab } from '../../lib/queries';
import type { NotesSearch } from '../../router';

const SINCE: Record<string, number> = { '1h': 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000 };

export function NotesPage() {
  const search = useSearch({ strict: false }) as NotesSearch;
  const navigate = useNavigate();
  const { data: graphs } = useGraphs({ archived: 'all' });
  const { data: vocab } = useVocab();
  const since =
    search.since && SINCE[search.since]
      ? new Date(Date.now() - (SINCE[search.since] as number)).toISOString()
      : undefined;
  const { data, isLoading } = useNotes({
    ...(search.q ? { q: search.q } : {}),
    ...(search.type ? { type: search.type } : {}),
    ...(search.severity ? { severity: search.severity } : {}),
    ...(search.model ? { model: search.model } : {}),
    ...(search.provider ? { provider: search.provider } : {}),
    ...(search.mechanism ? { mechanism: search.mechanism } : {}),
    ...(search.graph ? { graph: search.graph } : {}),
    ...(search.graph && search.node ? { node: search.node } : {}),
    ...(since ? { since } : {}),
    limit: 500,
  });
  const set = (patch: Partial<NotesSearch>) =>
    void navigate({ to: '.', search: (p) => ({ ...(p as object), ...patch }), replace: true });
  const graphTitle = (id: string) => graphs?.find((g) => g.id === id);
  const parentRef = useRef<HTMLDivElement>(null);
  const notes = data ?? [];
  const virtualizer = useVirtualizer({
    count: notes.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 150,
    overscan: 6,
  });
  const select = (label: string, key: keyof NotesSearch, options: readonly string[]) => (
    <select
      className="input fsel"
      style={{ maxWidth: 128 }}
      value={search[key] ?? ''}
      onChange={(e) => set({ [key]: e.target.value || undefined })}
      aria-label={label}
    >
      <option value="">{label}</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );

  return (
    <section className="view on page" aria-label="Notes explorer" ref={parentRef}>
      <div className="page-in">
        <div className="page-h">
          <div>
            <h1>Notes</h1>
            <div className="sub">
              Proofs, deliverables, findings, decisions and handoffs across every graph.
            </div>
          </div>
        </div>
        <div className="filters">
          <div className="search" style={{ marginLeft: 0, width: 240 }}>
            <Search size={14} />
            <input
              className="grow"
              style={{
                background: 'transparent',
                border: 0,
                outline: 'none',
                color: 'var(--text)',
              }}
              value={search.q ?? ''}
              onChange={(e) => set({ q: e.target.value || undefined })}
              placeholder="Full-text search"
              aria-label="Search notes"
            />
          </div>
          {select('Type', 'type', NOTE_TYPES)}
          {select('Severity', 'severity', FINDING_SEVERITIES)}
          {select('Model', 'model', vocab?.models.map((m) => m.id) ?? [])}
          {select('Provider', 'provider', PROVIDERS)}
          {select('Mechanism', 'mechanism', MECHANISMS)}
          <select
            className="input fsel"
            style={{ maxWidth: 170 }}
            value={search.graph ?? ''}
            onChange={(e) => set({ graph: e.target.value || undefined, node: undefined })}
            aria-label="Graph"
          >
            <option value="">All graphs</option>
            {graphs?.map((g) => (
              <option key={g.id} value={g.slug ?? g.id}>
                {g.title}
              </option>
            ))}
          </select>
          {search.graph && (
            <input
              className="input mono"
              style={{ width: 150, height: 28 }}
              placeholder="node key"
              value={search.node ?? ''}
              onChange={(e) => set({ node: e.target.value || undefined })}
              aria-label="Node key"
            />
          )}
          <select
            className="input fsel"
            value={search.since ?? ''}
            onChange={(e) => set({ since: e.target.value || undefined })}
            aria-label="Time range"
          >
            <option value="">Any time</option>
            <option value="1h">Last hour</option>
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
          </select>
          <span className="muted" style={{ marginLeft: 'auto' }}>
            {notes.length} note{notes.length === 1 ? '' : 's'}
          </span>
        </div>
        {isLoading ? (
          <Skeleton style={{ height: 240 }} />
        ) : notes.length === 0 ? (
          <div className="card">
            <Empty title="No notes match these filters" />
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((item) => {
              const n = notes[item.index];
              if (!n) return null;
              const g = graphTitle(n.graphId);
              return (
                <div
                  key={n.id}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    transform: `translateY(${item.start}px)`,
                    paddingBottom: 2,
                  }}
                >
                  <NoteCard
                    note={n}
                    context={
                      g ? (
                        <Link
                          to="/graphs/$graph/notes"
                          params={{ graph: g.slug ?? g.id }}
                          className="tag"
                        >
                          {g.title}
                        </Link>
                      ) : undefined
                    }
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
