/**
 * Overview (docs/ui.md §4.1): KPIs with sparklines, the Needs-attention queue, active graph
 * cards, the live activity feed, and models in use (split by provider or mechanism).
 */
import type { GraphSummary, GraphView, HumanRequest, LiveEvent, Session } from '@agent-graphs/sdk';
import { useQueries } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  ChevronRight,
  CircleCheck,
  DollarSign,
  Hand,
  Hourglass,
  Loader,
  Plus,
  Waypoints,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { SegBar, SparkBars, Sparkline } from '../../components/display';
import { ExecBadge, MonoTile } from '../../components/exec-badge';
import { Glyph, StatusIcon, StatusPill } from '../../components/status';
import { Button, Empty, Segmented, Skeleton } from '../../components/ui';
import { useClient } from '../../lib/api';
import { actorName, describeEvent, eventNodeKey } from '../../lib/events';
import { age, formatMetricValue, formatTarget, formatUsd, timeAgo, toMs } from '../../lib/format';
import { useLive } from '../../lib/live';
import { fetchHistory, qk, useGraphs, useRequests, useSessions } from '../../lib/queries';
import { useSettings } from '../../lib/settings';
import { aimMeta, statusMeta } from '../../lib/status';
import { cn } from '../../lib/utils';
import { modelInfo, providerClass } from '../../lib/vocab';
import { KIND_META, sortRequests } from '../inbox/inbox-page';

const WEEK = 7 * 24 * 3_600_000;

