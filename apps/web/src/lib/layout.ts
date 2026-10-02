/**
 * Canvas layout (docs/ui.md §5.1): a left-to-right layered dagre layout of the forward
 * `requires` and `informs` DAG. Loop bodies are dagre clusters so they stay contiguous, and are
 * drawn as tinted regions behind their nodes. The result depends only on structure (never on
 * status) and is memoized by a structure hash.
 */
import { layout as dagreLayout, Graph } from '@dagrejs/dagre';

export type LayoutNodeInput = { key: string; kind: string };
export type LayoutEdgeInput = { from: string; to: string; kind: 'requires' | 'informs' | string };
export type LayoutLoopInput = { key: string; from: string; to: string; body: string[] };

export type LayoutInput = {
  nodes: LayoutNodeInput[];
  edges: LayoutEdgeInput[];
  loops: LayoutLoopInput[];
};

export type Rect = { x: number; y: number; width: number; height: number };

export type LoopRegion = Rect & {
  key: string;
  depth: number;
  /** Nesting level from the inside: 0 for innermost. */
  level: number;
  parent?: string;
};

export type LayoutResult = {
  hash: string;
  nodes: Record<string, Rect>;
  loops: Record<string, LoopRegion>;
  bounds: Rect;
};

export const CARD_W = 232;
export const MILESTONE_W = 212;
export const NODE_H: Record<string, number> = { task: 176, gate: 156, milestone: 48, group: 120 };
/** Vertical offset of edge ports from a card's top edge (mockup PORT_Y). */
export const PORT_Y = 46;

const RANK_SEP = 44;
const NODE_SEP = 36;
const LOOP_PAD_X = 18;
const LOOP_PAD_TOP = 34;
const LOOP_PAD_BOTTOM = 14;
const LOOP_NEST = 14;

export function nodeSize(kind: string): { width: number; height: number } {
  return {
    width: kind === 'milestone' ? MILESTONE_W : CARD_W,
    height: NODE_H[kind] ?? (NODE_H.task as number),
  };
}

/** A stable hash of the structure: statuses never affect it. */
export function structureHash(input: LayoutInput): string {
  const nodes = input.nodes.map((n) => `${n.key}:${n.kind}`).sort();
  const edges = input.edges.map((e) => `${e.from}>${e.to}:${e.kind}`).sort();
  const loops = input.loops.map((l) => `${l.key}:${l.from}>${l.to}[${[...l.body].sort()}]`).sort();
  return fnv1a(`${nodes.join(',')}|${edges.join(',')}|${loops.join(',')}`);
}

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Loop nesting: each loop's parent is the smallest other loop whose body strictly contains it
 * (bodies are laminar by validation, concepts §7.2).
 */
export function loopNesting(loops: LayoutLoopInput[]): Map<string, string | undefined> {
  const parent = new Map<string, string | undefined>();
  for (const l of loops) {
    const body = new Set(l.body);
    let best: LayoutLoopInput | undefined;
    for (const o of loops) {
      if (o.key === l.key || o.body.length <= l.body.length) continue;
      const contains = [...body].every((k) => o.body.includes(k));
      if (contains && (!best || o.body.length < best.body.length)) best = o;
    }
    parent.set(l.key, best?.key);
  }
  return parent;
}

/** The innermost loop containing each node. */
export function innermostLoop(loops: LayoutLoopInput[]): Map<string, string> {
  const out = new Map<string, string>();
  const sorted = [...loops].sort((a, b) => b.body.length - a.body.length);
  for (const l of sorted) for (const k of l.body) out.set(k, l.key);
  return out;
}

const cache = new Map<string, LayoutResult>();

export function computeLayout(input: LayoutInput): LayoutResult {
  const hash = structureHash(input);
  const hit = cache.get(hash);
  if (hit) return hit;
  const result = runLayout(input, hash, true);
  cache.set(hash, result);
  return result;
}

