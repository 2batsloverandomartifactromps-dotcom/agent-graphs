/**
 * Dispatch and evaluation pulses (docs/ui.md §5.1): when an orchestrator dispatches work or
 * evaluates an aim, a short accent stroke travels from its lane card to the target node.
 * Purely decorative (the event also lands in the activity feed); hidden under reduced motion.
 */
import { type RefObject, useEffect, useState } from 'react';
import { type Pulse, useLive } from '../../../lib/live';

type Drawn = { id: number; d: string };

const LIFETIME_MS = 1100;

export function DispatchPulses({
  graphId,
  containerRef,
}: {
  graphId: string;
  containerRef: RefObject<HTMLDivElement | null>;
}) {
  const pulses = useLive((s) => s.pulses);
  const [drawn, setDrawn] = useState<Drawn[]>([]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const fresh = pulses.filter((p: Pulse) => p.graphId === graphId && Date.now() - p.at < 600);
    if (!fresh.length) return;
    const box = el.getBoundingClientRect();
    const next: Drawn[] = [];
    for (const p of fresh) {
      const from = el.querySelector(`[data-testid="orch-${CSS.escape(p.orch)}"]`);
      const to = el.querySelector(`[data-testid="node-${CSS.escape(p.nodeKey)}"]`);
      if (!from || !to) continue;
      const a = from.getBoundingClientRect();
      const b = to.getBoundingClientRect();
      const sx = a.left + a.width / 2 - box.left;
      const sy = a.bottom - box.top;
      const tx = b.left + b.width / 2 - box.left;
      const ty = b.top - box.top;
      const my = sy + Math.max(30, (ty - sy) * 0.5);
      next.push({ id: p.id, d: `M${sx},${sy} C${sx},${my} ${tx},${my - 20} ${tx},${ty}` });
    }
    if (!next.length) return;
    setDrawn((cur) => [...cur.filter((c) => !next.some((n) => n.id === c.id)), ...next]);
    const ids = new Set(next.map((n) => n.id));
    const t = setTimeout(() => setDrawn((cur) => cur.filter((c) => !ids.has(c.id))), LIFETIME_MS);
    return () => clearTimeout(t);
  }, [pulses, graphId, containerRef]);

  if (!drawn.length) return null;
  return (
    <svg className="dispatch-pulses" aria-hidden="true">
      {drawn.map((p) => (
        <path key={p.id} d={p.d} pathLength={1} className="dp-path" />
      ))}
    </svg>
  );
}
