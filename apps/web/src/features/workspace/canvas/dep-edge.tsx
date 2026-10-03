/**
 * Dependency edges (docs/ui.md §5.1): `requires` solid, `informs` dashed and thinner; live
 * inputs animate; edges carrying procedural knowledge get a dot that opens a popover with
 * relation, condition, guidance, pitfalls and provenance.
 */
import { EdgeLabelRenderer, type EdgeProps } from '@xyflow/react';
import { ArrowRight, Check, Lightbulb, OctagonAlert, Sparkles, StickyNote, X } from 'lucide-react';
import { memo } from 'react';
import { cn } from '../../../lib/utils';

export type DepData = {
  kind: string;
  state: 'idle' | 'done' | 'live';
  from: string;
  to: string;
  relation?: string;
  condition?: string;
  guidance?: string;
  pitfalls?: string;
  provenance?: Record<string, unknown>;
  hoverOnly?: boolean;
  shown?: boolean;
  emphasized?: boolean;
  dim?: boolean;
  crit?: boolean;
  open?: boolean;
  markerPrefix: string;
  onToggle?: (id: string | null) => void;
};

const REL_LABEL: Record<string, string> = {
  leads_to: 'leads to',
  triggers: 'triggers',
  provides_input_for: 'provides input for',
  converges_to: 'converges to',
};

/** The mockup's horizontal-tangent bezier. */
export function edgePath(sx: number, sy: number, tx: number, ty: number): string {
  const dx = Math.max(30, (tx - sx) * 0.5);
  return `M${sx},${sy} C${sx + dx},${sy} ${tx - dx},${ty} ${tx},${ty}`;
}

function provenanceOf(
  p: Record<string, unknown> | undefined,
  field: string,
): 'learned' | 'authored' {
  const v = p?.[field] as { source?: string } | string | undefined;
  const src = typeof v === 'string' ? v : v?.source;
  return src && src !== 'authored' && src !== 'spec' ? 'learned' : 'authored';
}

export const DepEdge = memo(function DepEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
}: EdgeProps) {
  const d = data as unknown as DepData;
  const sx = sourceX + 5;
  const tx = targetX - 6;
  const path = edgePath(sx, sourceY, tx, targetY);
  const informs = d.kind === 'informs';
  const hasPk = Boolean(d.condition || d.guidance || d.pitfalls);
  const visible = !d.hoverOnly || d.shown || d.emphasized;
  const cls = informs
    ? 'e-inf'
    : d.state === 'live'
      ? 'e-req e-live'
      : d.state === 'done'
        ? 'e-req e-done'
        : 'e-req';
  const marker = informs
    ? 'inf'
    : d.state === 'live'
      ? 'live'
      : d.state === 'done'
        ? 'done'
        : 'req';
  const mx = sx + (tx - sx) * 0.5;
  const my = sourceY + (targetY - sourceY) * 0.5;
  return (
    <>
      <path
        d={path}
        fill="none"
        className={cn('edge', cls, d.emphasized && 'e-sel', d.crit && 'e-crit', d.dim && 'e-dim')}
        style={{ opacity: visible ? undefined : 0, transition: 'opacity .15s' }}
        markerEnd={`url(#${d.markerPrefix}-${marker})`}
      />
      {d.state === 'live' && !informs && (
        <path d={path} fill="none" className={cn('edge e-flow', d.dim && 'e-dim')} />
      )}
      {hasPk && visible && (
        <>
          <path
            d={path}
            className="e-hit"
            style={{
              fill: 'none',
              stroke: 'transparent',
              strokeWidth: 14,
              pointerEvents: 'stroke',
              cursor: 'pointer',
            }}
          />
          {/* biome-ignore lint/a11y/useSemanticElements: SVG has no <button>; this group is keyboard operable */}
          <g
            className={cn('pk-dot', d.open && 'on')}
            role="button"
            tabIndex={0}
            aria-label={`Edge guidance ${d.from} to ${d.to}`}
            style={{ pointerEvents: 'all', cursor: 'pointer' }}
            onClick={(e) => {
              e.stopPropagation();
              d.onToggle?.(d.open ? null : id);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                d.onToggle?.(d.open ? null : id);
              }
            }}
          >
            <circle className="pk-hit" cx={mx} cy={my} r={11} />
            <circle className="pk-ring" cx={mx} cy={my} r={6} />
            <circle className="pk-core" cx={mx} cy={my} r={3} />
          </g>
        </>
      )}
      {d.open && (
        <EdgeLabelRenderer>
          <div
            className="pk-pop on nodrag nopan"
            role="dialog"
            aria-label={`Edge guidance ${d.from} → ${d.to}`}
            style={{
              transform: `translate(${mx + 14}px, ${my + 16}px)`,
              pointerEvents: 'all',
              position: 'absolute',
              left: 0,
              top: 0,
            }}
          >
            <div className="pk-pop-h">
              <span className="mono">{d.from}</span>
              <ArrowRight size={12} />
              <span className="mono">{d.to}</span>
              <span className="rel">
                {REL_LABEL[d.relation ?? (informs ? 'provides_input_for' : 'leads_to')] ??
                  d.relation}
              </span>
              <button
                type="button"
                className="icon-btn pk-close"
                aria-label="Close"
                onClick={() => d.onToggle?.(null)}
              >
                <X size={14} />
              </button>
            </div>
            {(
              [
                ['condition', 'Condition', Check, d.condition],
                ['guidance', 'Guidance', Lightbulb, d.guidance],
                ['pitfalls', 'Pitfalls', OctagonAlert, d.pitfalls],
              ] as const
            )
              .filter(([, , , v]) => v)
              .map(([field, label, Icon, value]) => {
                const prov = provenanceOf(d.provenance, field);
                return (
                  <div key={field} className="pk-sec">
                    <div className="pk-h">
                      <Icon size={12} />
                      {label}
                    </div>
                    <div className="pk-item">
                      <span className="pk-t">{value}</span>
                      <span
                        className={cn('prov', prov)}
                        title={
                          prov === 'learned' ? 'learned from execution' : 'authored in the spec'
                        }
                      >
                        {prov === 'learned' ? <Sparkles size={10} /> : <StickyNote size={10} />}
                        {prov}
                      </span>
                    </div>
                  </div>
                );
              })}
            <div className="pk-foot">Shown in briefings under Inputs and Downstream consumers</div>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

/** Arrowhead markers shared by all edges of a canvas. */
export function EdgeMarkers({ prefix }: { prefix: string }) {
  const mk = (id: string, color: string, w = 1.6) => (
    <marker
      key={id}
      id={`${prefix}-${id}`}
      viewBox="0 0 10 10"
      refX="8.5"
      refY="5"
      markerWidth="8"
      markerHeight="8"
      markerUnits="userSpaceOnUse"
      orient="auto"
    >
      <path
        d="M2,1.5 L8.5,5 L2,8.5"
        fill="none"
        style={{ stroke: color }}
        strokeWidth={w}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </marker>
  );
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <defs>
        {mk('req', 'var(--edge)')}
        {mk('done', 'var(--edge-done)')}
        {mk('live', 'color-mix(in srgb, var(--s-running) 60%, var(--edge))')}
        {mk('inf', 'var(--edge-informs)')}
      </defs>
    </svg>
  );
}
