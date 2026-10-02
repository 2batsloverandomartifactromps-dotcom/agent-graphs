/** Node inspector tab bodies (docs/ui.md §4.4). */
import type {
  Aim,
  Attempt,
  Directive,
  Evaluation,
  MetricReport,
  NodeDetail,
  NodeSummary,
} from '@agent-graphs/sdk';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpLeft,
  BookOpen,
  Check,
  Copy,
  Cpu,
  DollarSign,
  FileCode,
  Flag,
  Heart,
  Hourglass,
  Inbox,
  ListChecks,
  MessageSquare,
  Package,
  Quote,
  RefreshCw,
  Send,
  Target,
  Waypoints,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AttemptSpark, EvidenceChip, Markdown, Meter, NoteThread } from '../../components/display';
import { Annot, AnnotLine, ExecBadge, executorMismatch } from '../../components/exec-badge';
import { Glyph, StatusIcon, StatusPill } from '../../components/status';
import { Button, ConfirmDialog, Empty, Modal, Skeleton } from '../../components/ui';
import { toastError, useClient } from '../../lib/api';
import { actorName, describeEvent, fromStored } from '../../lib/events';
import {
  attainment,
  formatDuration,
  formatMetricValue,
  formatTarget,
  formatTokens,
  formatUsd,
  timeAgo,
  timeLeft,
  toMs,
  totalTokens,
} from '../../lib/format';
import { qk, useEvents } from '../../lib/queries';
import { canonical } from '../../lib/spec-diff';
import { aimMeta, statusMeta } from '../../lib/status';
import { cn } from '../../lib/utils';
import { DirectiveForm, DirectiveRow } from './directives';
import { Section } from './inspector-shell';

type DetailAttempt = NodeDetail['attempts'][number];

