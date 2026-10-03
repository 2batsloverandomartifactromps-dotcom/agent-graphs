/** Formatting helpers for times, money, tokens, and aim metrics (pure; injectable `now`). */

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function toMs(value: string | number | undefined | null): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') return value;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : t;
}

/** Compact duration: `40s`, `22m`, `3h 12m`, `2d 4h`. */
export function formatDuration(ms: number): string {
  const abs = Math.max(0, Math.round(ms));
  if (abs < MIN) return `${Math.floor(abs / SEC)}s`;
  if (abs < HOUR) return `${Math.floor(abs / MIN)}m`;
  if (abs < DAY) {
    const h = Math.floor(abs / HOUR);
    const m = Math.floor((abs % HOUR) / MIN);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(abs / DAY);
  const h = Math.floor((abs % DAY) / HOUR);
  return h ? `${d}d ${h}h` : `${d}d`;
}

/** `just now`, `40s ago`, `3h 12m ago`; future times read `in 5m`. */
export function timeAgo(value: string | number | undefined, now = Date.now()): string {
  const t = toMs(value);
  if (t === undefined) return '—';
  const diff = now - t;
  if (Math.abs(diff) < 5 * SEC) return 'just now';
  if (diff < 0) return `in ${formatDuration(-diff)}`;
  return `${formatDuration(diff)} ago`;
}

/** Short age for dense rows: `6m`, `1h 36m`. */
export function age(value: string | number | undefined, now = Date.now()): string {
  const t = toMs(value);
  if (t === undefined) return '—';
  const diff = now - t;
  if (diff < 5 * SEC) return 'now';
  return formatDuration(diff);
}

/** Time remaining until `value` (`22m left`, `expired`). */
export function timeLeft(value: string | number | undefined, now = Date.now()): string {
  const t = toMs(value);
  if (t === undefined) return '—';
  const diff = t - now;
  if (diff <= 0) return 'expired';
  return `${formatDuration(diff)} left`;
}

export function formatUsd(value: number | undefined, digits = 2): string {
  if (value === undefined || !Number.isFinite(value)) return '$0.00';
  if (value >= 1000) return `$${Math.round(value).toLocaleString('en-US')}`;
  return `$${value.toFixed(digits)}`;
}

export function formatTokens(value: number | undefined): string {
  if (!value) return '0 tok';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M tok`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k tok`;
  return `${value} tok`;
}

export function totalTokens(
  usage: { inputTokens?: number; outputTokens?: number } | undefined,
): number {
  return (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
}

export function formatPercent(ratio: number, digits = 0): string {
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function formatClock(value: string | number | undefined): string {
  const t = toMs(value);
  if (t === undefined) return '—';
  return new Date(t).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function formatDateTime(value: string | number | undefined): string {
  const t = toMs(value);
  if (t === undefined) return '—';
  return new Date(t).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

// ─── Aim metrics ─────────────────────────────────────────────────────────────

export const COMPARATOR_SYMBOL: Record<string, string> = {
  gte: '≥',
  gt: '>',
  lte: '≤',
  lt: '<',
  eq: '=',
  neq: '≠',
  between: '∈',
};

export type QuantAim = {
  metric?: string;
  comparator?: string;
  target?: number;
  targetMax?: number;
  unit?: string;
  currentValue?: number;
};

/**
 * Whether a metric reads best as a percentage: explicit `ratio`/`%` units, or the common
 * `_rate`/`_ratio`/`coverage` names with targets in [0, 1].
 */
export function isRatioMetric(aim: QuantAim): boolean {
  if (aim.unit === 'ratio' || aim.unit === '%') return true;
  if (aim.unit) return false;
  const name = aim.metric ?? '';
  const ratioName = /(_rate|_ratio|^coverage|_coverage|_pct)$/.test(name) || name === 'coverage';
  return ratioName && (aim.target === undefined || (aim.target >= 0 && aim.target <= 1));
}

/** Format one metric value with the aim's unit (`87%`, `$18.40`, `140ms`, `0`). */
export function formatMetricValue(value: number | undefined, aim: QuantAim): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  if (isRatioMetric(aim)) return `${trimNumber(value * 100)}%`;
  switch (aim.unit) {
    case 'usd':
      return formatUsd(value);
    case 'ms':
      return `${trimNumber(value)}ms`;
    case 's':
      return `${trimNumber(value)}s`;
    case 'h':
    case 'hours':
      return `${trimNumber(value)}h`;
    case 'count':
    case undefined:
      return trimNumber(value);
    default:
      return `${trimNumber(value)} ${aim.unit}`;
  }
}

/** `≥100%`, `≤$40`, `∈ 1–5`. */
export function formatTarget(aim: QuantAim): string {
  const sym = COMPARATOR_SYMBOL[aim.comparator ?? 'gte'] ?? '';
  if (aim.comparator === 'between')
    return `${sym} ${formatMetricValue(aim.target, aim)}–${formatMetricValue(aim.targetMax, aim)}`;
  return `${sym}${formatMetricValue(aim.target, aim)}`;
}

/**
 * Attainment in [0, 1] for gauges: how close the current value is to satisfying the target.
 * For "at most" comparators, the fraction is the share of the budget used, capped at 1.
 */
export function attainment(aim: QuantAim): number | undefined {
  const v = aim.currentValue;
  const t = aim.target;
  if (v === undefined || t === undefined) return undefined;
  switch (aim.comparator) {
    case 'lte':
    case 'lt':
      if (t === 0) return v <= 0 ? 1 : 0;
      return clamp01(v / t);
    case 'eq':
      return Math.abs(v - t) <= 1e-9 ? 1 : t === 0 ? 0 : clamp01(1 - Math.abs(v - t) / Math.abs(t));
    case 'neq':
      return Math.abs(v - t) > 1e-9 ? 1 : 0;
    case 'between':
      return v >= t && v <= (aim.targetMax ?? t) ? 1 : 0;
    default:
      if (t === 0) return v >= 0 ? 1 : 0;
      return clamp01(v / t);
  }
}

/** Short label for a quantitative aim chip when no value is measured yet (`cov`, `smoke`). */
export function metricShortLabel(metric: string | undefined): string {
  if (!metric) return 'metric';
  const words = metric
    .split('_')
    .filter((w) => !['rate', 'pass', 'ratio', 'ms', 'pct'].includes(w));
  const first = words[0] ?? metric;
  if (first === 'coverage') return 'cov';
  return first.length > 10 ? `${first.slice(0, 9)}…` : first;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export function trimNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  const fixed = Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(2);
  return fixed.replace(/\.?0+$/, '');
}

/** Pluralize: `plural(1, 'node')` → `1 node`. */
export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

/** Initials for avatars (`Maintainer` → `M`, `Acme Ops` → `AO`). */
export function initials(name: string | undefined): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p.charAt(0).toUpperCase()).join('') || '?';
}
