/**
 * Loop bodies as tinted rounded regions with `↺ name · i/max`, plus the dashed back-edge from
 * the trigger to the entry routed above the body with an iteration pill (docs/ui.md §5.1).
 * Exhausted loops turn red; satisfied loops show a check.
 */
import type { NodeProps } from '@xyflow/react';
import { Check, RefreshCw } from 'lucide-react';
import { memo, useId } from 'react';
import type { Rect } from '../../../lib/layout';
import { cn } from '../../../lib/utils';

export type LoopData = {
  key: string;
  title?: string;
  status: string;
  iteration: number;
  max: number;
  width: number;
  height: number;
  /** Trigger and entry rects relative to the region's top-left. */
  trigger?: Rect;
  entry?: Rect;
  dim?: boolean;
};

export const LoopRegionNode = memo(function LoopRegionNode({ data }: NodeProps) {
  const d = data as unknown as LoopData;
  const markerId = useId().replace(/:/g, '');
  const satisfied = d.status === 'satisfied';
  let path: string | undefined;
  let pill: { x: number; y: number } | undefined;
  if (d.trigger && d.entry) {
    const r = 12;
    const sx = d.trigger.x + 44;
    const sy = d.trigger.y - 1;
    const ex = d.entry.x + d.entry.width - 56;
    const ey = d.entry.y - 3;
    const yTop = -20;
    const dir = sx >= ex ? -1 : 1;
    path = `M${sx},${sy} L${sx},${yTop + r} Q${sx},${yTop} ${sx + dir * r},${yTop} L${ex - dir * r},${yTop} Q${ex},${yTop} ${ex},${yTop + r} L${ex},${ey}`;
    pill = { x: (sx + ex) / 2, y: yTop };
  }
  const label = `${d.key} · ${d.status} · iteration ${d.iteration} of ${d.max}`;
  return (
    <div
      className={cn('loop-region', d.status !== 'active' && d.status, d.dim && 'e-dim')}
      style={{ width: d.width, height: d.height }}
      role="img"
      aria-label={`Loop ${label}`}
    >
      <span className="lr-label" style={{ left: 'auto', right: 14 }}>
        {satisfied ? <Check size={13} /> : <RefreshCw size={13} />}
        <span className="mono">{d.key}</span>
        <span className="muted">loop body</span>
      </span>
      {path && (
        <svg
          width={d.width}
          height={d.height}
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            overflow: 'visible',
            pointerEvents: 'none',
          }}
          aria-hidden="true"
        >
          <defs>
            <marker
              id={markerId}
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
                style={{ stroke: 'var(--accent)' }}
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </marker>
          </defs>
          <path className="e-loop-halo" d={path} fill="none" />
          <path
            className={cn('e-loop', d.status)}
            d={path}
            fill="none"
            markerEnd={`url(#${markerId})`}
          />
        </svg>
      )}
      {pill && (
        <span
          className={cn('loop-pill', d.status !== 'active' && d.status)}
          style={{ left: pill.x, top: pill.y }}
          title={`Loop ${label}`}
        >
          {satisfied ? <Check size={13} /> : <RefreshCw size={13} />}
          iteration {d.iteration}/{d.max}
          <span className="muted">· {d.status}</span>
        </span>
      )}
    </div>
  );
});