/** Samples KPI values while the page is open (the API has no KPI history). */
function useKpiHistory(values: number[]): number[][] {
  const ref = useRef<number[][]>([]);
  const key = values.join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: sample on value change
  useMemo(() => {
    if (values.every((v) => Number.isFinite(v))) {
      ref.current = values.map((v, i) => [...(ref.current[i] ?? []), v].slice(-24));
    }
  }, [key]);
  return ref.current;
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export function OverviewPage() {
  const client = useClient();
  const navigate = useNavigate();
  const { data: graphs, isLoading } = useGraphs({});
  const { data: requests } = useRequests('open');
  const { data: sessions } = useSessions({});
  const actorNameSetting = useSettings((s) => s.actorName);
  const active = (graphs ?? []).filter(
    (g) => g.status === 'active' || g.status === 'paused' || g.status === 'verifying',
  );
  const views = useQueries({
    queries: active.slice(0, 8).map((g) => ({
      queryKey: qk.graph(g.slug ?? g.id),
      queryFn: () => client.getGraph(g.slug ?? g.id),
    })),
  });
  const viewList = views.map((v) => v.data).filter((v): v is GraphView => Boolean(v));
  const running = (graphs ?? []).reduce((a, g) => a + (g.counts.running ?? 0), 0);
  const blocking = (requests ?? []).filter((r) => r.blocking).length;
  const now = Date.now();
  const completedWeek = (graphs ?? []).filter(
    (g) => g.status === 'completed' && (toMs(g.completedAt) ?? 0) > now - WEEK,
  ).length;
  const spend = active.reduce((a, g) => a + g.costUsd, 0);
  const history = useKpiHistory([
    active.length,
    running,
    requests?.length ?? 0,
    completedWeek,
    spend,
  ]);
  const stale = viewList.flatMap((v) =>
    v.nodes
      .filter(
        (n) =>
          n.status === 'running' &&
          n.currentAttempt &&
          now - (toMs(n.currentAttempt.lastHeartbeatAt ?? n.currentAttempt.startedAt) ?? now) >
            600_000,
      )
      .map((n) => ({ graph: v.graph, node: n })),
  );
  const oldest = (requests ?? []).reduce<string | undefined>(
    (m, r) => (!m || r.createdAt < m ? r.createdAt : m),
    undefined,
  );

  return (
    <section className="view on page" aria-label="Overview">
      <div className="page-in">
        <div className="page-h">
          <div>
            <h1>
              {greeting()}, {actorNameSetting}
            </h1>
            <div className="sub">
              {active.length} graph{active.length === 1 ? '' : 's'} running ·{' '}
              {requests?.length ?? 0} thing{requests?.length === 1 ? '' : 's'} need you
            </div>
          </div>
          <div className="right">
            <Button variant="primary" onClick={() => void navigate({ to: '/graphs/new' })}>
              <Plus />
              New graph
            </Button>
          </div>
        </div>
        <div className="kpis">
          <Kpi
            icon={<Waypoints />}
            label="Active graphs"
            value={active.length}
            spark={history[0]}
            sub={`${(graphs ?? []).length} total`}
          />
          <Kpi
            icon={<Loader />}
            label="Running nodes"
            value={running}
            spark={history[1]}
            sub={`across ${active.length} graph${active.length === 1 ? '' : 's'}`}
          />
          <Kpi
            icon={<Hand />}
            label="Needs attention"
            value={requests?.length ?? 0}
            attn={(requests?.length ?? 0) > 0}
            bars={history[2]}
            sub={
              <>
                <span className="warn">{blocking} blocking</span>
                {oldest ? ` · oldest ${age(oldest)}` : ''}
              </>
            }
          />
          <Kpi
            icon={<CircleCheck />}
            label="Completed this week"
            value={completedWeek}
            bars={history[3]}
            sub="graphs completed in 7 days"
          />
          <Kpi
            icon={<DollarSign />}
            label="Active spend"
            value={formatUsd(spend)}
            spark={history[4]}
            sub="reported usage on active graphs"
          />
        </div>
        <div className="ov-grid">
          <div className="ov-col">
            <div className="card">
              <div className="card-h">
                <h3>Active graphs</h3>
                <span className="sub">
                  {active.length} of {(graphs ?? []).length}
                </span>
                <span className="right">
                  <Link to="/graphs" className="btn sm ghost">
                    View all
                    <ChevronRight />
                  </Link>
                </span>
              </div>
              {isLoading ? (
                <Skeleton style={{ height: 120, margin: 16 }} />
              ) : active.length === 0 ? (
                <Empty icon={<Waypoints />} title="No active graphs">
                  <Link to="/graphs/new" className="link">
                    Create one from a spec
                  </Link>
                </Empty>
              ) : (
                active.map((g) => (
                  <GraphRow key={g.id} g={g} view={viewList.find((v) => v.graph.id === g.id)} />
                ))
              )}
            </div>
            <LiveActivity graphs={graphs ?? []} views={viewList} />
          </div>
          <div className="ov-col">
            <AttentionQueue requests={requests ?? []} stale={stale} />
            <ModelsInUse sessions={sessions ?? []} />
          </div>
        </div>
      </div>
    </section>
  );
}

function Kpi({
  icon,
  label,
  value,
  sub,
  spark,
  bars,
  attn,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  sub: React.ReactNode;
  spark?: number[];
  bars?: number[];
  attn?: boolean;
}) {
  return (
    <div className={cn('card kpi', attn && 'attn')}>
      <div className="k">
        {icon}
        {label}
      </div>
      <div className="vrow">
        <span className="v num">{value}</span>
        {spark && spark.length > 1 && <Sparkline values={spark} />}
        {bars && bars.length > 1 && <SparkBars values={bars} />}
      </div>
      <div className="d">{sub}</div>
    </div>
  );
}

export function GraphRow({ g, view }: { g: GraphSummary; view?: GraphView }) {
  const navigate = useNavigate();
  const ref = g.slug ?? g.id;
  const aims = view?.aims.slice(0, 3) ?? [];
  const guard = view?.aims.find((a) => a.metric === 'cost_usd' && a.guard);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a clickable row containing other controls
    <div
      className="grow-item"
      role="link"
      tabIndex={0}
      onClick={() => void navigate({ to: '/graphs/$graph', params: { graph: ref } })}
      onKeyDown={(e) =>
        e.key === 'Enter' && void navigate({ to: '/graphs/$graph', params: { graph: ref } })
      }
      data-testid={`graph-row-${ref}`}
    >
      <div style={{ minWidth: 0 }}>
        <div className="gi-title">
          <span className="name">{g.title}</span>
          <StatusPill status={g.status} />
          {g.stalled && <span className="pill st-blocked outline">Stalled</span>}
        </div>
        <div className="gi-meta">
          <span>{g.total} nodes</span>
          <span className="sep">·</span>
          <span>{g.startedAt ? `started ${timeAgo(g.startedAt)}` : 'not started'}</span>
          <span className="sep">·</span>
          <span>
            {(g.counts.done ?? 0) + (g.counts.skipped ?? 0)}/{g.total} done
          </span>
        </div>
        <div className="gi-bar">
          <SegBar counts={g.counts} total={g.total} />
          <span className="pc">{Math.round(g.progress * 100)}%</span>
        </div>
      </div>
      <div className="gi-aims">
        {aims.length === 0 && (
          <div className="ar">
            <span className="muted">
              {g.aims.met}/{g.aims.total} aims met
            </span>
          </div>
        )}
        {aims.map((a) => {
          const m = aimMeta(a.status);
          return (
            <div key={a.id} className={cn('ar', m.cls)} title={`${a.title} — ${m.label}`}>
              <Glyph name={m.icon} />
              <span className="ellipsis">{a.title}</span>
              {a.kind === 'quantitative' && (
                <span className="mono">
                  {formatMetricValue(a.currentValue, a)}/{formatTarget(a)}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="gi-agents">
        <div className="stack" role="img" aria-label={`${g.agents.length} live agents`}>
          {g.agents.slice(0, 5).map((a) => {
            const info = modelInfo(a.model, a.provider);
            return (
              <span
                key={a.attemptId}
                className={cn('mt', providerClass(info.provider))}
                title={`${a.agent ?? info.name} · ${info.name} · ${a.nodeKey ?? ''}`}
              >
                {info.monogram}
                <span className="rd" />
              </span>
            );
          })}
        </div>
        <span className="lbl">
          {g.agents.length} running ·{' '}
          {view?.orchestrators.filter((o) => o.status === 'active').length ?? 0} orch.
        </span>
        <span className="spend">
          <b>{formatUsd(g.costUsd)}</b>
          {guard?.target !== undefined ? ` / ${formatUsd(guard.target, 0)}` : ''}
        </span>
      </div>
    </div>
  );
}

function AttentionQueue({
  requests,
  stale,
}: {
  requests: HumanRequest[];
  stale: Array<{ graph: GraphView['graph']; node: GraphView['nodes'][number] }>;
}) {
  const sorted = sortRequests(requests);
  return (
    <div className="card">
      <div className="card-h">
        <h3>Needs attention</h3>
        <span className="tag" style={{ color: 'var(--s-needs-fg)' }}>
          {requests.length + stale.length}
        </span>
        <span className="right">
          <Link to="/inbox" className="btn sm ghost">
            Open inbox
            <ChevronRight />
          </Link>
        </span>
      </div>
      {sorted.length === 0 && stale.length === 0 && (
        <Empty title="Nothing needs you">Approvals, escalations and blockers show up here.</Empty>
      )}
      {sorted.slice(0, 8).map((r) => {
        const m = KIND_META[r.kind] ?? (KIND_META.approval as (typeof KIND_META)['approval']);
        return (
          <div key={r.id} className={cn('att-item', m.cls)}>
            <span className="kind-ico">
              <m.icon />
            </span>
            <div className="body">
              <div className="t">{r.title}</div>
              <div className="m">
                {r.blocking && <span className="blocking">Blocking</span>}
                <span>{m.label}</span>
                <span className="sep">·</span>
                <span className="ellipsis">{r.graph?.title}</span>
              </div>
            </div>
            <div className="act-r">
              <Link to="/inbox" className="btn sm">
                {r.kind === 'approval'
                  ? 'Review'
                  : r.kind === 'question'
                    ? 'Answer'
                    : r.kind === 'blocker'
                      ? 'Unblock'
                      : 'Decide'}
              </Link>
              <span className="age">{age(r.createdAt)} ago</span>
            </div>
          </div>
        );
      })}
      {stale.map(({ graph, node }) => (
        <div key={node.id} className="att-item st-evaluating">
          <span className="kind-ico">
            <Hourglass />
          </span>
          <div className="body">
            <div className="t">
              Stale lease — no heartbeat for{' '}
              {age(node.currentAttempt?.lastHeartbeatAt ?? node.currentAttempt?.startedAt)}
            </div>
            <div className="m">
              <span>Stale lease</span>
              <span className="sep">·</span>
              <span className="mono">{node.key}</span>
            </div>
          </div>
          <div className="act-r">
            <Link
              to="/graphs/$graph/nodes/$node"
              params={{ graph: graph.slug ?? graph.id, node: node.key }}
              className="btn sm"
            >
              Inspect
            </Link>
          </div>
        </div>
      ))}
    </div>
  );
}

function LiveActivity({ graphs, views }: { graphs: GraphSummary[]; views: GraphView[] }) {
  const client = useClient();
  const live = useLive((s) => s.events);
  // Backfill from each active graph's history so the feed is not empty on first load.
  const histories = useQueries({
    queries: views.map((v) => ({
      queryKey: qk.events(v.graph.slug ?? v.graph.id),
      queryFn: () => fetchHistory(client, v.graph.slug ?? v.graph.id),
      staleTime: 60_000,
    })),
  });
  const events = useMemo(() => {
    const seen = new Set<number>();
    const all: LiveEvent[] = [];
    for (const e of live) {
      seen.add(e.seq);
      all.push(e);
    }
    for (const h of histories)
      for (const e of (h.data ?? []).slice(0, 60))
        if (!seen.has(e.seq)) {
          seen.add(e.seq);
          all.push({ ...e, entity: { type: e.entityType, id: e.entityId } });
        }
    return all.sort((a, b) => b.seq - a.seq);
  }, [live, histories]);
  const [filter, setFilter] = useState<'all' | 'agents' | 'humans'>('all');
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const keyOf = (id: string) => {
    for (const v of views) {
      const n = v.nodes.find((x) => x.id === id);
      if (n) return n.key;
    }
    return undefined;
  };
  const titleOf = (id: string | null) => graphs.find((g) => g.id === id)?.title;
  const rows = events
    .filter((e) => describeEvent(e as never, keyOf).significant)
    .filter(
      (e) =>
        filter === 'all' ||
        (filter === 'humans' ? e.actor.kind === 'human' : e.actor.kind !== 'human'),
    )
    .slice(0, 12);
  return (
    <div className="card">
      <div className="card-h">
        <h3>Live activity</h3>
        <span className="live" style={{ height: 22, fontSize: 11 }}>
          <span className="pulse" />
          streaming
        </span>
        <span className="right">
          <Segmented
            label="Filter activity"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All' },
              { value: 'agents', label: 'Agents' },
              { value: 'humans', label: 'Humans' },
            ]}
          />
        </span>
      </div>
      {rows.length === 0 && (
        <Empty title="Waiting for activity">
          Significant events stream in here as agents work.
        </Empty>
      )}
      {rows.map((e: LiveEvent) => {
        const d = describeEvent(e as never, keyOf);
        const tone = d.tone.startsWith('st-') ? d.tone : 'st-pending';
        const target = d.target ?? eventNodeKey(e as never, keyOf);
        return (
          <div key={e.seq} className="feed-row new">
            <span className={cn('sicon', tone)}>
              <Glyph name={statusMeta(tone.replace('st-', '')).icon} />
            </span>
            <span className="what">
              <span className="who">{actorName(e.actor)}</span>
              {e.actor.kind !== 'system' && (e.actor.model || e.actor.kind === 'human') && (
                <ExecBadge x={e.actor} />
              )}
              <span>{d.verb}</span>
              {target && <span className="tgt">{target}</span>}
              {d.detail ? (
                <span className="ellipsis">{d.detail}</span>
              ) : (
                <span className="ellipsis">{titleOf(e.graphId)}</span>
              )}
            </span>
            <span className="when">{age(e.createdAt)}</span>
          </div>
        );
      })}
    </div>
  );
}

function ModelsInUse({ sessions }: { sessions: Session[] }) {
  const [split, setSplit] = useState<'mechanism' | 'provider'>('mechanism');
  const agents = sessions.filter((s) => s.kind !== 'human' && s.model);
  const byModel = new Map<string, Map<string, number>>();
  for (const s of agents) {
    const m = byModel.get(s.model as string) ?? new Map<string, number>();
    const k = (split === 'mechanism' ? s.mechanism : s.provider) ?? 'other';
    m.set(k, (m.get(k) ?? 0) + 1);
    byModel.set(s.model as string, m);
  }
  const segments = [
    ...new Set(agents.map((s) => (split === 'mechanism' ? s.mechanism : s.provider) ?? 'other')),
  ];
  const cat = (k: string) => `var(--cat-${(segments.indexOf(k) % 4) + 1})`;
  const rows = [...byModel.entries()]
    .map(([model, m]) => ({ model, m, total: [...m.values()].reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.total - a.total);
  const max = Math.max(1, ...rows.map((r) => r.total));
  return (
    <div className="card">
      <div className="card-h">
        <h3>Models in use</h3>
        <span className="right">
          <Segmented
            label="Split models by"
            value={split}
            onChange={setSplit}
            options={[
              { value: 'mechanism', label: 'Mechanism' },
              { value: 'provider', label: 'Provider' },
            ]}
          />
        </span>
      </div>
      {rows.length === 0 ? (
        <Empty title="No agent sessions yet" />
      ) : (
        <>
          <div className="mbars">
            {rows.map((r) => (
              <div key={r.model} className="mbar">
                <span className="nm">
                  <MonoTile x={{ kind: 'agent', model: r.model }} />
                  <span className="ellipsis">{modelInfo(r.model, undefined).name}</span>
                </span>
                <span
                  className="track"
                  style={{ width: `${(r.total / max) * 100}%` }}
                  role="img"
                  aria-label={`${r.total} sessions: ${[...r.m.entries()].map(([k, v]) => `${v} ${k}`).join(', ')}`}
                >
                  {[...r.m.entries()].map(([k, v]) => (
                    <i
                      key={k}
                      style={{ flex: v, ['--c' as string]: cat(k) }}
                      title={`${v} × ${k}`}
                    />
                  ))}
                </span>
                <span className="val">{r.total}</span>
              </div>
            ))}
          </div>
          <div className="mlegend">
            {segments.map((k) => (
              <span key={k}>
                <i style={{ ['--c' as string]: cat(k) }} />
                {k}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export { StatusIcon };
