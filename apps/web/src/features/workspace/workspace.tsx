/**
 * Graph workspace (docs/ui.md §4.3): header with status, lifecycle actions, overall aims, spend
 * against guard, progress, and the workspace tabs. Tab content renders in the outlet.
 */
import type { Aim, GraphView } from '@agent-graphs/sdk';
import { useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useParams, useRouterState } from '@tanstack/react-router';
import {
  Archive,
  ArchiveRestore,
  Ban,
  Copy,
  Download,
  Ellipsis,
  Hourglass,
  MessageSquarePlus,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Target,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { GraphAimChip, Legend, Meter, SegBar } from '../../components/display';
import { ExecBadge } from '../../components/exec-badge';
import { StatusPill } from '../../components/status';
import {
  Button,
  ConfirmDialog,
  Empty,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Skeleton,
  Tip,
} from '../../components/ui';
import { toastError, useClient } from '../../lib/api';
import { formatDuration, formatUsd, toMs } from '../../lib/format';
import { qk, useGraph, useNotes } from '../../lib/queries';
import { allowedGraphActions, type GraphAction } from '../../lib/status';
import { cn } from '../../lib/utils';
import type { CanvasSearch } from '../../router';
import { DirectiveComposer } from './directives';

export function useWorkspace(): { graph: string; view: GraphView } {
  const { graph } = useParams({ strict: false }) as { graph: string };
  const { data } = useGraph(graph);
  return { graph, view: data as GraphView };
}

/** Drop the inspector `tab` search param when returning to the plain canvas. */
export function withoutTab(prev: Record<string, unknown>): CanvasSearch {
  const { tab: _tab, ...rest } = prev;
  return rest as CanvasSearch;
}

function budgetAim(view: GraphView): Aim | undefined {
  return view.aims.find(
    (a) => a.metric === 'cost_usd' && (a.comparator === 'lte' || a.comparator === 'lt'),
  );
}

const ACTION_META: Record<GraphAction, { label: string; icon: typeof Play }> = {
  start: { label: 'Start', icon: Play },
  pause: { label: 'Pause', icon: Pause },
  resume: { label: 'Resume', icon: Play },
  cancel: { label: 'Cancel graph', icon: Ban },
  reopen: { label: 'Reopen', icon: RotateCcw },
  archive: { label: 'Archive', icon: Archive },
  unarchive: { label: 'Unarchive', icon: ArchiveRestore },
};

function GraphHeader({ view, graph }: { view: GraphView; graph: string }) {
  const client = useClient();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState<GraphAction | null>(null);
  const [directiveOpen, setDirectiveOpen] = useState(false);
  const g = view.graph;
  const allowed = allowedGraphActions(g.status, Boolean(g.archivedAt));
  const done = (g.counts.done ?? 0) + (g.counts.skipped ?? 0);
  const budget = budgetAim(view);
  const started = toMs(g.startedAt);
  const ended = toMs(g.completedAt);
  const elapsed = started ? (ended ?? Date.now()) - started : undefined;
  const lead = view.orchestrators.find((o) => o.role === 'lead');
  const attachedOrch = view.orchestrators.filter((o) => o.status === 'active').length;
  const activeLoop =
    view.loops.find((l) => l.status === 'active') ??
    view.loops.find((l) => l.status === 'exhausted');
  const otherLoops = view.loops.filter((l) => l !== activeLoop);

  const run = async (action: GraphAction, reason?: string) => {
    try {
      await client.graphAction(graph, action, reason);
      toast.success(`${ACTION_META[action].label} — done`);
      void qc.invalidateQueries({ queryKey: qk.graph(graph) });
      void qc.invalidateQueries({ queryKey: ['graphs'] });
    } catch (e) {
      toastError(e, ACTION_META[action].label);
      throw e;
    }
  };
  const primary: GraphAction | undefined = (['start', 'pause', 'resume', 'reopen'] as const).find(
    (a) => allowed.has(a),
  );
  const PrimaryIcon = primary ? ACTION_META[primary].icon : Play;

  const exportSpec = async () => {
    try {
      const yaml = await client.exportSpec(graph, 'yaml');
      const blob = new Blob([yaml as string], { type: 'text/yaml' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${g.slug ?? g.id}.yaml`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      toastError(e);
    }
  };
  const clone = async () => {
    try {
      const out = await client.cloneGraph(graph, { title: `${g.title} (copy)` });
      toast.success('Cloned as a new draft');
      navigate({ to: '/graphs/$graph', params: { graph: out.graph.slug ?? out.graph.id } });
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <div className="gh">
      <div className="gh-row1">
        <h1 className="gh-title ellipsis" style={{ maxWidth: 420 }} title={g.title}>
          {g.title}
        </h1>
        <StatusPill
          status={g.archivedAt ? 'archived' : g.status}
          label={g.archivedAt ? 'Archived' : undefined}
          lg
        />
        {g.stalled && (
          <Tip content="No node can make progress: a node is blocked, failed or awaiting an escalation decision.">
            <span className="pill st-blocked outline">
              <Hourglass size={13} />
              Stalled
            </span>
          </Tip>
        )}
        {g.pendingApproval && <span className="pill st-needs_input">Plan awaiting approval</span>}
        <span className="gh-meta">
          {started ? (
            <span>
              Started <b>{formatDuration(Date.now() - started)} ago</b>
            </span>
          ) : (
            <span>Not started</span>
          )}
          <span className="sep">·</span>
          <span>
            <b>{g.total}</b> nodes
          </span>
          {lead && (
            <>
              <span className="sep">·</span>
              <span className="row" style={{ gap: 6 }}>
                Lead <ExecBadge x={{ ...lead.executor, kind: 'agent' }} plain />
              </span>
            </>
          )}
        </span>
        <div className="gh-stats">
          <div className="stat-mini">
            <span className="k">Progress</span>
            <span className="v">
              {done}
              <small> / {g.total} done</small>
            </span>
          </div>
          <div className="stat-mini">
            <span className="k">Spend</span>
            <span className="v">
              {formatUsd(g.costUsd)}
              {budget?.target !== undefined && <small> / {formatUsd(budget.target, 0)}</small>}
            </span>
            {budget?.target !== undefined && (
              <Meter
                value={g.costUsd / budget.target}
                cls={
                  g.costUsd > budget.target
                    ? 'st-failed'
                    : g.costUsd > budget.target * 0.8
                      ? 'st-evaluating'
                      : 'st-done'
                }
                label="Spend against budget guard"
              />
            )}
          </div>
          <div className="stat-mini">
            <span className="k">Elapsed</span>
            <span className="v">{elapsed !== undefined ? formatDuration(elapsed) : '—'}</span>
          </div>
          <div className="stat-mini">
            <span className="k">Live agents</span>
            <span className="v">
              {g.agents.length}
              <small> + {attachedOrch} orch.</small>
            </span>
          </div>
        </div>
        <div className="gh-actions">
          {primary && (
            <Button
              size="sm"
              variant={primary === 'start' ? 'primary' : 'default'}
              onClick={() =>
                primary === 'reopen' ? setConfirm('reopen') : void run(primary).catch(() => {})
              }
            >
              <PrimaryIcon />
              {ACTION_META[primary].label}
            </Button>
          )}
          <Menu>
            <MenuTrigger asChild>
              <IconButton bordered label="More graph actions" style={{ width: 26, height: 26 }}>
                <Ellipsis size={14} />
              </IconButton>
            </MenuTrigger>
            <MenuContent>
              <MenuItem onSelect={() => setDirectiveOpen(true)}>
                <MessageSquarePlus />
                Send graph-wide directive
              </MenuItem>
              <MenuItem onSelect={() => void qc.invalidateQueries({ queryKey: qk.graph(graph) })}>
                <RefreshCw />
                Refresh
              </MenuItem>
              <MenuItem onSelect={exportSpec}>
                <Download />
                Export spec (YAML)
              </MenuItem>
              <MenuItem onSelect={clone}>
                <Copy />
                Clone as draft
              </MenuItem>
              <MenuSeparator />
              {(['pause', 'resume', 'archive', 'unarchive'] as const)
                .filter((a) => allowed.has(a) && a !== primary)
                .map((a) => {
                  const Icon = ACTION_META[a].icon;
                  return (
                    <MenuItem key={a} onSelect={() => void run(a).catch(() => {})}>
                      <Icon />
                      {ACTION_META[a].label}
                    </MenuItem>
                  );
                })}
              {allowed.has('cancel') && (
                <MenuItem danger onSelect={() => setConfirm('cancel')}>
                  <Ban />
                  Cancel graph…
                </MenuItem>
              )}
            </MenuContent>
          </Menu>
        </div>
      </div>
      <div className="gh-row2">
        <span className="aims-label">
          <Target size={14} />
          Overall aims
        </span>
        {view.aims.map((a) => (
          <GraphAimChip
            key={a.id}
            aim={a}
            onClick={() => navigate({ to: '/graphs/$graph/aims', params: { graph } })}
          />
        ))}
        {activeLoop && (
          <span
            className="loopchip"
            title={view.loops
              .map(
                (l) =>
                  `${l.key} (${l.from} → ${l.to}) ${l.status}, iteration ${l.iteration} of ${l.maxIterations + l.grantedIterations}`,
              )
              .join('\n')}
          >
            <RefreshCw size={14} />
            <span className="mono">{activeLoop.key}</span>
            {activeLoop.iteration}/{activeLoop.maxIterations + activeLoop.grantedIterations}
            {otherLoops.length > 0 && (
              <span className="idle">
                +{otherLoops.length}{' '}
                {otherLoops.every((l) => l.status === 'idle') ? 'idle' : 'more'}
              </span>
            )}
          </span>
        )}
        {!activeLoop && view.loops.length > 0 && (
          <span
            className="loopchip"
            title={view.loops.map((l) => `${l.key} · ${l.status}`).join('\n')}
          >
            <RefreshCw size={14} />
            {view.loops.length} loop{view.loops.length === 1 ? '' : 's'}
            <span className="idle">
              {view.loops.every((l) => l.status === 'idle')
                ? 'idle'
                : view.loops.map((l) => l.status).join(', ')}
            </span>
          </span>
        )}
      </div>
      <div className="gh-row3">
        <WorkspaceTabs graph={graph} view={view} />
        <div className="gh-prog">
          <span className="pct">
            <b>{Math.round(g.progress * 100)}%</b>
          </span>
          <SegBar counts={g.counts} total={g.total} />
          <Legend counts={g.counts} />
        </div>
      </div>
      <ConfirmDialog
        open={confirm === 'cancel'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Cancel this graph?"
        description="Open attempts are cancelled and no new work can be claimed. The reason is stored in the event log."
        confirmLabel="Cancel graph"
        destructive
        reason="required"
        onConfirm={({ reason }) => run('cancel', reason)}
      />
      <ConfirmDialog
        open={confirm === 'reopen'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Reopen this graph?"
        description="The graph returns to active so nodes can be added or reopened."
        confirmLabel="Reopen"
        reason="optional"
        onConfirm={({ reason }) => run('reopen', reason || undefined)}
      />
      <DirectiveComposer
        open={directiveOpen}
        onOpenChange={setDirectiveOpen}
        graph={graph}
        target={{ type: 'graph' }}
        targetLabel="everyone working in this graph"
      />
    </div>
  );
}

function WorkspaceTabs({ graph, view }: { graph: string; view: GraphView }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const seg = pathname.split('/')[3] ?? '';
  const { data: notes } = useNotes({ graph, limit: 500 });
  const onCanvas = !seg || seg === 'nodes' || seg === 'orchestrators';
  const tabs = [
    { id: 'canvas', label: 'Canvas', to: '/graphs/$graph' as const, on: onCanvas },
    {
      id: 'aims',
      label: 'Aims',
      to: '/graphs/$graph/aims' as const,
      count:
        view.aims.length +
        view.nodes.reduce((a, n) => a + n.aims.filter((x) => !x.implicit).length, 0),
    },
    { id: 'notes', label: 'Notes', to: '/graphs/$graph/notes' as const, count: notes?.length },
    { id: 'activity', label: 'Activity', to: '/graphs/$graph/activity' as const },
    {
      id: 'agents',
      label: 'Agents',
      to: '/graphs/$graph/agents' as const,
      count: view.graph.agents.length || undefined,
    },
    { id: 'spec', label: 'Spec', to: '/graphs/$graph/spec' as const },
    { id: 'settings', label: 'Settings', to: '/graphs/$graph/settings' as const },
  ];
  return (
    <div className="tabs" role="tablist" aria-label="Workspace">
      {tabs.map((t) => {
        const on = t.on ?? seg === t.id;
        return (
          <Link
            key={t.id}
            to={t.to}
            params={{ graph }}
            role="tab"
            aria-selected={on}
            className={cn('tab-link', on && 'on')}
          >
            {t.label}
            {t.count ? <span className="cnt">{t.count}</span> : null}
          </Link>
        );
      })}
    </div>
  );
}

export function GraphWorkspace() {
  const { graph } = useParams({ strict: false }) as { graph: string };
  const { data: view, error, isLoading } = useGraph(graph);
  if (isLoading)
    return (
      <section className="view on gw" aria-busy="true">
        <div className="gh" style={{ paddingBottom: 14 }}>
          <Skeleton style={{ width: 320, height: 24 }} />
          <Skeleton style={{ width: 560, height: 30, marginTop: 12 }} />
        </div>
      </section>
    );
  if (error || !view)
    return (
      <section className="view on page">
        <Empty title="Graph not found">
          {(error as Error | undefined)?.message ?? `No graph '${graph}'.`}
        </Empty>
      </section>
    );
  return (
    <section className="view on gw" aria-label={`Graph workspace: ${view.graph.title}`}>
      <GraphHeader view={view} graph={graph} />
      <div className="gw-body">
        <Outlet />
      </div>
    </section>
  );
}
