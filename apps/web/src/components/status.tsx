/**
 * Status glyphs and pills (docs/ui.md §6.1). Glyph paths come from the design mockup; every
 * status pairs its icon with a label, so color is never the only signal.
 */
import type { ReactNode } from 'react';
import { aimMeta, pillTreatmentClass, type StatusIconName, statusMeta } from '../lib/status';
import { cn } from '../lib/utils';

const GLYPHS: Record<StatusIconName, ReactNode> = {
  pending: <circle cx="12" cy="12" r="8.5" strokeDasharray="3.2 2.6" />,
  aimpending: <circle cx="12" cy="12" r="8.5" strokeDasharray="3.2 2.6" />,
  ready: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M10.2 8.6 15.4 12l-5.2 3.4z" fill="currentColor" strokeWidth="1.2" />
    </>
  ),
  running: (
    <>
      <circle cx="12" cy="12" r="8.5" opacity=".28" />
      <path d="M20.5 12A8.5 8.5 0 0 0 12 3.5" className="spin" />
    </>
  ),
  evaluating: (
    <>
      <path d="M12 3v18" />
      <path d="M7 21h10" />
      <path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2" />
      <path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" />
      <path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" />
    </>
  ),
  needs_input: (
    <>
      <path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2" />
      <path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2" />
      <path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8" />
      <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
    </>
  ),
  blocked: (
    <>
      <path d="M15.31 2a2 2 0 0 1 1.42.59l4.68 4.68A2 2 0 0 1 22 8.69v6.62a2 2 0 0 1-.59 1.42l-4.68 4.68a2 2 0 0 1-1.42.59H8.69a2 2 0 0 1-1.42-.59l-4.68-4.68A2 2 0 0 1 2 15.31V8.69a2 2 0 0 1 .59-1.42l4.68-4.68A2 2 0 0 1 8.69 2z" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </>
  ),
  paused: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M10 15V9" />
      <path d="M14 15V9" />
    </>
  ),
  done: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12.2 2.4 2.4 4.6-4.9" />
    </>
  ),
  met: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12.2 2.4 2.4 4.6-4.9" />
    </>
  ),
  failed: (
    <>
      <circle cx="12" cy="12" r="9.5" fill="currentColor" stroke="none" />
      <path d="m15 9-6 6M9 9l6 6" stroke="var(--card)" strokeWidth="2.2" />
    </>
  ),
  unmet: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m15 9-6 6M9 9l6 6" />
    </>
  ),
  partial: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" />
    </>
  ),
  waived: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12h8" />
    </>
  ),
  skipped: (
    <>
      <path d="M5 4.5 15 12 5 19.5z" />
      <path d="M19 5v14" />
    </>
  ),
  cancelled: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m5.7 5.7 12.6 12.6" />
    </>
  ),
};

export function Glyph({
  name,
  size,
  className,
}: {
  name: StatusIconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={cn('i', className)}
      viewBox="0 0 24 24"
      aria-hidden="true"
      {...(size ? { width: size, height: size, style: { width: size, height: size } } : {})}
    >
      {GLYPHS[name]}
    </svg>
  );
}

/** A colored status glyph (icon only; pair it with visible text or an aria-label). */
export function StatusIcon({
  status,
  aim,
  size,
  label,
  className,
}: {
  status: string;
  aim?: boolean;
  size?: number;
  label?: boolean;
  className?: string;
}) {
  const m = aim ? aimMeta(status) : statusMeta(status);
  return (
    <span
      className={cn('sicon', m.cls, className)}
      {...(label ? { role: 'img', 'aria-label': m.label } : {})}
    >
      <Glyph name={m.icon} {...(size ? { size } : {})} />
    </span>
  );
}

export function StatusPill({
  status,
  label,
  lg,
  className,
  title,
}: {
  status: string;
  label?: string;
  lg?: boolean;
  className?: string;
  title?: string;
}) {
  const m = statusMeta(status);
  return (
    <span
      className={cn('pill', m.cls, pillTreatmentClass(status), lg && 'lg', className)}
      title={title}
    >
      <Glyph name={m.icon} />
      {label ?? m.label}
    </span>
  );
}

/** Inline status label: glyph + label in the status text color (node card heads). */
export function StatusLabel({ status, className }: { status: string; className?: string }) {
  const m = statusMeta(status);
  return (
    <span className={cn('n-status', m.cls, className)}>
      <Glyph name={m.icon} />
      {m.label}
    </span>
  );
}
