/**
 * Inbox (docs/ui.md §4.6): request cards across graphs with inline actions from the option
 * catalog (concepts §11.1). Resolutions are optimistic and roll back with the server's hint.
 */
import type { HumanRequest } from '@agent-graphs/sdk';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import {
  Check,
  ChevronRight,
  CircleAlert,
  CornerDownRight,
  Inbox as InboxIcon,
  MessageCircleQuestion,
  OctagonAlert,
  Send,
  ShieldCheck,
  Siren,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Markdown } from '../../components/display';
import { AnnotLine } from '../../components/exec-badge';
import { Button, Empty, Skeleton } from '../../components/ui';
import { errorText, useClient } from '../../lib/api';
import { age, formatDateTime, timeAgo } from '../../lib/format';
import { useGraph, useRequests } from '../../lib/queries';
import {
  buildResolution,
  isApprovalStyle,
  type OptionField,
  requestOptions,
} from '../../lib/requests';
import { cn } from '../../lib/utils';
import type { InboxSearch } from '../../router';

export const KIND_META: Record<string, { label: string; cls: string; icon: typeof ShieldCheck }> = {
  approval: { label: 'Approval', cls: 'st-needs_input', icon: ShieldCheck },
  question: { label: 'Question', cls: 'st-ready', icon: MessageCircleQuestion },
  escalation: { label: 'Escalation', cls: 'st-failed', icon: Siren },
  blocker: { label: 'Blocker', cls: 'st-blocked', icon: OctagonAlert },
};

export function sortRequests(items: HumanRequest[]): HumanRequest[] {
  return items
    .slice()
    .sort(
      (a, b) =>
        Number(b.blocking) - Number(a.blocking) ||
        Date.parse(a.createdAt) - Date.parse(b.createdAt),
    );
}

