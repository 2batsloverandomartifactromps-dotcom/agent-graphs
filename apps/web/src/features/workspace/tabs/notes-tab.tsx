/**
 * Graph Notes tab (docs/ui.md §4.3): every note with facets (type, severity, model, provider,
 * mechanism, node) and an Audit toggle listing gaps.
 */
import type { Note } from '@agent-graphs/sdk';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { ShieldAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { NoteThread } from '../../../components/display';
import { Button, Empty, Skeleton } from '../../../components/ui';
import { useClient } from '../../../lib/api';
import { qk, useNotes } from '../../../lib/queries';
import { cn } from '../../../lib/utils';
import type { TabSearch } from '../../../router';
import { useWorkspace } from '../workspace';

const FACETS = ['type', 'severity', 'model', 'provider', 'mechanism'] as const;

function facetValue(n: Note, f: (typeof FACETS)[number]): string | undefined {
  if (f === 'type') return n.type;
  if (f === 'severity') return n.severity;
  return n.author[f];
}

export function NotesTab() {
  const { graph, view } = useWorkspace();
  const search = useSearch({ strict: false }) as TabSearch & Record<string, string | undefined>;
  const navigate = useNavigate();
  const { data, isLoading } = useNotes({ graph, limit: 500 });
  const [limit, setLimit] = useState(150);
  const keyOf = useMemo(() => new Map(view.nodes.map((n) => [n.id, n.key])), [view.nodes]);
  const active: Record<string, string | undefined> = Object.fromEntries(
    FACETS.map((f) => [f, search[f]]),
  );
  const notes = (data ?? []).filter(
    (n) =>
      FACETS.every((f) => !active[f] || facetValue(n, f) === active[f]) &&
      (!search.node || keyOf.get(n.nodeId ?? '') === search.node),
  );
  const facetOptions = (f: (typeof FACETS)[number]) => {
    const counts = new Map<string, number>();
    for (const n of data ?? []) {
      const v = facetValue(n, f);
      if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  };
  const setFacet = (k: string, v: string | undefined) =>
    void navigate({ to: '.', search: (p) => ({ ...(p as object), [k]: v }), replace: true });

  return (
    <div className="page">
      <div
        className="page-in full"
        style={{ display: 'grid', gridTemplateColumns: '220px minmax(0, 1fr)', gap: 20 }}
      >
        <aside aria-label="Note facets" className="col" style={{ gap: 14 }}>
          <button
            type="button"
            className={cn('fchip', search.audit && 'on')}
            onClick={() => setFacet('audit', search.audit ? undefined : 'true')}
            aria-pressed={Boolean(search.audit)}
          >
            <ShieldAlert />
            Audit gaps
          </button>
          {FACETS.map((f) => (
            <div key={f}>
              <div className="eyebrow" style={{ marginBottom: 6 }}>
                {f}
              </div>
              <div className="col" style={{ gap: 2 }}>
                {facetOptions(f).map(([v, c]) => (
                  <button
                    key={v}
                    type="button"
                    className={cn('menu-item', active[f] === v && 'on')}
                    style={active[f] === v ? { background: 'var(--card-2)' } : undefined}
                    onClick={() => setFacet(f, active[f] === v ? undefined : v)}
                    aria-pressed={active[f] === v}
                  >
                    <span className="ellipsis">{v}</span>
                    <span className="muted num" style={{ marginLeft: 'auto' }}>
                      {c}
                    </span>
                  </button>
                ))}
                {facetOptions(f).length === 0 && (
                  <span className="muted" style={{ fontSize: 12 }}>
                    —
                  </span>
                )}
              </div>
            </div>
          ))}
          <div>
            <div className="eyebrow" style={{ marginBottom: 6 }}>
              node
            </div>
            <select
              className="input"
              value={search.node ?? ''}
              onChange={(e) => setFacet('node', e.target.value || undefined)}
              aria-label="Filter by node"
            >
              <option value="">All nodes</option>
              {view.nodes.map((n) => (
                <option key={n.id} value={n.key}>
                  {n.key}
                </option>
              ))}
            </select>
          </div>
        </aside>
        <div style={{ minWidth: 0 }}>
          {search.audit && <AuditGaps graph={graph} />}
          <div className="row" style={{ marginBottom: 4 }}>
            <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
              {notes.length} note{notes.length === 1 ? '' : 's'}
            </h2>
          </div>
          {isLoading ? (
            <Skeleton style={{ height: 160 }} />
          ) : notes.length === 0 ? (
            <Empty title="No notes match">
              Agents post proofs, deliverables, findings and handoffs as they work.
            </Empty>
          ) : (
            <>
              <NoteThread
                notes={notes.slice(0, limit)}
                context={(n) =>
                  n.nodeId ? (
                    <Link
                      to="/graphs/$graph/nodes/$node"
                      params={{ graph, node: keyOf.get(n.nodeId) ?? '' }}
                      search={{ tab: 'notes' }}
                      className="tag mono"
                    >
                      {keyOf.get(n.nodeId)}
                    </Link>
                  ) : (
                    <span className="tag">graph</span>
                  )
                }
              />
              {notes.length > limit && (
                <div className="row" style={{ justifyContent: 'center', marginTop: 12 }}>
                  <Button size="sm" onClick={() => setLimit((l) => l + 150)}>
                    Show more
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function AuditGaps({ graph }: { graph: string }) {
  const client = useClient();
  const { data } = useQuery({
    queryKey: qk.auditGaps(graph),
    queryFn: () => client.auditGaps(graph),
  });
  if (!data) return <Skeleton style={{ height: 80, marginBottom: 12 }} />;
  const rows: Array<[string, string[]]> = [
    ['Done without proof', data.doneWithoutProof],
    ['Accepted with deviation', data.acceptedWithDeviation],
    ['Manual completions', data.manualCompletions],
    ['Waived aims', data.waivedAims.map((w) => `${w.key ?? w.aimId}: ${w.rationale ?? ''}`)],
    ['Open high-severity findings', data.openHighFindings.map((f) => f.title)],
  ];
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-h">
        <h3>Audit gaps</h3>
        {data.graphAcceptedWithDeviation && (
          <span className="tag">graph accepted with deviation</span>
        )}
      </div>
      <div className="card-b col" style={{ gap: 8 }}>
        {rows.map(([label, items]) => (
          <div key={label} className="row" style={{ alignItems: 'flex-start', gap: 10 }}>
            <span
              className={cn('pill', items.length ? 'st-needs_input' : 'st-done')}
              style={{ minWidth: 34, justifyContent: 'center' }}
            >
              {items.length}
            </span>
            <div className="col" style={{ gap: 2 }}>
              <b style={{ fontWeight: 500 }}>{label}</b>
              {items.length > 0 && (
                <span className="muted mono" style={{ fontSize: 11.5 }}>
                  {items.join(' · ')}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
