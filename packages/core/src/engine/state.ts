/** Read-only lookups over a GraphState. */
import type { NodeStatus } from '../vocabulary';
import {
  type Aim,
  type Attempt,
  EngineError,
  type GraphState,
  type Loop,
  type Node,
} from './types';

export const OPEN_ATTEMPT_STATUSES = ['running', 'submitted'] as const;
export const TERMINAL_NODE_STATUSES: readonly NodeStatus[] = [
  'done',
  'skipped',
  'failed',
  'cancelled',
];

export function isTerminal(status: NodeStatus): boolean {
  return TERMINAL_NODE_STATUSES.includes(status);
}

export function nodeByKey(state: GraphState, key: string): Node {
  for (const node of state.nodes.values()) if (node.key === key) return node;
  throw new EngineError('NOT_FOUND', `Node '${key}' does not exist in this graph.`, undefined, 404);
}

export function getNode(state: GraphState, id: string): Node {
  const node = state.nodes.get(id);
  if (!node) throw new EngineError('NOT_FOUND', `Node ${id} not found.`, undefined, 404);
  return node;
}

export function getAttempt(state: GraphState, id: string): Attempt {
  const attempt = state.attempts.get(id);
  if (!attempt) throw new EngineError('NOT_FOUND', `Attempt ${id} not found.`, undefined, 404);
  return attempt;
}

export function loopByKey(state: GraphState, key: string): Loop {
  const loop = state.loops.find((l) => l.key === key);
  if (!loop) throw new EngineError('NOT_FOUND', `Loop '${key}' does not exist.`, undefined, 404);
  return loop;
}

/** Aims owned by a node, graph, or orchestrator, in authoring order. */
export function aimsOf(state: GraphState, ownerType: Aim['ownerType'], ownerId: string): Aim[] {
  return [...state.aims.values()]
    .filter((a) => a.ownerType === ownerType && a.ownerId === ownerId)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

export function graphAims(state: GraphState): Aim[] {
  return aimsOf(state, 'graph', state.graph.id);
}

export function aimByKey(state: GraphState, owner: Aim['ownerType'], ownerId: string, key: string) {
  const aim = aimsOf(state, owner, ownerId).find((a) => a.key === key);
  if (!aim) throw new EngineError('NOT_FOUND', `Aim '${key}' does not exist.`, undefined, 404);
  return aim;
}

export function requiresPredecessors(state: GraphState, nodeId: string): Node[] {
  return state.edges
    .filter((e) => e.kind === 'requires' && e.toNodeId === nodeId)
    .map((e) => getNode(state, e.fromNodeId));
}

export function requiresSuccessors(state: GraphState, nodeId: string): Node[] {
  return state.edges
    .filter((e) => e.kind === 'requires' && e.fromNodeId === nodeId)
    .map((e) => getNode(state, e.toNodeId));
}

/** Every node reachable from `nodeId` through `requires` edges (excluding itself). */
export function requiresDescendants(state: GraphState, nodeId: string): Node[] {
  const seen = new Set<string>();
  const stack = [nodeId];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    for (const succ of requiresSuccessors(state, id)) {
      if (!seen.has(succ.id)) {
        seen.add(succ.id);
        stack.push(succ.id);
      }
    }
  }
  return [...seen].map((id) => getNode(state, id));
}

export function prerequisitesSatisfied(state: GraphState, node: Node): boolean {
  const skippedOk = state.graph.policy.skippedSatisfiesDeps;
  return requiresPredecessors(state, node.id).every(
    (p) => p.status === 'done' || (skippedOk && p.status === 'skipped'),
  );
}

export function loopTriggeredBy(state: GraphState, nodeId: string): Loop | undefined {
  return state.loops.find((l) => l.fromNodeId === nodeId);
}

/** Loops whose body contains the node, innermost first. */
export function loopsContaining(state: GraphState, nodeId: string): Loop[] {
  return state.loops
    .filter((l) => l.body.includes(nodeId))
    .sort((a, b) => a.body.length - b.body.length);
}

export function openAttempt(state: GraphState, nodeId: string): Attempt | undefined {
  for (const a of state.attempts.values()) {
    if (a.nodeId === nodeId && (a.status === 'running' || a.status === 'submitted')) return a;
  }
  return undefined;
}

export function attemptsOf(state: GraphState, nodeId: string, activation?: number): Attempt[] {
  return [...state.attempts.values()]
    .filter((a) => a.nodeId === nodeId && (activation === undefined || a.activation === activation))
    .sort((a, b) => a.number - b.number);
}

export function openRequestsFor(state: GraphState, nodeId: string) {
  return [...state.requests.values()].filter((r) => r.nodeId === nodeId && r.status === 'open');
}

export function runningCount(state: GraphState): number {
  let n = 0;
  for (const a of state.attempts.values()) if (a.status === 'running') n++;
  return n;
}
