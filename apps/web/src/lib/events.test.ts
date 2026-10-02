import { describe, expect, it } from 'vitest';
import { type AnyEvent, actorName, describeEvent, eventNodeKey } from './events';

const base = (partial: Partial<AnyEvent>): AnyEvent => ({
  seq: 1,
  graphId: 'gr_1',
  type: 'node.status_changed',
  actor: { kind: 'agent', agent: 'api-builder' },
  payload: {},
  createdAt: '2026-10-02T12:00:00Z',
  entity: { type: 'node', id: 'nd_1' },
  ...partial,
});

describe('describeEvent', () => {
  it('describes status changes with the target status tone', () => {
    const d = describeEvent(
      base({ payload: { from: 'ready', to: 'running', key: 'implement-api' } }),
    );
    expect(d.tone).toBe('st-running');
    expect(d.verb).toBe('moved ready → running');
    expect(d.target).toBe('implement-api');
    expect(d.significant).toBe(true);
  });

  it('describes progress steps and verdicts', () => {
    expect(
      describeEvent(
        base({
          type: 'attempt.progress',
          entity: { type: 'attempt', id: 'at' },
          snapshot: { nodeKey: 'x' },
          payload: { step: 'Fixing' },
        }),
      ),
    ).toMatchObject({ verb: 'started step', target: 'x', detail: 'Fixing' });
    expect(
      describeEvent(base({ type: 'aim.evaluated', payload: { verdict: 'met', key: 'layering' } })),
    ).toMatchObject({
      tone: 'st-met',
      verb: 'judged met',
      target: 'layering',
    });
  });

  it('falls back for unknown types', () => {
    expect(
      describeEvent(base({ type: 'session.compacted', entity: { type: 'session', id: 's' } })),
    ).toMatchObject({
      verb: 'compacted session',
      significant: false,
    });
  });
});

describe('helpers', () => {
  it('resolves node keys through a lookup', () => {
    expect(eventNodeKey(base({}), (id) => (id === 'nd_1' ? 'one' : undefined))).toBe('one');
    expect(
      eventNodeKey(
        base({ entity: { type: 'request', id: 'r' }, payload: { nodeId: 'nd_1' } }),
        () => 'one',
      ),
    ).toBe('one');
  });

  it('names actors', () => {
    expect(actorName({ kind: 'human', agent: 'Maintainer' })).toBe('Maintainer');
    expect(actorName({ kind: 'system' })).toBe('system');
    expect(actorName({ kind: 'agent', model: 'claude-opus-5-5' })).toBe('claude-opus-5-5');
  });
});
