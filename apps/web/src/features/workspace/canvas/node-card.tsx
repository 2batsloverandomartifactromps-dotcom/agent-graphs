/**
 * Node cards (docs/ui.md §5.2): status icon + label, mono key, attempts, loop mark, title, aim,
 * progress and current step (running), aim chips, executor badge and note counts. Gates get the
 * shield band and inline approval; milestones are a compact flag pill. Level of detail collapses
 * cards below 60% zoom and to dots below 35%.
 */
import type { NodeSummary } from '@agent-graphs/sdk';
import { Handle, type NodeProps, Position, useStore } from '@xyflow/react';
import {
  Check,
  CircleCheckBig,
  Clock,
  Cpu,
  FileText,
  Flag,
  Package,
  RefreshCw,
  Search,
  Target,
  User,
} from 'lucide-react';
import { createContext, memo, useContext, useEffect, useState } from 'react';
import { AimChips } from '../../../components/display';
import { ExecBadge } from '../../../components/exec-badge';
import { Glyph, StatusIcon, StatusLabel } from '../../../components/status';
import { age } from '../../../lib/format';
import { PORT_Y } from '../../../lib/layout';
import { useLive } from '../../../lib/live';
import { attemptsInActivation, statusMeta } from '../../../lib/status';
import { cn } from '../../../lib/utils';
import { modelInfo } from '../../../lib/vocab';

export type NoteCounts = {
  deliverable?: number;
  proof?: number;
  finding?: number;
  other?: number;
  total: number;
};
export type LoopMark = {
  key: string;
  status: string;
  iteration: number;
  max: number;
  role: 'trigger' | 'entry' | 'body';
};

export type CardData = {
  node: NodeSummary;
  loopMarks: LoopMark[];
  notes?: NoteCounts;
  gateRequestId?: string;
  stale?: boolean;
  mismatch?: string;
  dim?: boolean;
  hl?: boolean;
  crit?: boolean;
  selected?: boolean;
  awaiting?: number;
};

export type CanvasActions = {
  readOnly: boolean;
  onApprove: (requestId: string, nodeKey: string) => void;
  onReview: (nodeKey: string) => void;
};

export const CanvasActionsContext = createContext<CanvasActions>({
  readOnly: true,
  onApprove: () => {},
  onReview: () => {},
});

export type LodLevel = 'full' | 'mid' | 'dot';
export function useLod(): LodLevel {
  return useStore((s) => (s.transform[2] >= 0.6 ? 'full' : s.transform[2] >= 0.35 ? 'mid' : 'dot'));
}

function useFlash(id: string): boolean {
  const touched = useLive((s) => s.touched[id]);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (!touched || Date.now() - touched > 1500) return;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 650);
    return () => clearTimeout(t);
  }, [touched]);
  return flash;
}

export function ariaLabel(n: NodeSummary): string {
  const parts = [n.key, statusMeta(n.status).label.toLowerCase()];
  if (n.kind === 'task') {
    parts.push(`attempt ${attemptsInActivation(n)} of ${n.maxAttempts}`);
  } else parts.push(n.kind);
  if (n.status === 'running' && n.currentAttempt?.progress !== undefined)
    parts.push(`${n.currentAttempt.progress} percent`);
  if (n.statusReason) parts.push(n.statusReason);
  return parts.join(', ');
}

function LoopMarks({ marks }: { marks: LoopMark[] }) {
  return (
    <>
      {marks.map((m) => {
        const active = m.status === 'active' || m.status === 'exhausted';
        if (!active && m.role === 'body') return null;
        return (
          <span
            key={m.key}
            className={cn('n-loop', !active && 'idle')}
            title={`${m.key} · ${m.status} · iteration ${m.iteration}/${m.max} · ${m.role}`}
            role="img"
            aria-label={`loop ${m.key} iteration ${m.iteration} of ${m.max}`}
          >
            <RefreshCw />
          </span>
        );
      })}
    </>
  );
}

