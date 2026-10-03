/**
 * Graphs list (docs/ui.md §4.2): saved views as tabs, type-ahead search, sort, a table/card
 * toggle, status-segmented progress, aims chips, agents, and multi-select archive/export.
 */
import type { GraphSummary } from '@agent-graphs/sdk';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Archive, ArrowDown, Download, LayoutGrid, Plus, Rows3, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { SegBar } from '../../components/display';
import { StatusPill } from '../../components/status';
import { Button, Empty, Segmented, Skeleton } from '../../components/ui';
import { toastError, useClient } from '../../lib/api';
import { formatUsd, timeAgo } from '../../lib/format';
import { useGraphs } from '../../lib/queries';
import { cn } from '../../lib/utils';
import { modelInfo, providerClass } from '../../lib/vocab';
import type { GraphsSearch } from '../../router';
import { GraphRow } from '../overview/overview-page';

const VIEWS: Array<{ id: string; label: string; match: (g: GraphSummary) => boolean }> = [
  {
    id: 'active',
    label: 'Active',
    match: (g) => !g.archivedAt && ['active', 'paused', 'verifying'].includes(g.status),
  },
  {
    id: 'attention',
    label: 'Needs attention',
    match: (g) => !g.archivedAt && (g.openRequests > 0 || g.stalled),
  },
  { id: 'completed', label: 'Completed', match: (g) => !g.archivedAt && g.status === 'completed' },
  {
    id: 'failed',
    label: 'Failed',
    match: (g) => !g.archivedAt && (g.status === 'failed' || g.status === 'cancelled'),
  },
  { id: 'drafts', label: 'Drafts', match: (g) => !g.archivedAt && g.status === 'draft' },
  { id: 'archived', label: 'Archived', match: (g) => Boolean(g.archivedAt) },
  { id: 'all', label: 'All', match: (g) => !g.archivedAt },
];

type SortKey = 'activity' | 'title' | 'progress' | 'cost' | 'created';

