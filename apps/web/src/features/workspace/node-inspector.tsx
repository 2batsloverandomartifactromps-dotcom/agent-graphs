/**
 * Node inspector (docs/ui.md §4.4): header with status, key, loop membership and quick actions
 * (pause/resume, retry +N, skip, fail, reopen, complete manually, add directive), and tabs for
 * overview, aims, attempts, notes, directives, activity, briefing and config.
 */
import type { NodeDetail, NodeSummary } from '@agent-graphs/sdk';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import {
  Ban,
  CheckCheck,
  Copy,
  Ellipsis,
  Link2,
  MessageSquarePlus,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  SkipForward,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
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
  Modal,
  Skeleton,
} from '../../components/ui';
import { toastError, useClient } from '../../lib/api';
import { qk, useDirectives, useNode } from '../../lib/queries';
import { allowedNodeActions, attemptsInActivation, type NodeAction } from '../../lib/status';
import type { NodeSearch } from '../../router';
import { DirectiveComposer } from './directives';
import { InspectorDrawer, InspectorTabs } from './inspector-shell';
import {
  ActivityTab,
  AimsTab,
  AttemptsTab,
  BriefingTab,
  ConfigTab,
  DirectivesTab,
  directivesForNode,
  NotesTab,
  OverviewTab,
} from './node-tabs';
import { useWorkspace, withoutTab } from './workspace';

export type NodeTab =
  | 'overview'
  | 'aims'
  | 'attempts'
  | 'notes'
  | 'directives'
  | 'activity'
  | 'briefing'
  | 'config';
const TABS: NodeTab[] = [
  'overview',
  'aims',
  'attempts',
  'notes',
  'directives',
  'activity',
  'briefing',
  'config',
];

export function NodeInspectorRoute() {
  const { node } = useParams({ strict: false }) as { node: string };
  const search = useSearch({ strict: false }) as NodeSearch;
  const navigate = useNavigate();
  const { graph, view } = useWorkspace();
  const tab = (TABS.includes(search.tab as NodeTab) ? search.tab : 'overview') as NodeTab;
  const summary = view.nodes.find((n) => n.key === node);
  if (!summary)
    return (
      <InspectorDrawer label="Node inspector">
        <Empty title="Node not found">No node with key “{node}”.</Empty>
      </InspectorDrawer>
    );
  return (
    <NodeInspector
      graph={graph}
      summary={summary}
      tab={tab}
      onTab={(t) =>
        void navigate({
          to: '.',
          search: (prev) => ({ ...(prev as object), tab: t === 'overview' ? undefined : t }),
          replace: true,
        })
      }
      onClose={() => void navigate({ to: '/graphs/$graph', params: { graph }, search: withoutTab })}
    />
  );
}

type Pending = { action: NodeAction } | null;

