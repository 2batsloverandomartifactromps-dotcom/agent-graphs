/**
 * docs/concepts.md §15 invariants, checked from the outside through the API after a
 * simulation (the engine property-tests them internally; this proves the server holds them
 * end to end under multi-agent traffic).
 */
import type { AgentGraphsClient } from '@agent-graphs/sdk';

const STARTED = new Set(['ready', 'running', 'evaluating', 'needs_input', 'blocked', 'done']);

export async function checkInvariants(client: AgentGraphsClient, graph: string): Promise<string[]> {
  const problems: string[] = [];
  const view = await client.getGraph(graph);
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  const skippedOk = view.graph.policy.skippedSatisfiesDeps !== false;

  // 1. requires edges form a DAG (and every edge references known nodes).
  const succ = new Map<string, string[]>();
  for (const e of view.edges) {
    if (e.kind !== 'requires') continue;
    if (!byId.has(e.fromNodeId) || !byId.has(e.toNodeId))
      problems.push(`edge ${e.id} references an unknown node`);
    succ.set(e.fromNodeId, [...(succ.get(e.fromNodeId) ?? []), e.toNodeId]);
  }
  const state = new Map<string, number>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 1) return false;
    if (state.get(id) === 2) return true;
    state.set(id, 1);
    for (const next of succ.get(id) ?? []) if (!visit(next)) return false;
    state.set(id, 2);
    return true;
  };
  for (const n of view.nodes) if (!visit(n.id)) problems.push('requires edges contain a cycle');

  for (const summary of view.nodes) {
    const node = await client.getNode(graph, summary.key);
    // 2. at most one running or submitted attempt per node.
    const open = node.attempts.filter((a) => a.status === 'running' || a.status === 'submitted');
    if (open.length > 1) problems.push(`${node.key}: ${open.length} open attempts`);
    // 4. started nodes have satisfied prerequisites.
    if (STARTED.has(node.status)) {
      for (const e of node.needs) {
        if (e.kind !== 'requires') continue;
        const pred = byId.get(e.fromNodeId);
        const ok = pred && (pred.status === 'done' || (skippedOk && pred.status === 'skipped'));
        if (!ok)
          problems.push(
            `${node.key} is ${node.status} but prerequisite ${pred?.key} is ${pred?.status}`,
          );
      }
    }
    // 5. counted attempts within bounds for the current activation.
    if (node.countedAttempts > node.maxAttempts)
      problems.push(`${node.key}: ${node.countedAttempts} counted attempts > ${node.maxAttempts}`);
    // 3. done means satisfied (or accepted, manual, gate approved).
    if (
      node.status === 'done' &&
      node.kind === 'task' &&
      !node.acceptedWithDeviation &&
      !node.manual
    ) {
      const term = node.aims.filter((a) => a.terminating);
      const ok = (s: string) => s === 'met' || s === 'waived';
      const satisfied =
        node.aimMode === 'any' ? term.some((a) => ok(a.status)) : term.every((a) => ok(a.status));
      if (!satisfied)
        problems.push(`${node.key} is done but its terminating aims are not satisfied`);
    }
    // 9. independent verdicts never come from the executor's session.
    if (view.graph.policy.evaluation?.independent !== false) {
      for (const ev of node.evaluations) {
        if (ev.evaluatorKind !== 'agent' && ev.evaluatorKind !== 'orchestrator') continue;
        const attempt = node.attempts.find((a) => a.id === ev.attemptId);
        if (attempt?.sessionId && ev.actor.sessionId === attempt.sessionId)
          problems.push(`${node.key}: verdict on ${attempt.id} from the executor's own session`);
      }
    }
  }

  // 5. loop iterations within bounds.
  for (const l of view.loops)
    if (l.iteration > l.maxIterations + l.grantedIterations)
      problems.push(
        `loop ${l.key}: iteration ${l.iteration} > ${l.maxIterations + l.grantedIterations}`,
      );

  // 6. a completed graph has every node done or skipped.
  if (view.graph.status === 'completed') {
    const bad = view.nodes.filter((n) => n.status !== 'done' && n.status !== 'skipped');
    if (bad.length)
      problems.push(
        `graph completed with nodes ${bad.map((n) => `${n.key}:${n.status}`).join(', ')}`,
      );
  }

  // 7. every event has an actor annotation, and the hash chain verifies.
  let after = 0;
  for (;;) {
    const page = await client.events(graph, { after, limit: 1000 });
    for (const e of page.items)
      if (!e.actor?.kind) problems.push(`event ${e.seq} (${e.type}) has no actor`);
    if (page.items.length < 1000 || page.nextCursor === null) break;
    after = page.nextCursor;
  }
  const audit = await client.verifyAudit(graph);
  if (!audit.ok) problems.push(`audit chain broken at seq ${audit.firstMismatch}`);
  return problems;
}
