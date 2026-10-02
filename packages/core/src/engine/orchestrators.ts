/** Orchestrator lifecycle (docs/concepts.md §8): attach (lease), heartbeat, detach, human control. */
import type { OrchestratorStatus } from '../vocabulary';
import { createNote } from './requests';
import { EngineError, type GraphState, type Orchestrator, type Tx } from './types';

export const ORCHESTRATOR_LEASE_SEC = 1800;

export function orchestratorByKey(state: GraphState, key: string): Orchestrator {
  const o = [...state.orchestrators.values()].find((x) => x.key === key);
  if (!o)
    throw new EngineError('NOT_FOUND', `Orchestrator '${key}' does not exist.`, undefined, 404);
  return o;
}

/** Take the role's lease. Another live session holding it → 409; a lapsed lease is a handoff. */
export function attachOrchestrator(
  state: GraphState,
  tx: Tx,
  input: { key: string; sessionId: string; leaseTtlSec?: number },
): Orchestrator {
  const o = orchestratorByKey(state, input.key);
  const { now } = tx.ctx;
  if (o.status === 'paused' || o.status === 'stopped') {
    throw new EngineError(
      'INVALID_TRANSITION',
      `Orchestrator '${o.key}' is ${o.status}.`,
      'A human must resume it first.',
    );
  }
  const held =
    o.status === 'active' &&
    o.sessionId &&
    o.sessionId !== input.sessionId &&
    (o.leaseExpiresAt ?? 0) > now;
  if (held) {
    throw new EngineError(
      'ALREADY_CLAIMED',
      `Orchestrator '${o.key}' is held by session ${o.sessionId} until ${new Date(o.leaseExpiresAt ?? now).toISOString()}.`,
      'Wait for the lease to lapse (handoff), or ask a human to stop the other session.',
    );
  }
  const handoff = o.sessionId !== undefined && o.sessionId !== input.sessionId;
  o.status = 'active';
  o.sessionId = input.sessionId;
  o.leaseExpiresAt = now + (input.leaseTtlSec ?? ORCHESTRATOR_LEASE_SEC) * 1000;
  o.lastHeartbeatAt = now;
  o.updatedAt = now;
  tx.touch('orchestrator', o);
  tx.emit('orchestrator.attached', state.graph.id, 'orchestrator', o.id, {
    key: o.key,
    sessionId: input.sessionId,
    handoff,
  });
  return o;
}

function requireHolder(o: Orchestrator, sessionId: string | undefined): void {
  if (o.status !== 'active' || !o.sessionId || o.sessionId !== sessionId) {
    throw new EngineError(
      'POLICY_DENIED',
      `Your session does not hold orchestrator '${o.key}'.`,
      'Attach first with POST …/orchestrators/{key}/attach.',
      403,
    );
  }
}

export function heartbeatOrchestrator(
  state: GraphState,
  tx: Tx,
  input: { key: string; sessionId?: string; leaseTtlSec?: number },
): Orchestrator {
  const o = orchestratorByKey(state, input.key);
  requireHolder(o, input.sessionId);
  o.lastHeartbeatAt = tx.ctx.now;
  o.leaseExpiresAt = tx.ctx.now + (input.leaseTtlSec ?? ORCHESTRATOR_LEASE_SEC) * 1000;
  tx.touch('orchestrator', o);
  return o;
}

export function detachOrchestrator(
  state: GraphState,
  tx: Tx,
  input: { key: string; sessionId?: string; handoff?: string },
): Orchestrator {
  const o = orchestratorByKey(state, input.key);
  requireHolder(o, input.sessionId);
  if (input.handoff) {
    createNote(state, tx, {
      type: 'handoff',
      title: `Handoff: ${o.name}`,
      body: input.handoff,
      orchestratorId: o.id,
    });
  }
  o.status = 'idle';
  delete o.sessionId;
  delete o.leaseExpiresAt;
  o.updatedAt = tx.ctx.now;
  tx.touch('orchestrator', o);
  tx.emit('orchestrator.detached', state.graph.id, 'orchestrator', o.id, { key: o.key });
  return o;
}

/** Human control: pause, resume (→ idle), or stop a role. */
export function setOrchestratorStatus(
  state: GraphState,
  tx: Tx,
  key: string,
  action: 'pause' | 'resume' | 'stop',
): Orchestrator {
  const o = orchestratorByKey(state, key);
  const to: OrchestratorStatus =
    action === 'pause' ? 'paused' : action === 'stop' ? 'stopped' : 'idle';
  const from = o.status;
  o.status = to;
  if (to !== 'idle') {
    delete o.sessionId;
    delete o.leaseExpiresAt;
  }
  o.updatedAt = tx.ctx.now;
  tx.touch('orchestrator', o);
  tx.emit('orchestrator.status_changed', state.graph.id, 'orchestrator', o.id, {
    key: o.key,
    from,
    to,
  });
  return o;
}
