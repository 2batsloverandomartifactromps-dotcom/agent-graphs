import { describe, expect, it } from 'vitest';
import {
  age,
  attainment,
  formatDuration,
  formatMetricValue,
  formatTarget,
  formatTokens,
  formatUsd,
  initials,
  isRatioMetric,
  metricShortLabel,
  plural,
  timeAgo,
  timeLeft,
} from './format';

const NOW = Date.parse('2026-10-02T12:00:00Z');

describe('durations and relative times', () => {
  it('formats compact durations', () => {
    expect(formatDuration(40_000)).toBe('40s');
    expect(formatDuration(22 * 60_000)).toBe('22m');
    expect(formatDuration((3 * 60 + 12) * 60_000)).toBe('3h 12m');
    expect(formatDuration(2 * 3_600_000)).toBe('2h');
    expect(formatDuration((2 * 24 + 4) * 3_600_000)).toBe('2d 4h');
  });

  it('formats times relative to now', () => {
    expect(timeAgo('2026-10-02T11:59:58Z', NOW)).toBe('just now');
    expect(timeAgo('2026-10-02T08:48:00Z', NOW)).toBe('3h 12m ago');
    expect(timeAgo('2026-10-02T12:05:00Z', NOW)).toBe('in 5m');
    expect(timeAgo(undefined, NOW)).toBe('—');
    expect(age('2026-10-02T11:54:00Z', NOW)).toBe('6m');
    expect(timeLeft('2026-10-02T12:22:00Z', NOW)).toBe('22m left');
    expect(timeLeft('2026-10-02T11:00:00Z', NOW)).toBe('expired');
  });
});

describe('money and tokens', () => {
  it('formats usd and token counts', () => {
    expect(formatUsd(18.4)).toBe('$18.40');
    expect(formatUsd(undefined)).toBe('$0.00');
    expect(formatUsd(1234.5)).toBe('$1,235');
    expect(formatTokens(1_900_000)).toBe('1.9M tok');
    expect(formatTokens(700)).toBe('700 tok');
    expect(formatTokens(0)).toBe('0 tok');
  });
});

describe('aim metrics', () => {
  it('detects ratio metrics', () => {
    expect(isRatioMetric({ metric: 'test_pass_rate', target: 1 })).toBe(true);
    expect(isRatioMetric({ metric: 'coverage', target: 0.8 })).toBe(true);
    expect(isRatioMetric({ metric: 'search_p95_ms', target: 200 })).toBe(false);
    expect(isRatioMetric({ metric: 'cost_usd', unit: 'usd', target: 40 })).toBe(false);
  });

  it('formats values and targets with units', () => {
    expect(formatMetricValue(0.87, { metric: 'e2e_pass_rate', target: 1 })).toBe('87%');
    expect(formatMetricValue(18.4, { metric: 'cost_usd', unit: 'usd' })).toBe('$18.40');
    expect(formatMetricValue(140, { metric: 'search_p95_ms', unit: 'ms' })).toBe('140ms');
    expect(formatTarget({ metric: 'test_pass_rate', comparator: 'gte', target: 1 })).toBe('≥100%');
    expect(formatTarget({ metric: 'cost_usd', comparator: 'lte', target: 40, unit: 'usd' })).toBe(
      '≤$40.00',
    );
    expect(formatTarget({ metric: 'typecheck_errors', comparator: 'eq', target: 0 })).toBe('=0');
  });

  it('computes attainment for gauges', () => {
    expect(attainment({ comparator: 'gte', target: 1, currentValue: 0.87 })).toBeCloseTo(0.87);
    expect(attainment({ comparator: 'lte', target: 40, currentValue: 18.4 })).toBeCloseTo(0.46);
    expect(attainment({ comparator: 'eq', target: 0, currentValue: 0 })).toBe(1);
    expect(attainment({ comparator: 'gte', target: 1 })).toBeUndefined();
    expect(attainment({ comparator: 'gte', target: 1, currentValue: 2 })).toBe(1);
  });

  it('derives short chip labels', () => {
    expect(metricShortLabel('coverage')).toBe('cov');
    expect(metricShortLabel('smoke_pass_rate')).toBe('smoke');
    expect(metricShortLabel('security_findings_high')).toBe('security');
  });
});

describe('misc', () => {
  it('pluralizes and derives initials', () => {
    expect(plural(1, 'node')).toBe('1 node');
    expect(plural(3, 'node')).toBe('3 nodes');
    expect(initials('Maintainer')).toBe('M');
    expect(initials('Acme Ops Team')).toBe('AO');
    expect(initials('')).toBe('?');
  });
});