function runLayout(input: LayoutInput, hash: string, compound: boolean): LayoutResult {
  const keys = new Set(input.nodes.map((n) => n.key));
  const loops = input.loops
    .map((l) => ({ ...l, body: l.body.filter((k) => keys.has(k)) }))
    .filter((l) => l.body.length > 0);
  const nesting = loopNesting(loops);
  const inner = innermostLoop(loops);

  const g = new Graph({ compound, multigraph: false });
  g.setGraph({
    rankdir: 'LR',
    ranksep: RANK_SEP,
    nodesep: NODE_SEP,
    edgesep: 16,
    marginx: 24,
    marginy: 24,
    ranker: 'network-simplex',
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of input.nodes) g.setNode(n.key, nodeSize(n.kind));
  if (compound) {
    for (const l of loops) g.setNode(clusterId(l.key), {});
    for (const l of loops) {
      const p = nesting.get(l.key);
      if (p) g.setParent(clusterId(l.key), clusterId(p));
    }
    for (const [key, loop] of inner) if (keys.has(key)) g.setParent(key, clusterId(loop));
  }
  for (const e of input.edges) {
    if (!keys.has(e.from) || !keys.has(e.to) || e.from === e.to) continue;
    const informs = e.kind === 'informs';
    // Informs edges shape the layout only weakly, so long context links do not distort it.
    g.setEdge(e.from, e.to, { weight: informs ? 0 : 2, minlen: 1 });
  }

  try {
    dagreLayout(g);
  } catch (error) {
    if (compound) return runLayout(input, hash, false);
    throw error;
  }

  const nodes: Record<string, Rect> = {};
  for (const n of input.nodes) {
    const v = g.node(n.key) as { x: number; y: number; width: number; height: number } | undefined;
    const { width, height } = nodeSize(n.kind);
    const cx = v?.x ?? 0;
    const cy = v?.y ?? 0;
    // Milestones align their port with the cards' port row.
    const y = n.kind === 'milestone' ? cy - height / 2 : cy - (NODE_H.task as number) / 2;
    nodes[n.key] = { x: Math.round(cx - width / 2), y: Math.round(y), width, height };
  }

  // Regions: bounding boxes of body nodes, padded outward by nesting level.
  const levels = new Map<string, number>();
  const levelOf = (key: string): number => {
    const known = levels.get(key);
    if (known !== undefined) return known;
    const children = loops.filter((l) => nesting.get(l.key) === key);
    const lv = children.length ? Math.max(...children.map((c) => levelOf(c.key) + 1)) : 0;
    levels.set(key, lv);
    return lv;
  };
  const depthOf = (key: string): number => {
    let d = 0;
    let p = nesting.get(key);
    while (p) {
      d += 1;
      p = nesting.get(p);
    }
    return d;
  };
  const buildRegions = (): Record<string, LoopRegion> => {
    const out: Record<string, LoopRegion> = {};
    for (const l of loops) {
      const rects = l.body.map((k) => nodes[k]).filter((r): r is Rect => Boolean(r));
      const level = levelOf(l.key);
      const x0 = Math.min(...rects.map((r) => r.x)) - LOOP_PAD_X - level * LOOP_NEST;
      const y0 = Math.min(...rects.map((r) => r.y)) - LOOP_PAD_TOP - level * (LOOP_NEST + 18);
      const x1 = Math.max(...rects.map((r) => r.x + r.width)) + LOOP_PAD_X + level * LOOP_NEST;
      const y1 =
        Math.max(...rects.map((r) => r.y + r.height)) + LOOP_PAD_BOTTOM + level * LOOP_NEST;
      const parent = nesting.get(l.key);
      out[l.key] = {
        key: l.key,
        x: x0,
        y: y0,
        width: x1 - x0,
        height: y1 - y0,
        depth: depthOf(l.key),
        level,
        ...(parent ? { parent } : {}),
      };
    }
    return out;
  };
  // Dagre keeps clusters contiguous per rank, but a rectangular region can still cover a
  // non-member placed beside a shorter part of the cluster. Push such nodes below the region
  // (and restack their column) until no region covers a node outside its body.
  let regions = buildRegions();
  for (let iter = 0; iter < 8; iter++) {
    let moved = false;
    for (const l of loops) {
      const r = regions[l.key];
      if (!r) continue;
      const body = new Set(l.body);
      // Reserve room above the region for the back-edge and its iteration pill.
      const zone = { x: r.x - 8, y: r.y - 40, width: r.width + 16, height: r.height + 48 };
      for (const n of input.nodes) {
        const rect = nodes[n.key];
        if (!rect || body.has(n.key) || !intersects(rect, zone)) continue;
        rect.y = zone.y + zone.height + 12;
        moved = true;
      }
    }
    moved = restackColumns(nodes) || moved;
    regions = buildRegions();
    if (!moved) break;
  }

  const all = [...Object.values(nodes), ...Object.values(regions)];
  const bx0 = all.length ? Math.min(...all.map((r) => r.x)) : 0;
  const by0 = all.length ? Math.min(...all.map((r) => r.y)) - 30 : 0;
  const bx1 = all.length ? Math.max(...all.map((r) => r.x + r.width)) : 0;
  const by1 = all.length ? Math.max(...all.map((r) => r.y + r.height)) : 0;
  return {
    hash,
    nodes,
    loops: regions,
    bounds: { x: bx0, y: by0, width: bx1 - bx0, height: by1 - by0 },
  };
}

function clusterId(key: string): string {
  return `loop:${key}`;
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Within each column (same x), push overlapping nodes down so they keep the node gap. */
function restackColumns(nodes: Record<string, Rect>): boolean {
  const columns = new Map<number, Rect[]>();
  for (const r of Object.values(nodes)) {
    const col = Math.round(r.x / 8);
    columns.set(col, [...(columns.get(col) ?? []), r]);
  }
  let moved = false;
  for (const col of columns.values()) {
    col.sort((a, b) => a.y - b.y);
    for (let i = 1; i < col.length; i++) {
      const prev = col[i - 1] as Rect;
      const cur = col[i] as Rect;
      const min = prev.y + prev.height + NODE_SEP;
      if (cur.y < min) {
        cur.y = min;
        moved = true;
      }
    }
  }
  return moved;
}

// ─── Graph traversal helpers for canvas interactions ──────────────────────────

export type Adjacency = { out: Map<string, string[]>; in: Map<string, string[]> };

export function adjacency(edges: LayoutEdgeInput[], kinds?: string[]): Adjacency {
  const out = new Map<string, string[]>();
  const inn = new Map<string, string[]>();
  for (const e of edges) {
    if (kinds && !kinds.includes(e.kind)) continue;
    out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
    inn.set(e.to, [...(inn.get(e.to) ?? []), e.from]);
  }
  return { out, in: inn };
}

function walk(start: string, next: Map<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const stack = [...(next.get(start) ?? [])];
  while (stack.length) {
    const k = stack.pop() as string;
    if (seen.has(k)) continue;
    seen.add(k);
    stack.push(...(next.get(k) ?? []));
  }
  return seen;
}

/** The node, its ancestors and its descendants (focus mode). */
export function lineage(key: string, adj: Adjacency): Set<string> {
  return new Set([key, ...walk(key, adj.in), ...walk(key, adj.out)]);
}

/** Direct neighbors (double-click focus and hover traces). */
export function neighbors(key: string, adj: Adjacency): Set<string> {
  return new Set([key, ...(adj.in.get(key) ?? []), ...(adj.out.get(key) ?? [])]);
}

/**
 * Keyboard navigation: the nearest neighbor in an arrow direction, preferring graph neighbors
 * and falling back to the nearest node on screen in that direction.
 */
export function neighborInDirection(
  key: string,
  direction: 'left' | 'right' | 'up' | 'down',
  rects: Record<string, Rect>,
  adj: Adjacency,
): string | undefined {
  const from = rects[key];
  if (!from) return undefined;
  const cx = from.x + from.width / 2;
  const cy = from.y + from.height / 2;
  const candidates = (pool: string[]) =>
    pool
      .filter((k) => k !== key && rects[k])
      .map((k) => {
        const r = rects[k] as Rect;
        const dx = r.x + r.width / 2 - cx;
        const dy = r.y + r.height / 2 - cy;
        return { k, dx, dy };
      })
      .filter(({ dx, dy }) =>
        direction === 'right'
          ? dx > 10
          : direction === 'left'
            ? dx < -10
            : direction === 'down'
              ? dy > 10 && Math.abs(dy) >= Math.abs(dx) * 0.3
              : dy < -10 && Math.abs(dy) >= Math.abs(dx) * 0.3,
      )
      .sort((a, b) => Math.hypot(a.dx, a.dy * 1.5) - Math.hypot(b.dx, b.dy * 1.5));
  const graphNeighbors =
    direction === 'right' ? adj.out.get(key) : direction === 'left' ? adj.in.get(key) : undefined;
  const preferred = graphNeighbors ? candidates(graphNeighbors)[0] : undefined;
  return preferred?.k ?? candidates(Object.keys(rects))[0]?.k;
}
