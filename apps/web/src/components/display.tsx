/** Shared display pieces: progress bars, aim chips, evidence chips, notes, markdown, sparklines. */
import type { Aim, Evidence, NodeSummary, Note } from '@agent-graphs/sdk';
import {
  Activity as ActivityIcon,
  Archive,
  ArrowRightToLine,
  CircleCheckBig,
  FileText,
  Flag,
  Gauge,
  GitCommitHorizontal,
  GitPullRequest,
  Image,
  Link2,
  MessageCircleQuestion,
  MessageSquare,
  OctagonAlert,
  Package,
  Search,
  Signpost,
  SquareTerminal,
  Type,
  User,
} from 'lucide-react';
import { memo, type ReactNode, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import {
  attainment,
  formatMetricValue,
  formatTarget,
  metricShortLabel,
  timeAgo,
} from '../lib/format';
import { aimMeta, segments } from '../lib/status';
import { cn } from '../lib/utils';
import { AnnotLine } from './exec-badge';
import { Glyph, StatusIcon } from './status';

export function SegBar({
  counts,
  total,
  className,
}: {
  counts: Partial<Record<string, number>>;
  total?: number;
  className?: string;
}) {
  const segs = segments(counts);
  const sum = total ?? segs.reduce((a, s) => a + s.count, 0);
  return (
    <div
      className={cn('segbar', className)}
      role="img"
      aria-label={`Node status breakdown: ${segs.map((s) => `${s.count} ${s.label}`).join(', ') || 'no nodes'}`}
    >
      {segs.map((s) => (
        <i
          key={s.status}
          className={`st-${s.status}`}
          style={{ flex: s.count }}
          title={`${s.count} ${s.label}`}
        />
      ))}
      {sum === 0 && <i className="st-pending" style={{ flex: 1, opacity: 0.4 }} />}
    </div>
  );
}

export function Legend({ counts }: { counts: Partial<Record<string, number>> }) {
  return (
    <div className="legend">
      {segments(counts).map((s) => (
        <span key={s.status} className={`st-${s.status}`}>
          <i className="sw" />
          <b>{s.count}</b> {s.label}
        </span>
      ))}
    </div>
  );
}

export function Meter({
  value,
  cls,
  className,
  label,
}: {
  value: number;
  cls?: string;
  className?: string;
  label?: string;
}) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div
      className={cn('meter', cls, className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label={label}
    >
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}

type ChipAim = NodeSummary['aims'][number];

function aimTip(a: ChipAim): string {
  const who = a.kind === 'qualitative' ? ` · evaluator: ${a.evaluator}` : '';
  const value =
    a.kind === 'quantitative'
      ? ` · ${a.metric ?? ''} ${formatMetricValue(a.currentValue, a)} / ${formatTarget(a)}`
      : '';
  return `${a.title}${value}${who} — ${a.status}${a.terminating ? '' : ' (non-terminating)'}`;
}

/** Node-card aim chip (mockup `.achip`): verdict glyph, label or gauge + value/target. */
export function AimChip({ aim }: { aim: ChipAim }) {
  const m = aimMeta(aim.status);
  if (aim.kind === 'quantitative') {
    const frac = attainment(aim);
    if (aim.currentValue === undefined || frac === undefined) {
      return (
        <span className={cn('achip', m.cls)} title={aimTip(aim)}>
          <Glyph name={m.icon} />
          <span className="t">{metricShortLabel(aim.metric)}</span>
          <span className="q">{formatTarget(aim)}</span>
        </span>
      );
    }
    return (
      <span className={cn('achip', m.cls)} title={aimTip(aim)}>
        <Glyph name={m.icon} />
        <span className="mg">
          <i style={{ width: `${Math.round(frac * 100)}%` }} />
        </span>
        <span className="q">
          <b>{formatMetricValue(aim.currentValue, aim)}</b>/{formatTarget(aim)}
        </span>
      </span>
    );
  }
  return (
    <span className={cn('achip', m.cls)} title={aimTip(aim)}>
      <Glyph name={m.icon} />
      <span className="t">{shortTitle(aim.title)}</span>
    </span>
  );
}

function shortTitle(title: string): string {
  return title.length > 22 ? `${title.slice(0, 21)}…` : title;
}

export function AimChips({ aims, max = 2 }: { aims: ChipAim[]; max?: number }) {
  const visible = aims.filter((a) => !a.implicit);
  const shown = visible.slice(0, max);
  const rest = visible.slice(max);
  return (
    <div className="n-aims">
      {shown.map((a) => (
        <AimChip key={a.key} aim={a} />
      ))}
      {rest.length > 0 && (
        <span className="achip-more" title={rest.map(aimTip).join('\n')}>
          +{rest.length}
        </span>
      )}
    </div>
  );
}

/** Graph header aim chip (mockup `.aimchip`). */
export function GraphAimChip({ aim, onClick }: { aim: Aim; onClick?: () => void }) {
  const m = aimMeta(aim.status);
  if (aim.kind === 'qualitative') {
    return (
      <button
        type="button"
        className={cn('aimchip qual', m.cls)}
        title={`${aim.title} — evaluator: ${aim.evaluator} · ${aim.status}`}
        onClick={onClick}
      >
        <StatusIcon status={aim.status} aim />
        <span className="lbl ellipsis">{aim.title}</span>
        <span className="who">
          <User size={12} />
          {aim.evaluator} · {m.label.toLowerCase()}
        </span>
      </button>
    );
  }
  const frac = attainment(aim) ?? 0;
  return (
    <button
      type="button"
      className={cn('aimchip', m.cls)}
      onClick={onClick}
      title={`${aim.title} · ${aim.metric} ${formatMetricValue(aim.currentValue, aim)} / ${formatTarget(aim)} · ${aim.status}${aim.guard ? ' · guard: exceeding it pauses the graph and escalates' : ''}`}
    >
      <StatusIcon status={aim.status} aim />
      <span className="lbl">{aim.title}</span>
      {aim.guard && <span className="tag">guard</span>}
      <span className="val">
        <b>{formatMetricValue(aim.currentValue, aim)}</b> / {formatTarget(aim)}
      </span>
      <Meter value={frac} cls={m.cls} className="gauge" label={`${aim.title} attainment`} />
    </button>
  );
}

// ─── Evidence and notes ──────────────────────────────────────────────────────

const EVIDENCE_ICON: Record<string, typeof Link2> = {
  url: Link2,
  file: FileText,
  commit: GitCommitHorizontal,
  pr: GitPullRequest,
  command: SquareTerminal,
  metric: Gauge,
  image: Image,
  text: Type,
  artifact: Archive,
};

export function EvidenceChip({ ev }: { ev: Evidence }) {
  const Icon = EVIDENCE_ICON[ev.kind] ?? Link2;
  const exit = ev.kind === 'command' ? (ev.meta?.exitCode as number | undefined) : undefined;
  const output = ev.kind === 'command' ? (ev.meta?.output as string | undefined) : undefined;
  const label = ev.label ?? ev.value;
  const href =
    ev.kind === 'url' || ev.kind === 'pr' || /^https?:\/\//.test(ev.value) ? ev.value : undefined;
  const chip = (
    <span
      className={cn('chip link', ev.kind !== 'url' && 'mono')}
      title={`${ev.kind}: ${ev.value}`}
    >
      <Icon />
      <span className="ellipsis" style={{ maxWidth: 260 }}>
        {label}
      </span>
      {exit !== undefined && (
        <span className={cn('exit', exit === 0 ? 'ok' : 'bad')}>exit {exit}</span>
      )}
    </span>
  );
  if (output)
    return (
      <details>
        <summary style={{ listStyle: 'none', cursor: 'pointer', display: 'inline-flex' }}>
          {chip}
        </summary>
        <pre>{output}</pre>
      </details>
    );
  if (href)
    return (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {chip}
      </a>
    );
  return chip;
}

export const NOTE_ICON: Record<string, typeof Link2> = {
  proof: CircleCheckBig,
  deliverable: Package,
  finding: Search,
  decision: Signpost,
  handoff: ArrowRightToLine,
  progress: ActivityIcon,
  question: MessageCircleQuestion,
  blocker: OctagonAlert,
  comment: MessageSquare,
};

export function NoteType({ type }: { type: string }) {
  const Icon = NOTE_ICON[type] ?? MessageSquare;
  return (
    <span className={`ntype nt-${type}`}>
      <Icon />
      {type}
    </span>
  );
}

export const NoteCard = memo(function NoteCard({
  note,
  context,
  reply,
}: {
  note: Note;
  /** Optional leading context (graph › node) for cross-graph lists. */
  context?: ReactNode;
  reply?: boolean;
}) {
  return (
    <article
      className={cn('note', note.retractedAt && 'retracted', reply && 'reply')}
      aria-label={`${note.type} note: ${note.title}`}
    >
      <div className="note-h">
        <NoteType type={note.type} />
        {note.severity && <span className={`sev sev-${note.severity}`}>{note.severity}</span>}
        {note.resolvedAt && <span className="tag">resolved</span>}
        {note.pinned && <span className="tag accent">pinned</span>}
        {context}
        <span className="when" title={note.createdAt}>
          {timeAgo(note.createdAt)}
        </span>
      </div>
      <div className="note-t">{note.title}</div>
      {note.body && (
        <div className="note-d">
          <Markdown text={note.body} />
        </div>
      )}
      {note.retractedAt && (
        <div className="note-d" style={{ textDecoration: 'none', color: 'var(--s-blocked-fg)' }}>
          Retracted: {note.retractedReason}
        </div>
      )}
      {note.metrics && Object.keys(note.metrics).length > 0 && (
        <div className="ev">
          {Object.entries(note.metrics).map(([k, v]) => (
            <span key={k} className="chip mono">
              <Gauge />
              {k} = {v}
            </span>
          ))}
        </div>
      )}
      {note.evidence.length > 0 && (
        <div className="ev">
          {note.evidence.map((ev) => (
            <EvidenceChip key={`${ev.kind}:${ev.value}:${ev.label ?? ''}`} ev={ev} />
          ))}
        </div>
      )}
      <div className="note-f">
        <AnnotLine x={note.author} />
        {note.relayedBy && (
          <>
            <span className="sep">·</span>
            <span>relayed by {note.relayedBy.agent ?? 'orchestrator'}</span>
          </>
        )}
      </div>
    </article>
  );
});

/** Notes with replies threaded under their parent. */
export function NoteThread({
  notes,
  context,
}: {
  notes: Note[];
  context?: (n: Note) => ReactNode;
}) {
  const { roots, replies } = useMemo(() => {
    const ids = new Set(notes.map((n) => n.id));
    const replies = new Map<string, Note[]>();
    const roots: Note[] = [];
    for (const n of notes) {
      if (n.replyTo && ids.has(n.replyTo))
        replies.set(n.replyTo, [...(replies.get(n.replyTo) ?? []), n]);
      else roots.push(n);
    }
    return { roots, replies };
  }, [notes]);
  return (
    <>
      {roots.map((n) => (
        <div key={n.id}>
          <NoteCard note={n} context={context?.(n)} />
          {(replies.get(n.id) ?? [])
            .slice()
            .reverse()
            .map((r) => (
              <NoteCard key={r.id} note={r} reply context={context?.(r)} />
            ))}
        </div>
      ))}
    </>
  );
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn('prose-md', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** KPI sparkline (mockup `sparkLine`): latest segment and point accented. */
export function Sparkline({
  values,
  width = 84,
  height = 28,
}: {
  values: number[];
  width?: number;
  height?: number;
}) {
  if (values.length < 2)
    return <svg className="spark-k" width={width} height={height} aria-hidden="true" />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = 3;
  const sx = (i: number) => pad + (i * (width - pad * 2)) / (values.length - 1);
  const sy = (v: number) =>
    height - pad - (max === min ? 0.5 : (v - min) / (max - min)) * (height - pad * 2);
  const pts = values.map((v, i) => `${sx(i).toFixed(1)},${sy(v).toFixed(1)}`);
  const n = values.length;
  return (
    <svg
      className="spark-k"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      aria-hidden="true"
    >
      <polyline className="sk-line" points={pts.slice(0, n - 1).join(' ')} />
      <polyline className="sk-cur" points={pts.slice(n - 2).join(' ')} />
      <circle className="sk-dot" cx={sx(n - 1)} cy={sy(values[n - 1] as number)} r={3} />
    </svg>
  );
}

export function SparkBars({
  values,
  width = 84,
  height = 28,
}: {
  values: number[];
  width?: number;
  height?: number;
}) {
  const max = Math.max(...values, 1);
  const n = Math.max(values.length, 1);
  const gap = 2;
  const bw = (width - gap * (n - 1)) / n;
  return (
    <svg
      className="spark-k"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      aria-hidden="true"
    >
      {values
        .map((v, i) => ({ v, i, id: `bar-${values.length - i}` }))
        .map(({ v, i, id }) => {
          const bh = Math.max(2, (v / max) * (height - 2));
          return (
            <rect
              key={id}
              className={cn('sk-bar', i === n - 1 && 'cur')}
              x={(i * (bw + gap)).toFixed(1)}
              y={(height - bh).toFixed(1)}
              width={bw.toFixed(1)}
              height={bh.toFixed(1)}
              rx={1.5}
            />
          );
        })}
    </svg>
  );
}

/** Quantitative aim sparkline across attempts with the target line (inspector Aims tab). */
export function AttemptSpark({
  points,
  target,
  aim,
}: {
  points: Array<{ label: string; value: number; live?: boolean }>;
  target?: number;
  aim: { metric?: string; unit?: string; target?: number; comparator?: string };
}) {
  if (points.length === 0) return null;
  const w = 170;
  const h = 56;
  const values = points.map((p) => p.value).concat(target !== undefined ? [target] : []);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const sx = (i: number) => 14 + (i * (w - 52)) / Math.max(1, points.length - 1);
  const sy = (v: number) => 8 + (1 - (v - min) / span) * (h - 16);
  const ty = target !== undefined ? sy(target) : undefined;
  return (
    <svg
      className="spark"
      width={w}
      height={h + 14}
      viewBox={`0 0 ${w} ${h + 14}`}
      role="img"
      aria-label={`${aim.metric ?? 'metric'} across attempts`}
    >
      <line x1={4} x2={w - 28} y1={h} y2={h} style={{ stroke: 'var(--line-2)' }} />
      {ty !== undefined && (
        <>
          <line
            className="sp-target"
            x1={4}
            x2={w - 28}
            y1={ty}
            y2={ty}
            style={{ stroke: 'var(--s-done)' }}
          />
          <text x={w} y={ty + 3} textAnchor="end">
            {formatMetricValue(target, aim)}
          </text>
        </>
      )}
      <polyline
        className="sp-line"
        points={points.map((p, i) => `${sx(i)},${sy(p.value)}`).join(' ')}
      />
      {points.map((p, i) => (
        <g key={p.label}>
          <circle
            cx={sx(i)}
            cy={sy(p.value)}
            r={4}
            className="sp-dot"
            style={{
              fill: p.live ? 'var(--card)' : 'var(--text-3)',
              stroke: p.live ? 'var(--s-running)' : undefined,
            }}
          />
          <text x={sx(i)} y={h + 12} textAnchor="middle">
            {p.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

export function MilestoneFlag() {
  return <Flag />;
}
