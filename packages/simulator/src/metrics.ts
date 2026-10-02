/** Metric values that satisfy or violate a quantitative aim (for simulated submissions). */
import type { Aim } from '@agent-graphs/sdk';

type Target = Pick<Aim, 'comparator' | 'target' | 'targetMax'>;

const step = (t: number) => Math.max(Math.abs(t) * 0.1, 0.05);

export function satisfying(aim: Target): number {
  const t = aim.target ?? 1;
  switch (aim.comparator) {
    case 'gt':
      return t + step(t);
    case 'lte':
      return t > 0 ? round(t * 0.8) : t;
    case 'lt':
      return t > 0 ? round(t * 0.8) : t - 1;
    case 'neq':
      return t + 1;
    case 'between':
      return round((t + (aim.targetMax ?? t)) / 2);
    default:
      return t;
  }
}

export function violating(aim: Target): number {
  const t = aim.target ?? 1;
  switch (aim.comparator) {
    case 'gte':
      return t > 0 ? round(t * 0.92) : t - 1;
    case 'gt':
      return t;
    case 'lte':
      return round(t * 1.25 + step(t));
    case 'lt':
      return t;
    case 'eq':
      return t + 1;
    case 'neq':
      return t;
    case 'between':
      return round((aim.targetMax ?? t) + step(aim.targetMax ?? t) + 1);
    default:
      return t - 1;
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
