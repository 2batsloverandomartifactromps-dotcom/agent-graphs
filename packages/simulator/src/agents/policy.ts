/**
 * How simulated humans and orchestrators resolve requests, per the option catalog in
 * docs/concepts.md §11.1.
 */
import type { HumanRequest, ResolveBody } from '@agent-graphs/core';
import type { HumanRequest as WireRequest } from '@agent-graphs/sdk';
import type { World } from '../world';

export type ResolutionPolicy = {
  /** Probability of rejecting a gate when no scripted decision exists. */
  gateRejectRate?: number;
  /** Extra attempts granted per node before accepting an exhausted node. */
  maxRetries?: number;
  /** Iterations granted per loop before accepting an exhausted loop. */
  maxExtends?: number;
  /** Guards: raise the target (humans only) or waive. */
  guard?: 'raise' | 'waive' | 'fail';
  /** Plan approvals: approve or reject. */
  plan?: 'approve' | 'reject';
  /** Verification escalations: accept or fail. */
  verification?: 'accept' | 'fail';
};

type Resolution = { choice: string; comment?: string; data?: Record<string, unknown> };

export class Resolver {
  private readonly retries = new Map<string, number>();
  private readonly extends = new Map<string, number>();

  constructor(
    private readonly world: World,
    private readonly policy: ResolutionPolicy,
    private readonly who: 'human' | 'orchestrator',
  ) {}

  /** Requests whose resolution failed: retried at most twice, so a dead end cannot spin. */
  private readonly failures = new Map<string, number>();

  gaveUp(requestId: string): boolean {
    return (this.failures.get(requestId) ?? 0) >= 2;
  }

  failed(requestId: string): void {
    this.failures.set(requestId, (this.failures.get(requestId) ?? 0) + 1);
  }

  decide(r: WireRequest | HumanRequest): Resolution | undefined {
    const w = this.world;
    const nodeKey = w.nodeKeyOf(r.nodeId);
    const subject = (r as { subject: string }).subject;
    switch (subject) {
      case 'gate': {
        const scripted = nodeKey ? w.nextGateDecision(nodeKey) : undefined;
        // Unscripted rejections only for gates that trigger a loop: rejecting any other gate
        // fails it terminally (a dead end that needs an admin reopen).
        const triggersLoop = w.view?.loops.some((l) => l.fromNodeId === r.nodeId) ?? false;
        const reject = scripted
          ? scripted === 'reject'
          : triggersLoop && w.rng.chance(this.policy.gateRejectRate);
        return reject
          ? {
              choice: 'reject',
              comment: `Changes requested on ${nodeKey ?? 'this gate'}: contrast is too low in dark mode and the empty state is missing.`,
            }
          : { choice: 'approve', comment: 'Looks good.' };
      }
      case 'plan':
        return this.policy.plan === 'reject'
          ? { choice: 'reject', comment: 'Split the API work into smaller nodes first.' }
          : { choice: 'approve', comment: 'Plan approved.' };
      case 'aim':
        return { choice: 'approve', data: { verdict: 'met' }, comment: 'Verified on staging.' };
      case 'question':
        return {
          choice: 'answer',
          data: {
            text: 'Use the standard error envelope from docs/api.md and record a decision note.',
          },
        };
      case 'blocker':
        return { choice: 'unblock', data: { info: 'Credentials are now in the environment.' } };
      case 'exhaustion': {
        const key = nodeKey ?? r.id;
        const used = this.retries.get(key) ?? 0;
        if (used < (this.policy.maxRetries ?? 1)) {
          this.retries.set(key, used + 1);
          return { choice: 'retry', data: { extraAttempts: 1 }, comment: 'One more try.' };
        }
        return {
          choice: 'accept',
          data: { justification: 'Good enough for the MVP; follow-up filed.' },
        };
      }
      case 'loop': {
        const key = r.loopId ?? r.id;
        const used = this.extends.get(key) ?? 0;
        if (used < (this.policy.maxExtends ?? 1)) {
          this.extends.set(key, used + 1);
          return { choice: 'extend', data: { extraIterations: 1 }, comment: 'One more iteration.' };
        }
        return { choice: 'accept', comment: 'Accepting the current state.' };
      }
      case 'guard': {
        const mode = this.policy.guard ?? (this.who === 'human' ? 'raise' : 'waive');
        if (mode === 'fail') return { choice: 'fail', comment: 'Over budget.' };
        if (mode === 'raise' && this.who === 'human') {
          const aim = w.view?.aims.find((a) => a.id === r.aimId);
          const current = aim?.currentValue ?? aim?.target ?? 1;
          return {
            choice: 'raise_target',
            data: { target: Math.ceil(Math.max(current, aim?.target ?? 0) * 5) },
            comment: 'Budget raised.',
          };
        }
        return { choice: 'waive', data: { justification: 'Spend approved for this run.' } };
      }
      case 'stall': {
        // The engine only retries tasks; a failed gate or milestone can only be skipped.
        const kind = w.view?.nodes.find((n) => n.id === r.nodeId)?.kind;
        return kind && kind !== 'task'
          ? { choice: 'skip', data: { reason: 'Unblocking the graph; decision recorded.' } }
          : { choice: 'retry', data: { extraAttempts: 1 }, comment: 'Retry the blocking node.' };
      }
      case 'verification':
        return this.policy.verification === 'fail'
          ? { choice: 'fail', comment: 'Verification failed.' }
          : { choice: 'accept', data: { justification: 'Accepted after review.' } };
      case 'timeout':
        return { choice: 'extend', data: { duration: '30m' } };
      case 'milestone': {
        const node = w.view?.nodes.find((n) => n.id === r.nodeId);
        const aim = node?.aims.find((a) => a.status !== 'met' && a.status !== 'waived');
        return aim
          ? {
              choice: 'waive',
              data: { aimKey: aim.key, justification: 'Accepted at the milestone.' },
            }
          : { choice: 'add_work' };
      }
      default:
        return undefined;
    }
  }
}

export type { ResolveBody };