function NodeInspector({
  graph,
  summary,
  tab,
  onTab,
  onClose,
}: {
  graph: string;
  summary: NodeSummary;
  tab: NodeTab;
  onTab: (t: NodeTab) => void;
  onClose: () => void;
}) {
  const client = useClient();
  const qc = useQueryClient();
  const { data: detail, isLoading } = useNode(graph, summary.key);
  const { data: directives } = useDirectives(graph);
  const [pending, setPending] = useState<Pending>(null);
  const [directiveOpen, setDirectiveOpen] = useState(false);
  const [completeOpen, setCompleteOpen] = useState(false);
  // Live status comes from the (SSE-patched) summary; config and history from the detail.
  const n: NodeSummary = summary;
  const d: NodeDetail | undefined = detail && detail.key === summary.key ? detail : undefined;
  const allowed = allowedNodeActions(n.status, n.kind);
  const nodeDirectives = d ? directivesForNode(directives ?? [], d) : [];

  const run = async (action: NodeAction, body: Record<string, unknown> = {}) => {
    try {
      await client.nodeAction(graph, n.key, action, body);
      toast.success(`${actionLabel(action)}: ${n.key}`);
      void qc.invalidateQueries({ queryKey: qk.graph(graph) });
      void qc.invalidateQueries({ queryKey: qk.node(graph, n.key) });
    } catch (e) {
      toastError(e, actionLabel(action));
      throw e;
    }
  };

  const loop = n.loop;
  const attemptNo = attemptsInActivation(n);
  const tabs = [
    { id: 'overview' as const, label: 'Overview' },
    {
      id: 'aims' as const,
      label: 'Aims',
      count: n.aims.filter((a) => !a.implicit).length || undefined,
    },
    { id: 'attempts' as const, label: 'Attempts', count: d?.attempts.length || undefined },
    { id: 'notes' as const, label: 'Notes', count: d?.notes.length || undefined },
    { id: 'directives' as const, label: 'Directives', count: nodeDirectives.length || undefined },
    { id: 'activity' as const, label: 'Activity' },
    { id: 'briefing' as const, label: 'Briefing' },
    { id: 'config' as const, label: 'Config' },
  ];

  return (
    <InspectorDrawer label={`Node inspector: ${n.key}`}>
      <div className="ins-head">
        <div className="ins-top">
          <div className="grow">
            <StatusPill status={n.status} {...(n.statusReason ? { title: n.statusReason } : {})} />
            <span className="tag">{n.kind}</span>
            <span className="tag">{n.priority.toUpperCase()}</span>
            {n.acceptedWithDeviation && <span className="tag">accepted with deviation</span>}
            {n.manual && <span className="tag">manual</span>}
          </div>
          <IconButton
            label="Copy link"
            onClick={() => {
              void navigator.clipboard?.writeText(window.location.href);
              toast.success('Link copied');
            }}
          >
            <Link2 size={14} />
          </IconButton>
          <IconButton label="Close inspector (Esc)" onClick={onClose}>
            <X size={14} />
          </IconButton>
        </div>
        <h2 className="ins-title">{n.title}</h2>
        <div className="ins-sub">
          <span className="ins-key">
            {n.key}
            <button
              type="button"
              aria-label="Copy key"
              onClick={() => {
                void navigator.clipboard?.writeText(n.key);
                toast.success('Key copied');
              }}
            >
              <Copy size={12} />
            </button>
          </span>
          {n.kind === 'task' && (
            <span className="chip">
              <RefreshCw />
              attempt {attemptNo}/{n.maxAttempts}
            </span>
          )}
          {loop && (
            <span className="chip loop-on">
              <RefreshCw />
              {loop.key} · iteration {loop.iteration}/{loop.max}
              {n.triggersLoop ? ' · trigger' : ''}
            </span>
          )}
          {n.statusReason && (
            <span className="muted" style={{ fontSize: 12 }}>
              {n.statusReason}
            </span>
          )}
        </div>
        <div className="ins-actions">
          {allowed.has('pause') && (
            <Button size="sm" onClick={() => void run('pause').catch(() => {})}>
              <Pause />
              Pause
            </Button>
          )}
          {allowed.has('resume') && (
            <Button size="sm" onClick={() => void run('resume').catch(() => {})}>
              <Play />
              Resume
            </Button>
          )}
          {allowed.has('retry') && (
            <Button size="sm" onClick={() => setPending({ action: 'retry' })}>
              <RefreshCw />
              Retry
            </Button>
          )}
          {allowed.has('skip') && (
            <Button size="sm" onClick={() => setPending({ action: 'skip' })}>
              <SkipForward />
              Skip
            </Button>
          )}
          <Menu>
            <MenuTrigger asChild>
              <IconButton bordered label="More node actions" style={{ width: 26, height: 26 }}>
                <Ellipsis size={14} />
              </IconButton>
            </MenuTrigger>
            <MenuContent align="start">
              <MenuItem
                disabled={!allowed.has('reopen')}
                onSelect={() => setPending({ action: 'reopen' })}
              >
                <RotateCcw />
                Reopen (cascades)…
              </MenuItem>
              <MenuItem
                disabled={!allowed.has('complete-manually')}
                onSelect={() => setCompleteOpen(true)}
              >
                <CheckCheck />
                Complete manually…
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                danger
                disabled={!allowed.has('fail')}
                onSelect={() => setPending({ action: 'fail' })}
              >
                <Ban />
                Fail node…
              </MenuItem>
            </MenuContent>
          </Menu>
          <Button size="sm" variant="primary" onClick={() => setDirectiveOpen(true)}>
            <MessageSquarePlus />
            Add directive
          </Button>
        </div>
      </div>
      <InspectorTabs tabs={tabs} value={tab} onChange={onTab} />
      <div className="ins-body" role="tabpanel">
        {!d && isLoading ? (
          <div style={{ paddingTop: 14 }}>
            <Skeleton style={{ height: 80 }} />
            <Skeleton style={{ height: 120, marginTop: 12 }} />
          </div>
        ) : !d ? (
          <Empty title="Could not load node details" />
        ) : tab === 'overview' ? (
          <OverviewTab graph={graph} n={n} d={d} />
        ) : tab === 'aims' ? (
          <AimsTab graph={graph} d={d} />
        ) : tab === 'attempts' ? (
          <AttemptsTab d={d} n={n} />
        ) : tab === 'notes' ? (
          <NotesTab graph={graph} d={d} />
        ) : tab === 'directives' ? (
          <DirectivesTab graph={graph} d={d} directives={nodeDirectives} />
        ) : tab === 'activity' ? (
          <ActivityTab graph={graph} d={d} />
        ) : tab === 'briefing' ? (
          <BriefingTab graph={graph} nodeKey={n.key} />
        ) : (
          <ConfigTab graph={graph} d={d} n={n} directives={nodeDirectives} />
        )}
      </div>

      <ConfirmDialog
        open={pending?.action === 'retry'}
        onOpenChange={(o) => !o && setPending(null)}
        title={`Retry ${n.key}`}
        description="Grants more attempts and returns the node to ready, with feedback from earlier attempts."
        confirmLabel="Grant attempts"
        number={{ label: 'Extra attempts', default: 1, min: 1 }}
        onConfirm={({ number }) => run('retry', { extraAttempts: number })}
      />
      <ConfirmDialog
        open={pending?.action === 'skip'}
        onOpenChange={(o) => !o && setPending(null)}
        title={`Skip ${n.key}?`}
        description="The node is not executed; dependants may proceed. An open attempt is cancelled."
        confirmLabel="Skip node"
        destructive
        reason="required"
        onConfirm={({ reason }) => run('skip', { reason })}
      />
      <ConfirmDialog
        open={pending?.action === 'fail'}
        onOpenChange={(o) => !o && setPending(null)}
        title={`Fail ${n.key}?`}
        description="The node becomes failed and an open attempt is cancelled. The graph may stall."
        confirmLabel="Fail node"
        destructive
        reason="required"
        onConfirm={({ reason }) => run('fail', { reason })}
      />
      <ConfirmDialog
        open={pending?.action === 'reopen'}
        onOpenChange={(o) => !o && setPending(null)}
        title={`Reopen ${n.key}?`}
        description="The node and every started descendant return to pending in a new activation; their open attempts are superseded."
        confirmLabel="Reopen"
        reason="optional"
        onConfirm={({ reason }) => run('reopen', reason ? { reason } : {})}
      />
      <CompleteManuallyDialog
        open={completeOpen}
        onOpenChange={setCompleteOpen}
        onConfirm={(summary, url) =>
          run('complete-manually', {
            summary,
            ...(url ? { evidence: [{ kind: 'url', value: url }] } : {}),
          })
        }
      />
      <DirectiveComposer
        open={directiveOpen}
        onOpenChange={setDirectiveOpen}
        graph={graph}
        target={{ type: 'node', key: n.key }}
        targetLabel={`the agent working on ${n.key} (and future attempts)`}
      />
    </InspectorDrawer>
  );
}

function actionLabel(a: NodeAction): string {
  return {
    pause: 'Paused',
    resume: 'Resumed',
    skip: 'Skipped',
    fail: 'Failed',
    retry: 'Retry granted',
    reopen: 'Reopened',
    'complete-manually': 'Completed manually',
  }[a];
}

function CompleteManuallyDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onConfirm: (summary: string, url?: string) => Promise<unknown>;
}) {
  const [summary, setSummary] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Complete manually"
      description="Record work done outside the system. Terminating aims without a verdict are waived with this summary as justification; the audit view marks the node as manual."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={busy || !summary.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm(summary.trim(), url.trim() || undefined);
                setSummary('');
                setUrl('');
                onOpenChange(false);
              } catch {
                // toasted by the caller
              } finally {
                setBusy(false);
              }
            }}
          >
            Mark done
          </Button>
        </>
      }
    >
      <div className="field" style={{ marginTop: 0 }}>
        <label htmlFor="cm-summary">Summary</label>
        <textarea
          id="cm-summary"
          className="textarea prose"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="cm-url">
          Evidence URL <span className="muted">(optional)</span>
        </label>
        <input
          id="cm-url"
          className="input"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://…"
        />
      </div>
    </Modal>
  );
}
