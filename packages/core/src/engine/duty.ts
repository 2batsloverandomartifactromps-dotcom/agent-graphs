/** Orchestrator duty queues (docs/concepts.md §8 Duty queue). */
import { aimsOf, graphAims } from './state';
import type { GraphState, Node, Orchestrator } from './types';

export type DutyKind =
  | 'dispatch'
  | 'evaluate'
  | 'judge_graph_aim'
  | 'approve'
  | 'resolve'
  | 'stale_lease'
  | 'lesson_duty';

export type DutyItem = {
  kind: DutyKind;
  title: string;
  nodeKey?: string;
  attemptId?: string;
  requestId?: string;
  aimKey?: string;
  hint: string;
};

export function inScope(orchestrator: Orchestrator, node: Node): boolean {
  const scope = orchestrator.scope;
  if (scope === 'all') return true;
  if ('nodes' in scope) return scope.nodes.includes(node.key);
  return scope.tags.some((t) => node.tags.includes(t));
}

/** A running attempt is stale when it has not heartbeated for half its lease. */
export function isStale(state: GraphState, attemptId: string, now: number): boolean {
  const attempt = state.attempts.get(attemptId);
  if (attempt?.status !== 'running') return false;
  const node = state.nodes.get(attempt.nodeId);
  const ttl = (node?.leaseTtlSec ?? 1800) * 1000;
  return now - (attempt.lastHeartbeatAt ?? attempt.startedAt) > ttl / 2;
}

export function dutyQueue(state: GraphState, orchestratorId: string, now: number): DutyItem[] {
  const orch = state.orchestrators.get(orchestratorId);
  if (!orch) return [];
  const can = new Set(orch.capabilities);
  const items: DutyItem[] = [];
  const nodes = [...state.nodes.values()].filter((n) => inScope(orch, n));

  if (can.has('dispatch') && state.graph.status === 'active') {
    for (const n of nodes) {
      if (n.kind !== 'task' || n.status !== 'ready') continue;
      const hint = [n.executor.model, n.executor.thinking, n.executor.mechanism]
        .filter(Boolean)
        .join(' · ');
      items.push({
        kind: 'dispatch',
        title: `Dispatch ${n.key} (${n.priority})`,
        nodeKey: n.key,
        hint: `node_claim { node: "${n.key}", dispatchedBy: "${orch.key}" }${hint ? ` · recommended ${hint}` : ''}`,
      });
    }
  }
  if (can.has('evaluate')) {
    for (const attempt of state.attempts.values()) {
      if (attempt.status !== 'submitted') continue;
      const node = state.nodes.get(attempt.nodeId) as Node;
      if (!inScope(orch, node)) continue;
      const judged = new Set(
        state.evaluations.filter((e) => e.attemptId === attempt.id).map((e) => e.aimId),
      );
      for (const aim of aimsOf(state, 'node', node.id)) {
        if (aim.kind !== 'qualitative' || aim.evaluator !== 'orchestrator' || judged.has(aim.id)) {
          continue;
        }
        if (aim.evaluatorKey && aim.evaluatorKey !== orch.key) continue;
        items.push({
          kind: 'evaluate',
          title: `Judge ${node.key} · ${aim.title}`,
          nodeKey: node.key,
          attemptId: attempt.id,
          aimKey: aim.key,
          hint: `aim_evaluate { attemptId: "${attempt.id}", aim: "${aim.key}", verdict, rationale, evidence }`,
        });
      }
    }
    if (state.graph.status === 'verifying') {
      for (const aim of graphAims(state)) {
        if (aim.kind !== 'qualitative' || aim.evaluator !== 'orchestrator') continue;
        if (aim.status !== 'pending' || (aim.evaluatorKey && aim.evaluatorKey !== orch.key))
          continue;
        items.push({
          kind: 'judge_graph_aim',
          title: `Judge graph aim · ${aim.title}`,
          aimKey: aim.key,
          hint: `POST /graphs/${state.graph.id}/aims/${aim.key}/evaluations`,
        });
      }
    }
  }
  for (const r of state.requests.values()) {
    if (r.status !== 'open') continue;
    if (r.assignee === 'human') continue;
    if (r.assigneeKey && r.assigneeKey !== orch.key) continue;
    const node = r.nodeId ? state.nodes.get(r.nodeId) : undefined;
    if (node && !inScope(orch, node)) continue;
    const needed = r.kind === 'approval' ? 'approve' : 'resolve';
    if (!can.has(needed)) continue;
    items.push({
      kind: needed,
      title: r.title,
      requestId: r.id,
      ...(node ? { nodeKey: node.key } : {}),
      hint: `request_resolve { requestId: "${r.id}", choice: ${r.options.map((o) => `"${o.id}"`).join(' | ')} }`,
    });
  }
  if (can.has('resolve') || can.has('dispatch')) {
    for (const attempt of state.attempts.values()) {
      if (!isStale(state, attempt.id, now)) continue;
      const node = state.nodes.get(attempt.nodeId) as Node;
      if (!inScope(orch, node)) continue;
      const age = Math.round((now - (attempt.lastHeartbeatAt ?? attempt.startedAt)) / 60_000);
      items.push({
        kind: 'stale_lease',
        title: `${node.key}: no heartbeat for ${age} min`,
        nodeKey: node.key,
        attemptId: attempt.id,
        hint: 'Check on the worker; its lease will expire and the attempt will be recycled.',
      });
    }
  }
  if (can.has('evolve')) {
    for (const duty of state.lessonDuties.values()) {
      if (duty.status !== 'open') continue;
      const node = state.nodes.get(duty.nodeId);
      items.push({
        kind: 'lesson_duty',
        title: `Record a lesson for ${node?.key ?? duty.nodeId}`,
        ...(node ? { nodeKey: node.key } : {}),
        attemptId: duty.passedAttemptId,
        hint: `Contrast ${duty.failedAttemptIds.join(', ')} with ${duty.passedAttemptId}, then lesson_add.`,
      });
    }
  }
  return items;
}