export function directivesForNode(all: Directive[], d: NodeDetail): Directive[] {
  const attemptIds = new Set(d.attempts.map((a) => a.id));
  return all
    .filter(
      (x) =>
        (x.targetType === 'node' && x.targetId === d.id) ||
        (x.targetType === 'attempt' && attemptIds.has(x.targetId)),
    )
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

// ─── Overview ───────────────────────────────────────────────────────────────

function LiveBox({ n }: { n: NodeSummary }) {
  const a = n.currentAttempt;
  if (!a) return null;
  return (
    <div className="livebox">
      <div className="lb-top">
        <StatusIcon status="running" />
        <b style={{ fontWeight: 600 }}>
          Attempt {a.number} of {n.maxAttempts}
        </b>
        {n.loop && (
          <span className="tag accent">
            <RefreshCw size={11} />
            &nbsp;iteration {n.loop.iteration}/{n.loop.max}
          </span>
        )}
        <ExecBadge
          x={a.executor}
          {...(executorMismatch(n.executor, a.executor)
            ? { mismatch: executorMismatch(n.executor, a.executor) as string }
            : {})}
        />
      </div>
      <div className="lb-step">
        <span className="ellipsis">{a.currentStep ?? 'Working…'}</span>
        <span className="pc">{a.progress ?? 0}%</span>
      </div>
      <Meter value={(a.progress ?? 0) / 100} cls="st-running" label="Attempt progress" />
      <div className="lb-meta">
        <div className="kv">
          <span className="k">
            <Hourglass />
            Lease
          </span>
          <span className="v">{timeLeft(a.leaseExpiresAt)}</span>
        </div>
        <div className="kv">
          <span className="k">
            <Heart />
            Heartbeat
          </span>
          <span className="v">{timeAgo(a.lastHeartbeatAt ?? a.startedAt)}</span>
        </div>
        <div className="kv">
          <span className="k">
            <DollarSign />
            Attempt spend
          </span>
          <span className="v">
            {formatUsd(a.usage?.costUsd)} · {formatTokens(totalTokens(a.usage))}
          </span>
        </div>
      </div>
    </div>
  );
}

function StateBox({ n }: { n: NodeSummary }) {
  const m = statusMeta(n.status);
  const a = n.currentAttempt;
  const msg =
    n.statusReason ??
    {
      pending: 'Waiting on prerequisites.',
      ready: 'Prerequisites satisfied; waiting for an agent to claim it.',
      evaluating: 'Work submitted; waiting on a judge for some terminating aim.',
      needs_input: 'A decision is needed — see the Inbox.',
      blocked: 'An agent reported an external blocker.',
      paused: 'Paused; no new claims.',
      done: 'Terminating aims satisfied.',
      failed: 'Exhausted or declared failed.',
      skipped: 'Intentionally not executed.',
      cancelled: 'The graph was cancelled.',
      running: '',
    }[n.status];
  return (
    <div className={cn('statebox', m.cls)}>
      <div className="sb-top">
        <StatusIcon status={n.status} />
        <b>{m.label}</b>
        {a && <ExecBadge x={a.executor} />}
      </div>
      {msg && <div className="sb-msg">{msg}</div>}
      {a?.summary && <div className="sb-msg">Summary: {a.summary}</div>}
    </div>
  );
}

function FeedbackBlock({ fb }: { fb: NonNullable<NodeDetail['feedback']> }) {
  return (
    <div className="fin" style={{ marginTop: 12 }}>
      <div className="fin-h">
        <Quote size={12} />
        Feedback for the next attempt ({fb.source}
        {fb.loopKey ? ` · ${fb.loopKey} iteration ${fb.iteration}` : ''})
      </div>
      {fb.summary && <div className="fin-i">{fb.summary}</div>}
      {fb.reason && <div className="fin-i">{fb.reason}</div>}
      {fb.comment && <div className="fin-i">“{fb.comment}”</div>}
      {fb.unmetAims?.map((u) => (
        <div key={u.key} className="fin-i">
          <StatusIcon status="unmet" aim />
          <span>
            <b>{u.title}</b>
            {u.value !== undefined
              ? ` — ${u.value}${u.target !== undefined ? ` / ${u.target}` : ''}`
              : ''}
            {u.rationale ? ` — ${u.rationale}` : ''}
          </span>
        </div>
      ))}
    </div>
  );
}

function DepChip({
  graph,
  k,
  status,
  rel,
  pk,
}: {
  graph: string;
  k: string;
  status: string;
  rel: string;
  pk?: boolean;
}) {
  const m = statusMeta(status);
  return (
    <Link
      to="/graphs/$graph/nodes/$node"
      params={{ graph, node: k }}
      search={(p) => p}
      className={cn('depchip', m.cls)}
      title={`${k} · ${m.label} · ${rel}`}
    >
      <Glyph name={m.icon} />
      <span className="ellipsis">{k}</span>
      {pk && <span className="pkdot" title="carries edge guidance" />}
      <span className="rel">{rel}</span>
    </Link>
  );
}

export function OverviewTab({ graph, n, d }: { graph: string; n: NodeSummary; d: NodeDetail }) {
  const [raw, setRaw] = useState(false);
  const qc = useQueryClient();
  const view = qc.getQueryData<{ nodes: NodeSummary[] }>(qk.graph(graph));
  const statusOf = (k?: string) => view?.nodes.find((x) => x.key === k)?.status ?? 'pending';
  const current = d.attempts.find((a) => a.id === n.currentAttempt?.id) ?? d.attempts.at(-1);
  const checklistState = current?.checklistState ?? {};
  const pkEdges = d.needs.filter((e) => e.condition || e.guidance || e.pitfalls);
  const openRequests = d.requests.filter((r) => r.status === 'open');
  return (
    <>
      {n.status === 'running' ? <LiveBox n={n} /> : <StateBox n={n} />}
      {d.feedback && <FeedbackBlock fb={d.feedback} />}
      {openRequests.length > 0 && (
        <div className="banner st-needs_input" style={{ marginTop: 12 }}>
          <Inbox />
          <span>
            {openRequests.length} open request{openRequests.length === 1 ? '' : 's'}:{' '}
            {openRequests.map((r) => r.title).join(' · ')}{' '}
            <Link to="/inbox" className="link">
              Open inbox
            </Link>
          </span>
        </div>
      )}
      {n.aim && (
        <Section title="Aim" icon={<Target size={12} />}>
          <p>{n.aim}</p>
        </Section>
      )}
      {d.purpose && (
        <Section title="Purpose" icon={<Flag size={12} />}>
          <p className="dim">{d.purpose}</p>
        </Section>
      )}
      {d.gate?.instructions && (
        <Section title={`Gate · ${d.gate.approver}`} icon={<Check size={12} />}>
          <Markdown text={d.gate.instructions} />
        </Section>
      )}
      {d.prompt && (
        <Section
          title="Prompt"
          icon={<FileCode size={12} />}
          right={
            <>
              <Button size="xs" variant="ghost" onClick={() => setRaw((r) => !r)}>
                {raw ? 'Rendered' : 'View raw'}
              </Button>
              <Button
                size="xs"
                onClick={() => {
                  void navigator.clipboard?.writeText(d.prompt ?? '');
                  toast.success('Prompt copied');
                }}
              >
                <Copy />
                Copy
              </Button>
            </>
          }
        >
          {raw ? <div className="codeblock">{d.prompt}</div> : <Markdown text={d.prompt} />}
        </Section>
      )}
      {d.context && (
        <Section title="Context" icon={<BookOpen size={12} />}>
          <Markdown text={d.context} />
        </Section>
      )}
      {d.deliverables.length > 0 && (
        <Section title="Deliverables" icon={<Package size={12} />}>
          <div className="checklist">
            {d.deliverables.map((x) => (
              <div key={x.name}>
                <Package size={13} className="muted" />
                <span className="mono">{x.name}</span>
                {x.description && <span className="muted">— {x.description}</span>}
                {x.required && <span className="tag">required</span>}
              </div>
            ))}
          </div>
        </Section>
      )}
      {d.checklist.length > 0 && (
        <Section title="Checklist" icon={<ListChecks size={12} />}>
          <div className="checklist">
            {d.checklist.map((c) => {
              const st = checklistState[c.key];
              return (
                <div key={c.key}>
                  <StatusIcon status={st?.done ? 'met' : 'pending'} aim />
                  <span>{c.title}</span>
                  {c.required && <span className="tag">required</span>}
                  {st?.evidence?.[0] && <EvidenceChip ev={st.evidence[0]} />}
                </div>
              );
            })}
          </div>
        </Section>
      )}
      <Section title="Dependencies" icon={<Waypoints size={12} />}>
        <div className="deps">
          <div>
            <div className="eyebrow">
              <ArrowUpLeft size={11} /> Upstream
            </div>
            {d.needs.length === 0 && !d.loop ? (
              <div className="muted" style={{ fontSize: 12 }}>
                —
              </div>
            ) : null}
            {d.needs.map((e) => (
              <DepChip
                key={e.id}
                graph={graph}
                k={e.from ?? '?'}
                status={statusOf(e.from)}
                rel={e.kind}
                pk={Boolean(e.condition || e.guidance || e.pitfalls)}
              />
            ))}
          </div>
          <div>
            <div className="eyebrow">
              <ArrowDownRight size={11} /> Downstream
            </div>
            {d.dependents.length === 0 ? (
              <div className="muted" style={{ fontSize: 12 }}>
                —
              </div>
            ) : null}
            {d.dependents.map((e) => (
              <DepChip
                key={e.id}
                graph={graph}
                k={e.to ?? '?'}
                status={statusOf(e.to)}
                rel={e.kind}
                pk={Boolean(e.condition || e.guidance || e.pitfalls)}
              />
            ))}
          </div>
        </div>
        {pkEdges.map((e) => (
          <div key={e.id} className="dep-pk-wrap">
            <div className="dep-pk-edge">
              <Waypoints size={12} />
              <span className="mono">
                {e.from} → {e.to}
              </span>
              {e.relation && <span className="ev-rel">{e.relation.replace(/_/g, ' ')}</span>}
            </div>
            {(
              [
                ['condition', e.condition],
                ['guidance', e.guidance],
                ['pitfall', e.pitfalls],
              ] as const
            )
              .filter(([, v]) => v)
              .map(([f, v]) => (
                <div key={f} className="dep-pk-i">
                  <span className="f">{f}</span>
                  <span className="t">{v}</span>
                  <span />
                </div>
              ))}
          </div>
        ))}
      </Section>
      {(n.executor.model || n.executor.role || n.executor.requires?.length) && (
        <Section title="Executor hints" icon={<Cpu size={12} />}>
          <div className="hints">
            {n.executor.model && (
              <div className="kv">
                <span className="k">Model</span>
                <span className="v">
                  <ExecBadge x={{ kind: 'agent', ...n.executor }} />
                </span>
              </div>
            )}
            {n.executor.role && (
              <div className="kv">
                <span className="k">Role</span>
                <span className="v">{n.executor.role}</span>
              </div>
            )}
            {n.executor.requires?.length ? (
              <div className="kv">
                <span className="k">Requires skills</span>
                <span className="v mono">{n.executor.requires.join(', ')}</span>
              </div>
            ) : null}
            {n.executor.mechanism && (
              <div className="kv">
                <span className="k">Mechanism</span>
                <span className="v">{n.executor.mechanism}</span>
              </div>
            )}
          </div>
          {n.executor.instructions && (
            <p className="dim" style={{ marginTop: 8 }}>
              {n.executor.instructions}
            </p>
          )}
        </Section>
      )}
    </>
  );
}

// ─── Aims ───────────────────────────────────────────────────────────────────

function evaluationsFor(d: NodeDetail, aim: Aim): Evaluation[] {
  return [...d.attempts.flatMap((a) => a.evaluations), ...d.evaluations]
    .filter((e) => e.aimId === aim.id)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

function metricSeries(
  d: NodeDetail,
  metric: string | undefined,
): Array<{ label: string; value: number; live?: boolean }> {
  if (!metric) return [];
  return d.attempts
    .map((a) => {
      const reports = a.metrics.filter((m: MetricReport) => m.name === metric);
      const last = reports.at(-1);
      return last
        ? { label: `A${a.number}`, value: last.value, live: a.status === 'running' }
        : undefined;
    })
    .filter((x): x is { label: string; value: number; live: boolean } => Boolean(x));
}

export function AimsTab({ graph, d }: { graph: string; d: NodeDetail }) {
  const client = useClient();
  const qc = useQueryClient();
  const [waiving, setWaiving] = useState<Aim | null>(null);
  const aims = d.aims as unknown as Aim[];
  if (aims.length === 0) return <Empty title="No aims">This node has no aims.</Empty>;
  return (
    <>
      <p className="dim" style={{ marginTop: 12, fontSize: 12 }}>
        Aim mode <b className="mono">{d.aimMode}</b>:{' '}
        {d.aimMode === 'all' ? 'every terminating aim must be met' : 'any terminating aim suffices'}
        .
      </p>
      {aims.map((a) => {
        const m = aimMeta(a.status);
        const evals = evaluationsFor(d, a);
        const latest = evals[0];
        const series = metricSeries(d, a.metric);
        return (
          <div
            key={a.id}
            className={cn('aim-card', a.terminating && 'term', m.cls)}
            data-testid={`aim-${a.key}`}
          >
            <div className="aim-top">
              <StatusIcon status={a.status} aim />
              <span className="title">{a.title}</span>
              <span className="right">
                <span className={cn('pill', m.cls)}>{m.label}</span>
              </span>
            </div>
            <div className="aim-meta">
              <span className="tag mono">{a.key}</span>
              <span className="tag">{a.kind}</span>
              <span className="tag">{a.terminating ? 'terminating' : 'non-terminating'}</span>
              {a.guard && <span className="tag">guard</span>}
              <span className="tag">
                evaluator: {a.evaluator}
                {a.evaluatorKey ? ` (${a.evaluatorKey})` : ''}
              </span>
              {a.implicit && <span className="tag">implicit approval</span>}
            </div>
            {a.kind === 'quantitative' && (
              <div className="quant">
                <div>
                  <div className="big">
                    {formatMetricValue(a.currentValue, a)}
                    <small>/ {formatTarget(a)}</small>
                  </div>
                  <div className="metric">{a.metric}</div>
                  <div className="gauge-bar">
                    <i style={{ width: `${Math.round((attainment(a) ?? 0) * 100)}%` }} />
                  </div>
                </div>
                <AttemptSpark
                  points={series}
                  {...(a.target !== undefined ? { target: a.target } : {})}
                  aim={a}
                />
              </div>
            )}
            {a.criteria?.length ? (
              <ul className="criteria">
                {a.criteria.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            ) : null}
            {latest && (
              <div className="aim-rationale">
                <div className="who">
                  <AnnotLine x={latest.actor} />
                  <span className="sep">·</span>
                  {latest.verdict}
                  <span className="sep">·</span>
                  {timeAgo(latest.createdAt)}
                </div>
                {latest.rationale ?? <span className="muted">No rationale given.</span>}
                {latest.evidence.length > 0 && (
                  <div className="ev" style={{ padding: '6px 0 0' }}>
                    {latest.evidence.map((ev) => (
                      <EvidenceChip key={`${ev.kind}:${ev.value}`} ev={ev} />
                    ))}
                  </div>
                )}
              </div>
            )}
            {a.status !== 'waived' && a.status !== 'met' && !a.implicit && (
              <div className="row" style={{ marginTop: 10, justifyContent: 'flex-end' }}>
                <Button size="xs" onClick={() => setWaiving(a)}>
                  Waive…
                </Button>
              </div>
            )}
          </div>
        );
      })}
      <ConfirmDialog
        open={Boolean(waiving)}
        onOpenChange={(o) => !o && setWaiving(null)}
        title={`Waive “${waiving?.title ?? ''}”?`}
        description="Waivers count as met for completion and are shown prominently in the audit view."
        confirmLabel="Waive aim"
        reason="required"
        reasonLabel="Justification"
        onConfirm={async ({ reason }) => {
          if (!waiving) return;
          try {
            await client.waiveNodeAim(graph, d.key, waiving.key, reason);
            toast.success('Aim waived');
            void qc.invalidateQueries({ queryKey: qk.node(graph, d.key) });
          } catch (e) {
            toastError(e, 'Waive');
            throw e;
          }
        }}
      />
    </>
  );
}

// ─── Attempts ───────────────────────────────────────────────────────────────

function AttemptCard({ a, d }: { a: DetailAttempt; d: NodeDetail }) {
  const running = a.status === 'running';
  const started = toMs(a.startedAt) ?? 0;
  const end = toMs(a.endedAt) ?? toMs(a.submittedAt) ?? Date.now();
  const aimKey = (id: string) => (d.aims as unknown as Aim[]).find((x) => x.id === id)?.key ?? id;
  return (
    <div className={cn('att', running && 'cur')} data-testid={`attempt-${a.number}`}>
      <div className="att-h">
        <span className="t">Attempt {a.number}</span>
        <StatusPill status={a.status} />
        {!a.counted && a.status !== 'running' && a.status !== 'submitted' && (
          <span className="tag">not counted</span>
        )}
        {a.manual && <span className="tag">manual</span>}
        <span className="right">{formatDuration(end - started)}</span>
      </div>
      <div className="att-b">
        <Annot x={a.executor} />
        {a.dispatchedBy && (
          <div className="muted" style={{ fontSize: 11.5 }}>
            Dispatched by {a.dispatchedBy.orchestratorKey ?? actorName(a.dispatchedBy)}
          </div>
        )}
        {running && (
          <div className="att-stats">
            <div className="kv">
              <span className="k">Lease</span>
              <span className="v">{timeLeft(a.leaseExpiresAt)}</span>
            </div>
            <div className="kv">
              <span className="k">Heartbeat</span>
              <span className="v">{timeAgo(a.lastHeartbeatAt ?? a.startedAt)}</span>
            </div>
            <div className="kv">
              <span className="k">Progress</span>
              <span className="v">{a.progress ?? 0}%</span>
            </div>
            <div className="kv">
              <span className="k">Step</span>
              <span className="v ellipsis" style={{ maxWidth: 140 }}>
                {a.currentStep ?? '—'}
              </span>
            </div>
          </div>
        )}
        {a.feedbackIn && (
          <div className="fin">
            <div className="fin-h">
              <Quote size={12} />
              What the agent was told ({a.feedbackIn.source})
            </div>
            {a.feedbackIn.summary && <div className="fin-i">{a.feedbackIn.summary}</div>}
            {a.feedbackIn.reason && <div className="fin-i">{a.feedbackIn.reason}</div>}
            {a.feedbackIn.comment && <div className="fin-i">“{a.feedbackIn.comment}”</div>}
            {a.feedbackIn.unmetAims?.map((u) => (
              <div key={u.key} className="fin-i">
                <StatusIcon status="unmet" aim />
                <span>
                  {u.title}
                  {u.value !== undefined ? ` — ${u.value}` : ''}
                  {u.rationale ? ` — ${u.rationale}` : ''}
                </span>
              </div>
            ))}
          </div>
        )}
        {a.summary && <div style={{ fontSize: 12.5, lineHeight: '18px' }}>{a.summary}</div>}
        {a.outcomeReason && (
          <div className="feedback">
            <div className="fh">
              <AlertTriangle size={12} />
              Outcome
            </div>
            {a.outcomeReason}
          </div>
        )}
        {a.evaluations.length > 0 && (
          <div className="steps">
            {a.evaluations.map((e) => (
              <div key={e.id} title={e.rationale}>
                <StatusIcon status={e.verdict} aim />
                <span className="mono">{aimKey(e.aimId)}</span>
                <span className="ellipsis">
                  {e.verdict}
                  {e.value !== undefined ? ` · ${e.value}` : ''}
                  {e.rationale ? ` — ${e.rationale}` : ''}
                </span>
                <span className="when">{e.evaluatorKind}</span>
              </div>
            ))}
          </div>
        )}
        {a.metrics.length > 0 && (
          <div className="ev" style={{ padding: 0 }}>
            {a.metrics.map((mr) => (
              <span key={mr.id} className="chip mono">
                {mr.name} = {mr.value}
              </span>
            ))}
          </div>
        )}
        {a.usage && (
          <div className="muted" style={{ fontSize: 11.5 }}>
            Usage: {formatUsd(a.usage.costUsd)} · {formatTokens(totalTokens(a.usage))}
          </div>
        )}
        {a.checkpoint !== undefined && a.checkpoint !== null && (
          <details>
            <summary className="muted" style={{ fontSize: 11.5, cursor: 'pointer' }}>
              Checkpoint
            </summary>
            <pre className="event-json">{JSON.stringify(a.checkpoint, null, 2)}</pre>
          </details>
        )}
      </div>
    </div>
  );
}

export function AttemptsTab({ d, n }: { d: NodeDetail; n: NodeSummary }) {
  const groups = useMemo(() => {
    const by = new Map<number, DetailAttempt[]>();
    for (const a of d.attempts) by.set(a.activation, [...(by.get(a.activation) ?? []), a]);
    return [...by.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([act, list]) => [act, list.slice().sort((x, y) => y.number - x.number)] as const);
  }, [d.attempts]);
  if (d.attempts.length === 0)
    return <Empty title="No attempts yet">Attempts appear when an agent claims this node.</Empty>;
  return (
    <div className="tl">
      {groups.map(([activation, list]) => (
        <div key={activation}>
          <div className="tl-iter">
            <RefreshCw />
            Activation {activation}
            {n.loop && activation === n.activation
              ? ` · ${n.loop.key} iteration ${n.loop.iteration}/${n.loop.max}`
              : ''}
            <span className="line" />
          </div>
          {list.map((a: Attempt & DetailAttempt) => (
            <div key={a.id} className={cn('tl-item', statusMeta(a.status).cls)}>
              <span className="tl-dot">
                <Glyph name={statusMeta(a.status).icon} />
              </span>
              <AttemptCard a={a} d={d} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ─── Notes ──────────────────────────────────────────────────────────────────

export function NotesTab({ graph, d }: { graph: string; d: NodeDetail }) {
  const client = useClient();
  const qc = useQueryClient();
  const [type, setType] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const types = [...new Set(d.notes.map((n) => n.type))];
  const notes = type ? d.notes.filter((n) => n.type === type) : d.notes;
  const post = async () => {
    if (!comment.trim()) return;
    try {
      await client.addNodeNote(graph, d.key, {
        type: 'comment',
        title: comment.trim().slice(0, 120),
        body: comment.trim(),
      });
      setComment('');
      void qc.invalidateQueries({ queryKey: qk.node(graph, d.key) });
      void qc.invalidateQueries({ queryKey: ['notes'] });
    } catch (e) {
      toastError(e, 'Comment');
    }
  };
  return (
    <>
      <fieldset className="note-filter" aria-label="Filter notes by type">
        <button
          type="button"
          className={cn('chip', !type && 'on')}
          onClick={() => setType(null)}
          aria-pressed={!type}
        >
          All {d.notes.length}
        </button>
        {types.map((t) => (
          <button
            key={t}
            type="button"
            className={cn('chip', type === t && 'on')}
            onClick={() => setType(t)}
            aria-pressed={type === t}
          >
            {t} {d.notes.filter((n) => n.type === t).length}
          </button>
        ))}
      </fieldset>
      {notes.length === 0 ? <Empty title="No notes yet" /> : <NoteThread notes={notes} />}
      <div className="field">
        <label htmlFor="node-comment">
          <MessageSquare size={12} /> Add a comment
        </label>
        <textarea
          id="node-comment"
          className="textarea prose"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Visible to agents in this node’s briefing context"
        />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button size="sm" onClick={post} disabled={!comment.trim()}>
            <Send />
            Post comment
          </Button>
        </div>
      </div>
    </>
  );
}

// ─── Directives ─────────────────────────────────────────────────────────────

export function DirectivesTab({
  graph,
  d,
  directives,
}: {
  graph: string;
  d: NodeDetail;
  directives: Directive[];
}) {
  return (
    <>
      <Section title="Compose" icon={<Send size={12} />}>
        <DirectiveForm graph={graph} target={{ type: 'node', key: d.key }} compact />
      </Section>
      <Section title="Sent to this node" icon={<MessageSquare size={12} />}>
        {directives.length === 0 ? (
          <div className="muted">No directives yet.</div>
        ) : (
          directives.map((x) => <DirectiveRow key={x.id} d={x} />)
        )}
      </Section>
    </>
  );
}

// ─── Activity ───────────────────────────────────────────────────────────────

export function ActivityTab({ graph, d }: { graph: string; d: NodeDetail }) {
  const { data, isLoading } = useEvents(graph, { limit: 3000 });
  const qc = useQueryClient();
  const view = qc.getQueryData<{ nodes: NodeSummary[] }>(qk.graph(graph));
  const keyOf = (id: string) => view?.nodes.find((n) => n.id === id)?.key;
  const attemptIds = new Set(d.attempts.map((a) => a.id));
  const directiveIds = new Set(d.directives.map((x) => x.id));
  const requestIds = new Set(d.requests.map((r) => r.id));
  const aimIds = new Set((d.aims as unknown as Aim[]).map((a) => a.id));
  const events = (data ?? []).filter(
    (e) =>
      e.entityId === d.id ||
      attemptIds.has(e.entityId) ||
      directiveIds.has(e.entityId) ||
      requestIds.has(e.entityId) ||
      aimIds.has(e.entityId) ||
      (e.payload as { nodeId?: string }).nodeId === d.id,
  );
  if (isLoading) return <Skeleton style={{ height: 200, marginTop: 12 }} />;
  if (events.length === 0) return <Empty title="No events yet" />;
  return (
    <div style={{ marginTop: 6 }}>
      {events.slice(0, 200).map((e) => {
        const desc = describeEvent(fromStored(e), keyOf);
        return (
          <div key={e.seq} className="act" title={e.type}>
            <span className={cn('sicon', desc.tone.startsWith('st-') ? desc.tone : 'st-pending')}>
              <Glyph name={statusMeta(desc.tone.replace('st-', '')).icon} />
            </span>
            <div className="what">
              <b>{actorName(e.actor)}</b> {desc.verb}
              {desc.detail ? <span className="muted"> — {desc.detail}</span> : null}
              <div className="mono muted" style={{ fontSize: 10.5 }}>
                {e.type} · #{e.seq}
              </div>
            </div>
            <span className="when">{timeAgo(e.createdAt)}</span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Briefing ───────────────────────────────────────────────────────────────

export function BriefingTab({ graph, nodeKey }: { graph: string; nodeKey: string }) {
  const client = useClient();
  const [budget, setBudget] = useState(6000);
  const { data, isFetching, error } = useQuery({
    queryKey: qk.briefing(graph, nodeKey, budget),
    queryFn: () => client.briefing(graph, nodeKey, { budget }),
    placeholderData: (prev) => prev,
  });
  return (
    <>
      <Section
        title="The exact briefing an agent would receive now"
        right={
          <Button
            size="xs"
            onClick={() => {
              void navigator.clipboard?.writeText(data ?? '');
              toast.success('Briefing copied');
            }}
          >
            <Copy />
            Copy
          </Button>
        }
      >
        <div className="row" style={{ gap: 10 }}>
          <label
            htmlFor="budget"
            style={{ fontSize: 12, color: 'var(--text-2)', whiteSpace: 'nowrap' }}
          >
            Token budget
          </label>
          <input
            id="budget"
            type="range"
            min={500}
            max={20000}
            step={500}
            value={budget}
            onChange={(e) => setBudget(Number(e.target.value))}
            style={{ flex: 1, accentColor: 'var(--accent)' }}
          />
          <span className="mono num" style={{ width: 52, textAlign: 'right' }}>
            {budget}
          </span>
        </div>
        <p className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
          A preview: it does not mark directives delivered. {isFetching ? 'Refreshing…' : ''}
        </p>
      </Section>
      {error ? (
        <Empty title="Could not render the briefing">{(error as Error).message}</Empty>
      ) : (
        <div className="md" data-testid="briefing">
          {data ?? '…'}
        </div>
      )}
    </>
  );
}

// ─── Config ─────────────────────────────────────────────────────────────────

type ConfigForm = {
  title: string;
  aim: string;
  purpose: string;
  prompt: string;
  context: string;
  priority: string;
  maxAttempts: string;
  onExhausted: string;
  tags: string;
  model: string;
  thinking: string;
  role: string;
  deliverables: string;
};

function formFrom(d: NodeDetail): ConfigForm {
  return {
    title: d.title,
    aim: d.aim ?? '',
    purpose: d.purpose ?? '',
    prompt: d.prompt ?? '',
    context: d.context ?? '',
    priority: d.priority,
    maxAttempts: String(d.maxAttempts),
    onExhausted: d.onExhausted,
    tags: d.tags.join(', '),
    model: d.executor.model ?? '',
    thinking: d.executor.thinking ?? '',
    role: d.executor.role ?? '',
    deliverables: d.deliverables.map((x) => x.name).join('\n'),
  };
}

/** Field-level patch of the changed config fields (PATCH /graphs/{g}/nodes/{n}). */
export function configPatch(d: NodeDetail, f: ConfigForm): Record<string, unknown> {
  const before = formFrom(d);
  const patch: Record<string, unknown> = {};
  const text = (k: 'title' | 'aim' | 'purpose' | 'prompt' | 'context') => {
    if (f[k] !== before[k]) patch[k] = f[k];
  };
  for (const k of ['title', 'aim', 'purpose', 'prompt', 'context'] as const) text(k);
  if (f.priority !== before.priority) patch.priority = f.priority;
  if (f.maxAttempts !== before.maxAttempts) patch.maxAttempts = Number(f.maxAttempts);
  if (f.onExhausted !== before.onExhausted) patch.onExhausted = f.onExhausted;
  const tags = f.tags
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  if (canonical(tags) !== canonical(d.tags)) patch.tags = tags;
  const executor = {
    ...d.executor,
    model: f.model || undefined,
    thinking: f.thinking || undefined,
    role: f.role || undefined,
  };
  const clean = Object.fromEntries(
    Object.entries(executor).filter(([, v]) => v !== undefined && v !== ''),
  );
  if (
    canonical(clean) !==
    canonical(
      Object.fromEntries(Object.entries(d.executor).filter(([, v]) => v !== undefined && v !== '')),
    )
  )
    patch.executor = clean;
  const deliverables = f.deliverables
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);
  if (canonical(deliverables) !== canonical(d.deliverables.map((x) => x.name))) {
    patch.deliverables = deliverables.map(
      (name) => d.deliverables.find((x) => x.name === name) ?? name,
    );
  }
  return patch;
}

export function ConfigTab({
  graph,
  d,
  n,
  directives,
}: {
  graph: string;
  d: NodeDetail;
  n: NodeSummary;
  directives: Directive[];
}) {
  const client = useClient();
  const qc = useQueryClient();
  const [form, setForm] = useState<ConfigForm>(() => formFrom(d));
  const [base, setBase] = useState<{ version: number; form: ConfigForm }>(() => ({
    version: d.version,
    form: formFrom(d),
  }));
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  // Re-sync the form when the node changes underneath us and there are no local edits.
  if (d.version !== base.version) {
    const pristine = canonical(form) === canonical(base.form);
    const next = formFrom(d);
    setBase({ version: d.version, form: next });
    if (pristine) setForm(next);
  }
  const patch = configPatch(d, form);
  const dirty = Object.keys(patch).length > 0;
  const openAttempt =
    n.currentAttempt &&
    (n.currentAttempt.status === 'running' || n.currentAttempt.status === 'submitted');
  const latestChange = directives.find((x) => x.kind === 'change');
  const set = (k: keyof ConfigForm) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = async () => {
    setBusy(true);
    try {
      await client.patchNode(graph, d.key, patch, d.version);
      toast.success(openAttempt ? 'Saved — a change directive was sent to the agent' : 'Saved');
      setPreview(false);
      void qc.invalidateQueries({ queryKey: qk.node(graph, d.key) });
      void qc.invalidateQueries({ queryKey: qk.graph(graph) });
      void qc.invalidateQueries({ queryKey: qk.directives(graph) });
    } catch (e) {
      toastError(e, 'Save');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {openAttempt && (
        <div className="banner st-running" style={{ marginTop: 12 }} role="note">
          <AlertTriangle />
          <span>An agent is working on this node. Saving sends a change directive.</span>
        </div>
      )}
      {latestChange && (
        <div data-testid="change-directive">
          <DirectiveRow d={latestChange} />
        </div>
      )}
      <div className="field">
        <label htmlFor="cfg-title">Title</label>
        <input
          id="cfg-title"
          className={cn('input', 'title' in patch && 'changed')}
          value={form.title}
          onChange={set('title')}
        />
      </div>
      <div className="field">
        <label htmlFor="cfg-aim">Aim</label>
        <input
          id="cfg-aim"
          className={cn('input', 'aim' in patch && 'changed')}
          value={form.aim}
          onChange={set('aim')}
        />
      </div>
      <div className="field">
        <label htmlFor="cfg-purpose">Purpose</label>
        <input
          id="cfg-purpose"
          className={cn('input', 'purpose' in patch && 'changed')}
          value={form.purpose}
          onChange={set('purpose')}
        />
      </div>
      {d.kind === 'task' && (
        <div className="field">
          <label htmlFor="cfg-prompt">Prompt</label>
          <textarea
            id="cfg-prompt"
            className={cn('textarea', 'prompt' in patch && 'changed')}
            style={{ minHeight: 160 }}
            value={form.prompt}
            onChange={set('prompt')}
          />
        </div>
      )}
      <div className="field">
        <label htmlFor="cfg-context">
          Context <span className="muted">(markdown)</span>
        </label>
        <textarea
          id="cfg-context"
          className={cn('textarea', 'context' in patch && 'changed')}
          value={form.context}
          onChange={set('context')}
        />
      </div>
      <div className="grid2">
        <div className="field">
          <label htmlFor="cfg-priority">Priority</label>
          <select
            id="cfg-priority"
            className="input"
            value={form.priority}
            onChange={set('priority')}
          >
            {['p0', 'p1', 'p2', 'p3'].map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="cfg-max">Max attempts</label>
          <input
            id="cfg-max"
            className="input"
            type="number"
            min={1}
            max={50}
            value={form.maxAttempts}
            onChange={set('maxAttempts')}
          />
        </div>
        <div className="field">
          <label htmlFor="cfg-exh">On exhausted</label>
          <select
            id="cfg-exh"
            className="input"
            value={form.onExhausted}
            onChange={set('onExhausted')}
          >
            {['escalate', 'fail', 'skip', 'accept'].map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="cfg-tags">Tags</label>
          <input
            id="cfg-tags"
            className="input"
            value={form.tags}
            onChange={set('tags')}
            placeholder="code, backend"
          />
        </div>
        <div className="field">
          <label htmlFor="cfg-model">Executor model</label>
          <input
            id="cfg-model"
            className="input mono"
            value={form.model}
            onChange={set('model')}
            placeholder="claude-opus-5-5"
          />
        </div>
        <div className="field">
          <label htmlFor="cfg-thinking">Thinking</label>
          <select
            id="cfg-thinking"
            className="input"
            value={form.thinking}
            onChange={set('thinking')}
          >
            {['', 'off', 'low', 'medium', 'high', 'xhigh', 'max'].map((p) => (
              <option key={p} value={p}>
                {p || '—'}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="cfg-role">Executor role</label>
        <input id="cfg-role" className="input" value={form.role} onChange={set('role')} />
      </div>
      <div className="field">
        <label htmlFor="cfg-deliv">
          Deliverables <span className="muted">(one per line)</span>
        </label>
        <textarea
          id="cfg-deliv"
          className="textarea"
          value={form.deliverables}
          onChange={set('deliverables')}
        />
      </div>
      <p className="muted" style={{ fontSize: 11.5, marginTop: 10 }}>
        Aims are protected (admin only) and edited from the Spec tab.
      </p>
      <div
        className="row"
        style={{
          justifyContent: 'flex-end',
          marginTop: 12,
          gap: 8,
          position: 'sticky',
          bottom: 0,
          background: 'var(--panel)',
          padding: '10px 0',
        }}
      >
        <Button size="sm" disabled={!dirty} onClick={() => setForm(formFrom(d))}>
          Discard
        </Button>
        <Button size="sm" variant="primary" disabled={!dirty} onClick={() => setPreview(true)}>
          Review & save
        </Button>
      </div>
      <Modal
        open={preview}
        onOpenChange={setPreview}
        title="Review changes"
        description={
          openAttempt
            ? 'An attempt is open: saving creates a change directive the agent sees on its next heartbeat.'
            : undefined
        }
        wide
        footer={
          <>
            <Button onClick={() => setPreview(false)}>Back</Button>
            <Button variant="primary" onClick={save} disabled={busy}>
              Save changes
            </Button>
          </>
        }
      >
        <div className="col" style={{ gap: 10 }}>
          {Object.entries(patch).map(([k, v]) => {
            const before = (d as unknown as Record<string, unknown>)[k];
            return (
              <div key={k}>
                <div className="eyebrow" style={{ marginBottom: 4 }}>
                  {k}
                </div>
                <div className="grid2">
                  <pre className="event-json" style={{ maxHeight: 180 }}>
                    {typeof before === 'string' ? before : (JSON.stringify(before, null, 2) ?? '—')}
                  </pre>
                  <pre
                    className="event-json"
                    style={{ maxHeight: 180, borderColor: 'var(--accent-line)' }}
                  >
                    {typeof v === 'string' ? v : JSON.stringify(v, null, 2)}
                  </pre>
                </div>
              </div>
            );
          })}
        </div>
      </Modal>
    </>
  );
}