function NoteCountsRow({ counts }: { counts?: NoteCounts }) {
  if (!counts || counts.total === 0) return <div className="n-notes" />;
  const items: Array<[string, number, typeof Package]> = [];
  if (counts.deliverable) items.push(['deliverable', counts.deliverable, Package]);
  if (counts.proof) items.push(['proof', counts.proof, CircleCheckBig]);
  if (counts.finding) items.push(['finding', counts.finding, Search]);
  return (
    <div className="n-notes" title={`${counts.total} notes`}>
      {items.map(([type, n, Icon]) => (
        <span key={type} className={`nt-${type}`} title={`${n} ${type} note${n === 1 ? '' : 's'}`}>
          <Icon />
          {n}
        </span>
      ))}
      {counts.other ? (
        <span title={`${counts.other} other notes`}>
          <FileText />
          {counts.other}
        </span>
      ) : null}
    </div>
  );
}

function Ports({ milestone }: { milestone?: boolean }) {
  const style = milestone ? undefined : { top: PORT_Y };
  return (
    <>
      <span className="port in" aria-hidden="true" />
      <span className="port out" aria-hidden="true" />
      <Handle type="target" position={Position.Left} style={style} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={style} isConnectable={false} />
    </>
  );
}

function Footer({ n, mismatch, notes }: { n: NodeSummary; mismatch?: string; notes?: NoteCounts }) {
  const exec = n.currentAttempt?.executor;
  const hint = n.executor;
  return (
    <div className="n-foot">
      {exec ? (
        <ExecBadge x={exec} {...(mismatch ? { mismatch } : {})} />
      ) : hint?.model ? (
        <span className="hint" title="Executor hint (recommended)">
          <Cpu size={12} />
          {modelInfo(hint.model, hint.provider).name}
          {hint.thinking ? ` · ${hint.thinking}` : ''}
        </span>
      ) : (
        <span className="hint">{n.kind === 'task' ? 'Any executor' : ''}</span>
      )}
      <NoteCountsRow counts={notes} />
    </div>
  );
}

function TaskCard({ d, lod }: { d: CardData; lod: LodLevel }) {
  const n = d.node;
  const a = n.currentAttempt;
  const attemptNo = attemptsInActivation(n);
  if (lod === 'mid')
    return (
      <>
        <div className="n-head">
          <StatusLabel status={n.status} />
          <span className="n-att">
            <RefreshCw />
            {attemptNo}/{n.maxAttempts}
          </span>
        </div>
        <div className="n-title">{n.title}</div>
      </>
    );
  return (
    <>
      <div className="n-head">
        <StatusLabel status={n.status} />
        {(n.priority === 'p0' || n.priority === 'p1') && (
          <span className="n-prio">{n.priority.toUpperCase()}</span>
        )}
        {d.stale && (
          <span className="stale" title="No heartbeat for more than twice the cadence">
            <Clock />
            stale
          </span>
        )}
        <span className="n-att" title={`attempt ${attemptNo} of ${n.maxAttempts}`}>
          <RefreshCw />
          {attemptNo}/{n.maxAttempts}
        </span>
        <LoopMarks marks={d.loopMarks} />
      </div>
      <div className="n-title" title={n.title}>
        {n.title}
      </div>
      <div className="n-key">{n.key}</div>
      {n.aim && (
        <div className="n-aim" title={n.aim}>
          <Target />
          <span className="ellipsis">{n.aim}</span>
        </div>
      )}
      <AimChips aims={n.aims} />
      {n.status === 'running' && (
        <div className="n-prog">
          <div className="row1">
            <span className="ellipsis">{a?.currentStep ?? 'Working…'}</span>
            <span className="pc">{a?.progress ?? 0}%</span>
          </div>
          <div className="meter st-running">
            <i style={{ width: `${a?.progress ?? 0}%` }} />
          </div>
        </div>
      )}
      {(n.status === 'blocked' ||
        n.status === 'failed' ||
        n.status === 'needs_input' ||
        n.status === 'paused') && (
        <div className={cn('n-note', statusMeta(n.status).cls)} title={n.statusReason}>
          <Glyph name={statusMeta(n.status).icon} />
          <span className="ellipsis">{n.statusReason ?? statusMeta(n.status).label}</span>
          {n.status === 'needs_input' && <span className="t">{age(n.updatedAt)}</span>}
        </div>
      )}
      {n.status === 'evaluating' && (
        <div className="n-note st-evaluating" title="Submitted — waiting for evaluators">
          <Glyph name="evaluating" />
          <span className="ellipsis">
            Awaiting {d.awaiting ?? 1} verdict{(d.awaiting ?? 1) === 1 ? '' : 's'}
          </span>
          <span className="t">{age(a?.submittedAt ?? n.updatedAt)}</span>
        </div>
      )}
      <Footer
        n={n}
        {...(d.mismatch ? { mismatch: d.mismatch } : {})}
        {...(d.notes ? { notes: d.notes } : {})}
      />
    </>
  );
}

