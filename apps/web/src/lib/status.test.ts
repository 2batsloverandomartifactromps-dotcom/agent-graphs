import { NODE_STATUSES } from '@agent-graphs/core';
import { describe, expect, it } from 'vitest';
import {
  aimMeta,
  allowedGraphActions,
  allowedNodeActions,
  attemptsInActivation,
  pillTreatmentClass,
  STATUS_ORDER,
  segments,
  statusMeta,
} from './status';

describe('statusMeta', () => {
  it('covers every node status with a label, icon and hue class', () => {
    for (const s of NODE_STATUSES) {
      const m = statusMeta(s);
      expect(m.label).toBeTruthy();
      expect(m.icon).toBeTruthy();
      expect(m.cls).toBe(`st-${s}`);
    }
    expect(STATUS_ORDER).toHaveLength(NODE_STATUSES.length);
  });

  it('gives distinct fills to blocked (outlined), failed (solid) and skipped (striped)', () => {
    expect(statusMeta('blocked').treatment).toBe('outline');
    expect(statusMeta('failed').treatment).toBe('solid');
    expect(statusMeta('skipped').treatment).toBe('striped');
    expect(pillTreatmentClass('failed')).toBe('solid');
    expect(pillTreatmentClass('blocked')).toBe('outline');
    expect(pillTreatmentClass('done')).toBe('');
  });

  it('maps other entity statuses onto the same hue families', () => {
    expect(statusMeta('passed').cls).toBe('st-passed');
    expect(statusMeta('active').label).toBe('Active');
    expect(statusMeta('acknowledged').icon).toBe('done');
    expect(statusMeta('exhausted').treatment).toBe('solid');
  });

  it('falls back to a readable label for unknown statuses', () => {
    expect(statusMeta('some_new_state').label).toBe('Some new state');
    expect(statusMeta(undefined).label).toBe('Pending');
  });

  it('uses the dashed glyph for pending aims', () => {
    expect(aimMeta('pending').icon).toBe('aimpending');
    expect(aimMeta('met').cls).toBe('st-met');
  });
});

describe('segments', () => {
  it('orders non-empty statuses per the mockup legend', () => {
    expect(segments({ pending: 5, done: 2, running: 1, failed: 0 })).toEqual([
      { status: 'done', count: 2, label: 'done' },
      { status: 'running', count: 1, label: 'running' },
      { status: 'pending', count: 5, label: 'pending' },
    ]);
  });
});

describe('allowed actions', () => {
  it('follows the concepts §3.4 action table', () => {
    expect([...allowedNodeActions('running')].sort()).toEqual(['fail', 'pause', 'skip']);
    expect(allowedNodeActions('paused').has('resume')).toBe(true);
    expect(allowedNodeActions('needs_input').has('retry')).toBe(true);
    expect(allowedNodeActions('done').has('reopen')).toBe(true);
    expect(allowedNodeActions('done').has('skip')).toBe(false);
    expect(allowedNodeActions('ready', 'milestone').has('complete-manually')).toBe(false);
  });

  it('follows the graph lifecycle', () => {
    expect([...allowedGraphActions('draft', false)].sort()).toEqual(['archive', 'start']);
    expect([...allowedGraphActions('active', false)].sort()).toEqual(['cancel', 'pause']);
    expect(allowedGraphActions('completed', true).has('unarchive')).toBe(true);
  });
});

describe('attemptsInActivation', () => {
  it('counts the open or passing attempt of the current activation', () => {
    const base = { kind: 'task', countedAttempts: 1, activation: 2 };
    const open = { counted: false, activation: 2, status: 'running' };
    expect(attemptsInActivation({ ...base, status: 'running', currentAttempt: open })).toBe(2);
    expect(attemptsInActivation({ ...base, status: 'done' })).toBe(2);
    expect(attemptsInActivation({ ...base, status: 'ready' })).toBe(1);
    const failed = { counted: true, activation: 2, status: 'failed' };
    expect(attemptsInActivation({ ...base, status: 'ready', currentAttempt: failed })).toBe(1);
  });
});
