/**
 * Graph algorithms over node keys (or ids). Pure and allocation-light; used by spec validation,
 * the engine (readiness, loops, reopen cascades), `next` ordering, and the UI.
 */

export type Adjacency = {
  nodes: string[];
  succ: Map<string, string[]>;
  pred: Map<string, string[]>;
};

export function buildAdjacency(
  nodes: Iterable<string>,
  edges: Iterable<{ from: string; to: string }>,
): Adjacency {
  const list = [...nodes];
  const succ = new Map<string, string[]>(list.map((n) => [n, []]));
  const pred = new Map<string, string[]>(list.map((n) => [n, []]));
  for (const { from, to } of edges) {
    succ.get(from)?.push(to);
    pred.get(to)?.push(from);
  }
  return { nodes: list, succ, pred };
}

/** Returns one cycle as a path that starts and ends at the same node, or null if acyclic. */
export function findCycle(adj: Adjacency): string[] | null {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map<string, number>(adj.nodes.map((n) => [n, WHITE]));
  const parent = new Map<string, string>();
  for (const start of adj.nodes) {
    if (color.get(start) !== WHITE) continue;
    // Iterative DFS to stay safe on deep graphs.
    const stack: Array<{ node: string; i: number }> = [{ node: start, i: 0 }];
    color.set(start, GREY);
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as { node: string; i: number };
      const next = adj.succ.get(top.node) ?? [];
      if (top.i >= next.length) {
        color.set(top.node, BLACK);
        stack.pop();
        continue;
      }
      const child = next[top.i++] as string;
      const c = color.get(child);
      if (c === GREY) {
        const cycle = [child];
        let cur = top.node;
        while (cur !== child) {
          cycle.push(cur);
          cur = parent.get(cur) as string;
        }
        cycle.push(child);
        return cycle.reverse();
      }
      if (c === WHITE) {
        parent.set(child, top.node);
        color.set(child, GREY);
        stack.push({ node: child, i: 0 });
      }
    }
  }
  return null;
}

/** Kahn topological order. Nodes on cycles are omitted (validate acyclicity first). */
export function topoSort(adj: Adjacency): string[] {
  const indegree = new Map<string, number>(adj.nodes.map((n) => [n, adj.pred.get(n)?.length ?? 0]));
  const queue = adj.nodes.filter((n) => indegree.get(n) === 0);
  const order: string[] = [];
  for (let i = 0; i < queue.length; i++) {
    const n = queue[i] as string;
    order.push(n);
    for (const s of adj.succ.get(n) ?? []) {
      const d = (indegree.get(s) ?? 0) - 1;
      indegree.set(s, d);
      if (d === 0) queue.push(s);
    }
  }
  return order;
}

/** All nodes reachable from `start` (inclusive) following `next`. */
export function reachable(start: string, next: Map<string, string[]>): Set<string> {
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length > 0) {
    for (const n of next.get(stack.pop() as string) ?? []) {
      if (!seen.has(n)) {
        seen.add(n);
        stack.push(n);
      }
    }
  }
  return seen;
}

/** Strict descendants of `start` through `succ`. */
export function descendants(start: string, adj: Adjacency): Set<string> {
  const all = reachable(start, adj.succ);
  all.delete(start);
  return all;
}

/**
 * Loop body: every node on a path from `to` (entry) to `from` (trigger), inclusive.
 * Returns null when `from` is not reachable from `to`.
 */
export function loopBody(from: string, to: string, adj: Adjacency): Set<string> | null {
  const forward = reachable(to, adj.succ);
  if (!forward.has(from)) return null;
  const backward = reachable(from, adj.pred);
  return new Set([...forward].filter((n) => backward.has(n)));
}

/** Edges leaving the body from a node other than the trigger (single-exit rule). */
export function singleExitViolations(
  body: Set<string>,
  trigger: string,
  adj: Adjacency,
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const n of body) {
    if (n === trigger) continue;
    for (const s of adj.succ.get(n) ?? []) if (!body.has(s)) out.push([n, s]);
  }
  return out;
}

/** Pairs of bodies that partially overlap (neither disjoint nor nested). */
export function laminarViolations(
  bodies: Array<{ key: string; body: Set<string> }>,
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i] as { key: string; body: Set<string> };
      const b = bodies[j] as { key: string; body: Set<string> };
      let shared = 0;
      for (const n of a.body) if (b.body.has(n)) shared++;
      if (shared > 0 && shared !== a.body.size && shared !== b.body.size) out.push([a.key, b.key]);
    }
  }
  return out;
}

/**
 * Critical-path weight: the number of nodes on the longest path from each node to a sink
 * (inclusive). Higher weight = unblocks more work. Requires an acyclic graph.
 */
export function criticalPathWeights(adj: Adjacency): Map<string, number> {
  const order = topoSort(adj);
  const weight = new Map<string, number>();
  for (let i = order.length - 1; i >= 0; i--) {
    const n = order[i] as string;
    let best = 0;
    for (const s of adj.succ.get(n) ?? []) best = Math.max(best, weight.get(s) ?? 0);
    weight.set(n, best + 1);
  }
  return weight;
}

/** Nodes on one longest path through the graph (for the UI's critical-path toggle). */
export function criticalPath(adj: Adjacency): string[] {
  const weight = criticalPathWeights(adj);
  let current = [...weight.entries()]
    .filter(([n]) => (adj.pred.get(n)?.length ?? 0) === 0)
    .sort((a, b) => b[1] - a[1])[0]?.[0];
  const path: string[] = [];
  while (current !== undefined) {
    path.push(current);
    const next: string[] = adj.succ.get(current) ?? [];
    current = next.sort((a, b) => (weight.get(b) ?? 0) - (weight.get(a) ?? 0))[0];
  }
  return path;
}

/** Levenshtein distance, for "did you mean" hints. */
export function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] as number;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j] as number;
      prev[j] = Math.min(
        (prev[j] as number) + 1,
        (prev[j - 1] as number) + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = tmp;
    }
  }
  return prev[b.length] as number;
}

/** Closest candidate within a small edit distance, or undefined. */
export function didYouMean(value: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestDistance = Math.max(2, Math.floor(value.length / 3)) + 1;
  for (const c of candidates) {
    const d = editDistance(value, c);
    if (d < bestDistance) {
      best = c;
      bestDistance = d;
    }
  }
  return best;
}