export function GraphsPage() {
  const search = useSearch({ strict: false }) as GraphsSearch;
  const navigate = useNavigate();
  const client = useClient();
  const qc = useQueryClient();
  const { data, isLoading } = useGraphs({ archived: 'all' });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const viewId = search.view ?? 'all';
  const view = VIEWS.find((v) => v.id === viewId) ?? (VIEWS.at(-1) as (typeof VIEWS)[number]);
  const sort = (search.sort ?? 'activity') as SortKey;
  const q = (search.q ?? '').toLowerCase();
  const rows = useMemo(() => {
    const items = (data ?? []).filter(
      (g) =>
        view.match(g) &&
        (!q ||
          g.title.toLowerCase().includes(q) ||
          (g.slug ?? '').includes(q) ||
          g.tags.some((t) => t.includes(q))),
    );
    const val = (g: GraphSummary): number | string =>
      sort === 'title'
        ? g.title.toLowerCase()
        : sort === 'progress'
          ? -g.progress
          : sort === 'cost'
            ? -g.costUsd
            : sort === 'created'
              ? -Date.parse(g.createdAt)
              : -Date.parse(g.lastActivityAt);
    return items.sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0));
  }, [data, view, q, sort]);
  const setSearch = (patch: Partial<GraphsSearch>) =>
    void navigate({ to: '.', search: (p) => ({ ...(p as object), ...patch }), replace: true });
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const bulkArchive = async () => {
    for (const id of selected) {
      try {
        await client.graphAction(id, 'archive');
      } catch (e) {
        toastError(e, 'Archive');
      }
    }
    toast.success(`Archived ${selected.size} graph${selected.size === 1 ? '' : 's'}`);
    setSelected(new Set());
    void qc.invalidateQueries({ queryKey: ['graphs'] });
  };
  const bulkExport = async () => {
    for (const id of selected) {
      const g = data?.find((x) => x.id === id);
      try {
        const yaml = (await client.exportSpec(id, 'yaml')) as string;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([yaml], { type: 'text/yaml' }));
        a.download = `${g?.slug ?? id}.yaml`;
        a.click();
        URL.revokeObjectURL(a.href);
      } catch (e) {
        toastError(e, 'Export');
      }
    }
  };

  return (
    <section className="view on page" aria-label="Graphs">
      <div className="page-in">
        <div className="page-h">
          <div>
            <h1>Graphs</h1>
            <div className="sub">
              {(data ?? []).filter((g) => !g.archivedAt).length} graphs · plans plus the live record
              of their execution
            </div>
          </div>
          <div className="right">
            <Segmented
              label="Layout"
              value={search.layout ?? 'table'}
              onChange={(v) => setSearch({ layout: v === 'cards' ? 'cards' : undefined })}
              options={[
                { value: 'table', label: <Rows3 size={14} aria-label="Table" /> },
                { value: 'cards', label: <LayoutGrid size={14} aria-label="Cards" /> },
              ]}
            />
            <Button variant="primary" onClick={() => void navigate({ to: '/graphs/new' })}>
              <Plus />
              New graph
            </Button>
          </div>
        </div>
        <div
          className="tabs"
          role="tablist"
          aria-label="Saved views"
          style={{ padding: 0, marginBottom: 12 }}
        >
          {VIEWS.map((v) => {
            const count = (data ?? []).filter(v.match).length;
            return (
              <button
                key={v.id}
                type="button"
                role="tab"
                aria-selected={viewId === v.id}
                className={viewId === v.id ? 'on' : ''}
                onClick={() => setSearch({ view: v.id === 'all' ? undefined : v.id })}
              >
                {v.label}
                {count ? <span className="cnt">{count}</span> : null}
              </button>
            );
          })}
        </div>
        <div className="filters">
          <div className="search" style={{ marginLeft: 0, width: 300 }}>
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
              onChange={(e) => setSearch({ q: e.target.value || undefined })}
              placeholder="Search by title, slug or tag"
              aria-label="Search graphs"
            />
          </div>
          <select
            className="input"
            style={{ width: 170, height: 28 }}
            value={sort}
            onChange={(e) =>
              setSearch({ sort: e.target.value === 'activity' ? undefined : e.target.value })
            }
            aria-label="Sort graphs"
          >
            <option value="activity">Last activity</option>
            <option value="created">Created</option>
            <option value="title">Title</option>
            <option value="progress">Progress</option>
            <option value="cost">Cost</option>
          </select>
          {selected.size > 0 && (
            <>
              <span className="vsep" />
              <span className="muted">{selected.size} selected</span>
              <Button size="sm" onClick={bulkArchive}>
                <Archive />
                Archive
              </Button>
              <Button size="sm" onClick={bulkExport}>
                <Download />
                Export specs
              </Button>
            </>
          )}
        </div>
        {isLoading ? (
          <Skeleton style={{ height: 200 }} />
        ) : rows.length === 0 ? (
          <div className="card">
            <Empty title="No graphs here">
              <Link to="/graphs/new" className="link">
                Create a graph from a spec
              </Link>
            </Empty>
          </div>
        ) : search.layout === 'cards' ? (
          <div className="card">
            {rows.map((g) => (
              <GraphRow key={g.id} g={g} />
            ))}
          </div>
        ) : (
          <div className="card" style={{ overflow: 'hidden' }}>
            <table className="tbl" aria-label="Graphs">
              <thead>
                <tr>
                  <th style={{ width: 32 }}>
                    <input
                      type="checkbox"
                      aria-label="Select all"
                      checked={selected.size > 0 && selected.size === rows.length}
                      onChange={(e) =>
                        setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())
                      }
                    />
                  </th>
                  <th>Graph</th>
                  <th>Progress</th>
                  <th>Aims</th>
                  <th>Running · attention</th>
                  <th>Agents</th>
                  <th>
                    <button type="button" onClick={() => setSearch({ sort: 'cost' })}>
                      Cost {sort === 'cost' && <ArrowDown size={11} />}
                    </button>
                  </th>
                  <th>Started</th>
                  <th>
                    <button type="button" onClick={() => setSearch({ sort: undefined })}>
                      Last activity {sort === 'activity' && <ArrowDown size={11} />}
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((g) => {
                  const ref = g.slug ?? g.id;
                  return (
                    <tr
                      key={g.id}
                      className={cn(selected.has(g.id) && 'sel')}
                      onClick={() =>
                        void navigate({ to: '/graphs/$graph', params: { graph: ref } })
                      }
                      data-testid={`graphs-row-${ref}`}
                    >
                      <td
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          aria-label={`Select ${g.title}`}
                          checked={selected.has(g.id)}
                          onChange={() => toggle(g.id)}
                        />
                      </td>
                      <td>
                        <div className="col" style={{ gap: 3 }}>
                          <div className="row" style={{ gap: 8 }}>
                            <Link
                              to="/graphs/$graph"
                              params={{ graph: ref }}
                              style={{ fontWeight: 600 }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              {g.title}
                            </Link>
                            <StatusPill
                              status={g.archivedAt ? 'archived' : g.status}
                              label={g.archivedAt ? 'Archived' : undefined}
                            />
                            {g.stalled && <span className="pill st-blocked outline">Stalled</span>}
                          </div>
                          <div className="row" style={{ gap: 4 }}>
                            {g.slug && (
                              <span className="mono muted" style={{ fontSize: 11 }}>
                                {g.slug}
                              </span>
                            )}
                            {g.tags.slice(0, 4).map((t) => (
                              <span key={t} className="tag">
                                {t}
                              </span>
                            ))}
                          </div>
                        </div>
                      </td>
                      <td style={{ minWidth: 160 }}>
                        <div className="row" style={{ gap: 8 }}>
                          <SegBar counts={g.counts} total={g.total} className="grow" />
                          <span className="num muted" style={{ fontSize: 12 }}>
                            {Math.round(g.progress * 100)}%
                          </span>
                        </div>
                      </td>
                      <td>
                        <span
                          className={cn(
                            'pill',
                            g.aims.met === g.aims.total && g.aims.total > 0
                              ? 'st-met'
                              : 'st-pending',
                          )}
                        >
                          {g.aims.met}/{g.aims.total} met
                        </span>
                      </td>
                      <td className="num">
                        {g.counts.running ?? 0} ·{' '}
                        <span style={{ color: g.openRequests ? 'var(--s-needs-fg)' : undefined }}>
                          {g.openRequests}
                        </span>
                      </td>
                      <td>
                        <div className="stack">
                          {g.agents.slice(0, 4).map((a) => {
                            const info = modelInfo(a.model, a.provider);
                            return (
                              <span
                                key={a.attemptId}
                                className={cn('mt', providerClass(info.provider))}
                                title={`${a.agent ?? ''} · ${info.name}`}
                              >
                                {info.monogram}
                              </span>
                            );
                          })}
                          {g.agents.length === 0 && <span className="muted">—</span>}
                        </div>
                      </td>
                      <td className="num">{formatUsd(g.costUsd)}</td>
                      <td className="muted">{g.startedAt ? timeAgo(g.startedAt) : '—'}</td>
                      <td className="muted">{timeAgo(g.lastActivityAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
