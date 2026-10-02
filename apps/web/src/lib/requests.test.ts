import { engine } from '@agent-graphs/core';
import { describe, expect, it } from 'vitest';
import { buildResolution, isApprovalStyle, optionSpec, requestOptions } from './requests';

describe('option catalog coverage', () => {
  it('describes every option the engine offers', () => {
    for (const [subject, options] of Object.entries(engine.REQUEST_OPTIONS)) {
      for (const o of options) {
        if (subject === 'proposal') continue;
        expect(optionSpec(subject, o.id), `${subject}.${o.id}`).toBeDefined();
      }
    }
  });

  it('adds a partial verdict to human-judged aims', () => {
    const opts = requestOptions('aim', engine.REQUEST_OPTIONS.aim);
    expect(opts.map((o) => o.id)).toEqual(['approve', 'partial', 'reject']);
    expect(opts[0]?.label).toBe('Met');
  });

  it('marks approvals as button-style', () => {
    expect(isApprovalStyle('approval', 'gate')).toBe(true);
    expect(isApprovalStyle('escalation', 'exhaustion')).toBe(false);
  });
});

describe('buildResolution', () => {
  it('requires a comment to reject a gate', () => {
    expect(buildResolution('gate', 'reject', {})).toEqual({
      ok: false,
      error: 'What should change is required.',
    });
    expect(buildResolution('gate', 'reject', { comment: 'Use argon2id' })).toEqual({
      ok: true,
      body: { choice: 'reject', comment: 'Use argon2id' },
    });
    expect(buildResolution('gate', 'approve', {})).toEqual({
      ok: true,
      body: { choice: 'approve' },
    });
  });

  it('builds retry data with extraAttempts', () => {
    expect(buildResolution('exhaustion', 'retry', { extraAttempts: '2' })).toEqual({
      ok: true,
      body: { choice: 'retry', data: { extraAttempts: 2 } },
    });
    expect(buildResolution('exhaustion', 'retry', { extraAttempts: '0' }).ok).toBe(false);
    // the default applies when the field is left empty
    expect(buildResolution('exhaustion', 'retry', {})).toEqual({
      ok: true,
      body: { choice: 'retry', data: { extraAttempts: 2 } },
    });
  });

  it('requires a justification to accept and mirrors it into the comment', () => {
    expect(buildResolution('exhaustion', 'accept', {}).ok).toBe(false);
    expect(buildResolution('exhaustion', 'accept', { justification: 'Within tolerance' })).toEqual({
      ok: true,
      body: {
        choice: 'accept',
        comment: 'Within tolerance',
        data: { justification: 'Within tolerance' },
      },
    });
  });

  it('builds edit & retry patches', () => {
    expect(
      buildResolution('exhaustion', 'edit_retry', { prompt: 'Do X', extraAttempts: '1' }),
    ).toEqual({
      ok: true,
      body: { choice: 'edit_retry', data: { patch: { prompt: 'Do X' }, extraAttempts: 1 } },
    });
  });

  it('maps aim verdicts onto approve/reject', () => {
    expect(buildResolution('aim', 'partial', {})).toEqual({
      ok: true,
      body: { choice: 'approve', data: { verdict: 'partial' } },
    });
    expect(buildResolution('aim', 'approve', { comment: 'Feels instant' })).toEqual({
      ok: true,
      body: { choice: 'approve', comment: 'Feels instant', data: { verdict: 'met' } },
    });
    expect(buildResolution('aim', 'reject', {}).ok).toBe(false);
  });

  it('validates numbers and durations', () => {
    expect(buildResolution('guard', 'raise_target', { target: 'abc' }).ok).toBe(false);
    expect(buildResolution('guard', 'raise_target', { target: '60' })).toEqual({
      ok: true,
      body: { choice: 'raise_target', data: { target: 60 } },
    });
    expect(buildResolution('timeout', 'extend', { duration: 'soon' }).ok).toBe(false);
    expect(buildResolution('timeout', 'extend', { duration: '2h' })).toEqual({
      ok: true,
      body: { choice: 'extend', data: { duration: '2h' } },
    });
  });

  it('answers questions and unblocks blockers', () => {
    expect(buildResolution('question', 'answer', { text: 'Yes, 30 days' })).toEqual({
      ok: true,
      body: { choice: 'answer', comment: 'Yes, 30 days', data: { text: 'Yes, 30 days' } },
    });
    expect(buildResolution('blocker', 'unblock', { info: 'vault://x' })).toEqual({
      ok: true,
      body: { choice: 'unblock', comment: 'vault://x', data: { info: 'vault://x' } },
    });
  });
});