function GateCard({ d, lod }: { d: CardData; lod: LodLevel }) {
  const n = d.node;
  const actions = useContext(CanvasActionsContext);
  const waiting = n.status === 'needs_input';
  const m = statusMeta(n.status);
  return (
    <>
      <div className={cn('gate-band', m.cls)}>
        <span className="dia" aria-hidden="true">
          <i />
        </span>
        Gate · {n.aims.find((x) => x.implicit)?.evaluator ?? 'human'}
        <LoopMarks marks={d.loopMarks} />
        <StatusLabel status={n.status} />
      </div>
      <div className="n-title">{n.title}</div>
      {lod === 'full' && (
        <>
          <span className="n-key">{n.key}</span>
          {n.aim && (
            <div className="n-aim" title={n.aim}>
              <Target />
              <span className="ellipsis">{n.aim}</span>
            </div>
          )}
          <div className="gate-decision">
            {waiting ? (
              <>
                <StatusIcon status="needs_input" />
                <span>
                  Awaiting approval ·{' '}
                  <b className="num" style={{ color: 'var(--text)' }}>
                    {age(n.updatedAt)}
                  </b>
                </span>
              </>
            ) : n.status === 'done' ? (
              <>
                <span className="avatar person" aria-hidden="true">
                  <User size={11} />
                </span>
                <span>Approved{n.completedAt ? ` · ${age(n.completedAt)} ago` : ''}</span>
              </>
            ) : (
              <>
                <StatusIcon status={n.status} />
                <span className="muted">{n.statusReason ?? 'Waits for its prerequisites'}</span>
              </>
            )}
          </div>
          {waiting && !actions.readOnly && d.gateRequestId ? (
            <div className="gate-cta">
              <button
                type="button"
                className="btn sm success nodrag"
                onClick={(e) => {
                  e.stopPropagation();
                  actions.onApprove(d.gateRequestId as string, n.key);
                }}
              >
                <Check />
                Approve
              </button>
              <button
                type="button"
                className="btn sm nodrag"
                onClick={(e) => {
                  e.stopPropagation();
                  actions.onReview(n.key);
                }}
              >
                Review
              </button>
            </div>
          ) : (
            <div style={{ height: 12 }} />
          )}
        </>
      )}
      {lod !== 'full' && <div style={{ height: 10 }} />}
    </>
  );
}

function MilestoneCard({ d }: { d: CardData }) {
  const n = d.node;
  const m = statusMeta(n.status);
  return (
    <>
      <span className="flag">
        <Flag />
      </span>
      <div className="col" style={{ gap: 2, minWidth: 0 }}>
        <span className="m-title ellipsis">{n.title}</span>
        <span className="row" style={{ gap: 6 }}>
          <span className={cn('n-status', m.cls)} style={{ fontSize: 11 }}>
            <Glyph name={m.icon} />
            {m.label}
          </span>
          <span className="n-key">{n.key}</span>
        </span>
      </div>
    </>
  );
}

export const NodeCard = memo(function NodeCard({ data }: NodeProps) {
  const d = data as unknown as CardData;
  const n = d.node;
  const lod = useLod();
  const flash = useFlash(n.id);
  const m = statusMeta(n.status);
  if (lod === 'dot')
    return (
      <div
        className={cn('node-dot', m.cls, d.dim && 'dim')}
        title={`${n.title} — ${m.label}`}
        data-testid={`node-${n.key}`}
        data-status={n.status}
      >
        <Ports milestone={n.kind === 'milestone'} />
        <i />
      </div>
    );
  return (
    <div
      className={cn(
        'node',
        n.kind,
        m.cls,
        d.selected && 'sel',
        d.dim && 'dim',
        d.hl && 'hl',
        d.crit && 'crit',
        flash && 'flash-node',
        lod === 'mid' && 'lod-mid',
      )}
      data-testid={`node-${n.key}`}
      data-status={n.status}
    >
      <Ports milestone={n.kind === 'milestone'} />
      {n.kind === 'gate' ? (
        <GateCard d={d} lod={lod} />
      ) : n.kind === 'milestone' ? (
        <MilestoneCard d={d} />
      ) : (
        <TaskCard d={d} lod={lod} />
      )}
    </div>
  );
});