export function InboxPage() {
  const search = useSearch({ strict: false }) as InboxSearch;
  const navigate = useNavigate();
  const tab = search.tab ?? 'open';
  const { data: open, isLoading } = useRequests('open');
  const { data: resolved } = useRequests(tab === 'resolved' ? 'resolved' : 'open');
  const items = tab === 'resolved' ? (resolved ?? []) : (open ?? []);
  const graphs = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of items) if (r.graph) m.set(r.graph.slug ?? r.graph.id, r.graph.title);
    return [...m.entries()];
  }, [items]);
  const filtered = sortRequests(
    items.filter(
      (r) =>
        (!search.kind || r.kind === search.kind) &&
        (!search.graph || r.graph?.slug === search.graph || r.graph?.id === search.graph) &&
        (!search.blocking || r.blocking) &&
        (!search.assignee || r.assignee === search.assignee),
    ),
  );
  const counts = (kind: string) => items.filter((r) => r.kind === kind).length;
  const setSearch = (patch: Partial<InboxSearch>) =>
    void navigate({ to: '.', search: (p) => ({ ...(p as object), ...patch }), replace: true });
  const oldest = (open ?? []).reduce<string | undefined>(
    (m, r) => (!m || r.createdAt < m ? r.createdAt : m),
    undefined,
  );
  const columns = [filtered.filter((_, i) => i % 2 === 0), filtered.filter((_, i) => i % 2 === 1)];

  return (
    <section className="view on page" aria-label="Inbox">
      <div className="page-in">
        <div className="page-h">
          <div>
            <h1>Inbox</h1>
            <div className="sub">
              Requests from agents, orchestrators and policies that need a human decision ·{' '}
              {open?.length ?? 0} open across {new Set((open ?? []).map((r) => r.graphId)).size}{' '}
              graph{new Set((open ?? []).map((r) => r.graphId)).size === 1 ? '' : 's'}
            </div>
          </div>
          <div className="right">
            {oldest && (
              <span className="muted" style={{ fontSize: 12 }}>
                oldest open <b style={{ color: 'var(--text)' }}>{age(oldest)}</b>
              </span>
            )}
          </div>
        </div>
        <div className="filters" role="toolbar" aria-label="Inbox filters">
          <fieldset className="seg" aria-label="Open or resolved">
            <button
              type="button"
              aria-pressed={tab === 'open'}
              className={tab === 'open' ? 'on' : ''}
              onClick={() => setSearch({ tab: undefined })}
            >
              Open
            </button>
            <button
              type="button"
              aria-pressed={tab === 'resolved'}
              className={tab === 'resolved' ? 'on' : ''}
              onClick={() => setSearch({ tab: 'resolved' })}
            >
              Resolved
            </button>
          </fieldset>
          <span className="vsep" />
          <button
            type="button"
            className={cn('fchip', !search.kind && 'on')}
            onClick={() => setSearch({ kind: undefined })}
          >
            All <span className="n">{items.length}</span>
          </button>
          {Object.entries(KIND_META).map(([kind, m]) => (
            <button
              key={kind}
              type="button"
              className={cn('fchip', search.kind === kind && 'on')}
              onClick={() => setSearch({ kind: search.kind === kind ? undefined : kind })}
              aria-pressed={search.kind === kind}
            >
              <m.icon />
              {m.label}s <span className="n">{counts(kind)}</span>
            </button>
          ))}
          <span className="vsep" />
          <select
            className="input"
            style={{ width: 200, height: 28 }}
            value={search.graph ?? ''}
            onChange={(e) => setSearch({ graph: e.target.value || undefined })}
            aria-label="Filter by graph"
          >
            <option value="">All graphs</option>
            {graphs.map(([ref, title]) => (
              <option key={ref} value={ref}>
                {title}
              </option>
            ))}
          </select>
          <select
            className="input"
            style={{ width: 150, height: 28 }}
            value={search.assignee ?? ''}
            onChange={(e) => setSearch({ assignee: e.target.value || undefined })}
            aria-label="Filter by assignee"
          >
            <option value="">Any assignee</option>
            <option value="human">human</option>
            <option value="orchestrator">orchestrator</option>
            <option value="any">any</option>
          </select>
          <button
            type="button"
            className={cn('fchip', search.blocking && 'on')}
            onClick={() => setSearch({ blocking: search.blocking ? undefined : true })}
            aria-pressed={Boolean(search.blocking)}
          >
            <CircleAlert />
            Blocking only
          </button>
          <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
            Blocking first · oldest
          </span>
        </div>
        {isLoading ? (
          <div className="req-grid">
            <Skeleton style={{ height: 220 }} />
            <Skeleton style={{ height: 220 }} />
          </div>
        ) : filtered.length === 0 ? (
          <div className="card">
            <Empty
              icon={<InboxIcon />}
              title={tab === 'open' ? 'Inbox zero' : 'Nothing resolved yet'}
            >
              {tab === 'open'
                ? 'Approvals, questions, escalations and blockers land here.'
                : 'Resolved requests show their outcome here.'}
            </Empty>
          </div>
        ) : (
          <div className="req-grid">
            {columns.map((col, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: two fixed columns
              <div key={i} className="req-col">
                {col.map((r) =>
                  tab === 'resolved' ? (
                    <ResolvedCard key={r.id} r={r} />
                  ) : (
                    <RequestCard key={r.id} r={r} />
                  ),
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function CardHead({ r }: { r: HumanRequest }) {
  const m = KIND_META[r.kind] ?? (KIND_META.approval as (typeof KIND_META)['approval']);
  const graphRef = r.graph?.slug ?? r.graph?.id ?? r.graphId;
  const nodeKey = (r as HumanRequest & { nodeKey?: string }).nodeKey;
  return (
    <>
      <div className="req-h">
        <span className="kind">
          <m.icon />
          {m.label}
        </span>
        <span className="sep">·</span>
        <span className="path">
          <Link to="/graphs/$graph" params={{ graph: graphRef }} className="ellipsis">
            {r.graph?.title ?? r.graphId}
          </Link>
          {(nodeKey || r.nodeId) && (
            <>
              <ChevronRight />
              <NodeRef graph={graphRef} nodeId={r.nodeId} nodeKey={nodeKey} />
            </>
          )}
        </span>
        <span className="right">
          {r.blocking ? (
            <span className="blocking">
              <CircleAlert />
              Blocking
            </span>
          ) : (
            <span className="nonblocking">Not blocking</span>
          )}
          <span title={formatDateTime(r.createdAt)}>{age(r.createdAt)}</span>
        </span>
      </div>
      <div className="req-t">{r.title}</div>
      <div className="req-ask">
        <span className="lbl">Raised by</span>
        <AnnotLine x={r.createdBy} />
        <span className="tag">{r.subject}</span>
        {r.assignee !== 'any' && (
          <span className="tag">
            for {r.assignee}
            {r.assigneeKey ? ` (${r.assigneeKey})` : ''}
          </span>
        )}
      </div>
    </>
  );
}

function NodeRef({ graph, nodeId, nodeKey }: { graph: string; nodeId?: string; nodeKey?: string }) {
  // Requests carry node ids; resolve the key from the (shared, live-patched) GraphView.
  const { data } = useGraph(nodeKey ? undefined : graph);
  const key = nodeKey ?? data?.nodes.find((n) => n.id === nodeId)?.key;
  if (!key) return <span className="mono">{nodeId}</span>;
  return (
    <Link to="/graphs/$graph/nodes/$node" params={{ graph, node: key }} className="mono">
      {key}
    </Link>
  );
}

function FieldInput({
  f,
  value,
  onChange,
  id,
}: {
  f: OptionField;
  value: string;
  onChange: (v: string) => void;
  id: string;
}) {
  if (f.kind === 'longtext' || f.kind === 'prompt')
    return (
      <textarea
        id={id}
        className={cn('textarea', f.kind === 'longtext' && 'prose')}
        style={{ minHeight: f.kind === 'prompt' ? 110 : 64, flex: 1 }}
        value={value}
        placeholder={
          f.placeholder ?? (f.required ? `${f.label} (required)` : `${f.label} (optional)`)
        }
        onChange={(e) => onChange(e.target.value)}
        aria-label={f.label}
      />
    );
  return (
    <input
      id={id}
      className={cn(
        'input',
        (f.kind === 'duration' || f.kind === 'aimKey' || f.kind === 'nodeKey') && 'mono',
      )}
      type={f.kind === 'int' || f.kind === 'number' ? 'number' : 'text'}
      min={f.kind === 'int' ? 1 : undefined}
      value={value}
      placeholder={f.placeholder ?? f.default ?? (f.required ? 'required' : 'optional')}
      onChange={(e) => onChange(e.target.value)}
      aria-label={f.label}
      style={{ flex: 1 }}
    />
  );
}

function useResolve(r: HumanRequest) {
  const client = useClient();
  const qc = useQueryClient();
  return async (body: Parameters<typeof client.resolveRequest>[1], label: string) => {
    const key = ['requests', 'open'];
    const previous = qc.getQueryData<HumanRequest[]>(key);
    qc.setQueryData<HumanRequest[]>(key, (items) => items?.filter((x) => x.id !== r.id));
    try {
      await client.resolveRequest(r.id, body);
      toast.success(label, { description: r.title });
      void qc.invalidateQueries({ queryKey: ['requests'] });
      void qc.invalidateQueries({ queryKey: ['graph'] });
      return true;
    } catch (e) {
      qc.setQueryData(key, previous);
      const { title, description } = errorText(e);
      toast.error(`Could not resolve: ${title}`, description ? { description } : undefined);
      return false;
    }
  };
}

export function RequestCard({ r }: { r: HumanRequest }) {
  const options = requestOptions(r.subject, r.options);
  const approval = isApprovalStyle(r.kind, r.subject);
  const m = KIND_META[r.kind] ?? (KIND_META.approval as (typeof KIND_META)['approval']);
  const resolve = useResolve(r);
  const [choice, setChoice] = useState<string>(
    r.kind === 'question' ? 'answer' : approval ? '' : (options[0]?.id ?? ''),
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async (id: string, label: string) => {
    const built = buildResolution(r.subject, id, values);
    if (!built.ok) {
      setChoice(id);
      setError(built.error);
      return;
    }
    setError(undefined);
    setBusy(true);
    const ok = await resolve(built.body, label);
    if (!ok) setBusy(false);
  };
  const selected = options.find((o) => o.id === choice);
  const setValue = (k: string, v: string) => setValues((s) => ({ ...s, [k]: v }));

  return (
    <article
      className={cn('card req', m.cls)}
      data-testid={`request-${r.id}`}
      data-subject={r.subject}
      aria-label={`${m.label}: ${r.title}`}
    >
      <CardHead r={r} />
      {r.body && (
        <div className="req-ctx">
          <Markdown text={r.body} />
        </div>
      )}
      {approval ? (
        <>
          <div className="req-inline">
            <input
              className="input"
              value={values.comment ?? ''}
              onChange={(e) => setValue('comment', e.target.value)}
              placeholder={
                r.subject === 'aim'
                  ? 'Rationale — recorded with your verdict…'
                  : 'Comment (required if you request changes)…'
              }
              aria-label="Comment"
            />
          </div>
          <div className="req-f">
            {options.map((o) => (
              <Button
                key={o.id}
                size="sm"
                variant={
                  o.tone === 'approve' ? 'success' : o.tone === 'reject' ? 'default' : 'default'
                }
                className={o.tone === 'reject' ? 'danger-soft' : undefined}
                disabled={busy}
                title={o.consequence}
                onClick={() => void submit(o.id, o.label)}
              >
                {o.tone === 'approve' ? (
                  <Check />
                ) : o.tone === 'reject' ? (
                  <CornerDownRight />
                ) : null}
                {o.label}
              </Button>
            ))}
            <span className="right hint">
              {options.find((o) => o.tone === 'approve')?.consequence}
            </span>
          </div>
        </>
      ) : r.kind === 'question' ? (
        <>
          <div className="req-inline">
            <textarea
              className="textarea prose"
              style={{ minHeight: 64 }}
              value={values.text ?? ''}
              onChange={(e) => setValue('text', e.target.value)}
              placeholder="Your answer — sent to the asking agent as an answer directive"
              aria-label="Answer"
            />
          </div>
          <div className="req-f">
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              onClick={() => void submit('answer', 'Answer sent')}
            >
              <Send />
              Send answer
            </Button>
            <span className="right hint">Sends an answer directive</span>
          </div>
        </>
      ) : (
        <>
          <fieldset className="esc-opts" aria-label="Decision">
            {options.map((o) => (
              <button
                key={o.id}
                type="button"
                aria-pressed={choice === o.id}
                className={cn('esc', choice === o.id && 'on')}
                onClick={() => {
                  setChoice(o.id);
                  setError(undefined);
                }}
              >
                <span className="radio" aria-hidden="true" />
                <b>{o.label}</b>
                <span>{o.consequence}</span>
              </button>
            ))}
          </fieldset>
          {selected?.fields.map((f) => (
            <div key={f.name} className="esc-field">
              <label htmlFor={`${r.id}-${f.name}`}>{f.label}</label>
              <FieldInput
                f={f}
                id={`${r.id}-${f.name}`}
                value={values[f.name] ?? ''}
                onChange={(v) => setValue(f.name, v)}
              />
            </div>
          ))}
          <div className="req-f">
            <Button
              size="sm"
              variant={selected?.destructive ? 'danger' : 'primary'}
              disabled={busy || !selected}
              onClick={() => selected && void submit(selected.id, selected.label)}
            >
              <Check />
              Apply decision
            </Button>
            <span className="right hint">Decision and reason are stored in the event log</span>
          </div>
        </>
      )}
      {error && (
        <div className="form-err" style={{ margin: '0 16px 10px 18px' }} role="alert">
          {error}
        </div>
      )}
    </article>
  );
}

function ResolvedCard({ r }: { r: HumanRequest }) {
  const m = KIND_META[r.kind] ?? (KIND_META.approval as (typeof KIND_META)['approval']);
  return (
    <article className={cn('card req', m.cls)} data-testid={`resolved-${r.id}`}>
      <CardHead r={r} />
      <div className="req-ctx">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <span className="pill st-resolved">
            <Check size={13} />
            {r.resolution?.choice ?? r.status}
          </span>
          {r.resolvedBy && <AnnotLine x={r.resolvedBy} />}
          <span className="muted">{timeAgo(r.resolvedAt)}</span>
        </div>
        {r.resolution?.comment && <p style={{ margin: '8px 0 0' }}>“{r.resolution.comment}”</p>}
        {r.resolution?.data && (
          <pre className="event-json" style={{ marginTop: 8 }}>
            {JSON.stringify(r.resolution.data, null, 2)}
          </pre>
        )}
      </div>
      <div style={{ height: 12 }} />
    </article>
  );
}
