/** Shared right-drawer chrome for the node and orchestrator inspectors (resizable, 380–640 px). */
import { type ReactNode, useRef } from 'react';
import { useSettings } from '../../lib/settings';
import { cn } from '../../lib/utils';

export function InspectorDrawer({ label, children }: { label: string; children: ReactNode }) {
  const width = useSettings((s) => s.inspectorWidth);
  const set = useSettings((s) => s.set);
  const start = useRef<{ x: number; w: number } | null>(null);
  return (
    <aside className="inspector resizable" style={{ width }} aria-label={label}>
      {/* biome-ignore lint/a11y/useSemanticElements: a draggable splitter */}
      <div
        className="ins-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize inspector"
        aria-valuenow={width}
        aria-valuemin={380}
        aria-valuemax={640}
        tabIndex={0}
        onPointerDown={(e) => {
          start.current = { x: e.clientX, w: width };
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!start.current) return;
          const w = Math.max(380, Math.min(640, start.current.w + (start.current.x - e.clientX)));
          set({ inspectorWidth: w });
        }}
        onPointerUp={() => {
          start.current = null;
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') set({ inspectorWidth: Math.min(640, width + 20) });
          if (e.key === 'ArrowRight') set({ inspectorWidth: Math.max(380, width - 20) });
        }}
      />
      {children}
    </aside>
  );
}

export function InspectorTabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: Array<{ id: T; label: string; count?: number }>;
  value: T;
  onChange: (t: T) => void;
}) {
  return (
    <div className="ins-tabs" role="tablist" aria-label="Inspector sections">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={value === t.id}
          className={cn(value === t.id && 'on')}
          onClick={() => onChange(t.id)}
          data-testid={`ins-tab-${t.id}`}
        >
          {t.label}
          {t.count ? <span className="cnt">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Section({
  title,
  icon,
  right,
  children,
}: {
  title: string;
  icon?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="sec">
      <div className="sec-h">
        <span className="eyebrow">
          {icon}
          {title}
        </span>
        {right && <span className="right">{right}</span>}
      </div>
      {children}
    </section>
  );
}
