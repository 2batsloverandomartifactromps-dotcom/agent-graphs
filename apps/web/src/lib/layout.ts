/**
 * Canvas layout (docs/ui.md §5.1): a left-to-right layered layout of the forward `requires` and
 * `informs` DAG, on a grid like the design reference.
 *
 * - Columns are ranks: each node sits in the earliest column its dependencies allow (sources are
 *   pulled right next to their first dependant).
 * - dagre (in the layout worker) orders the nodes within each column to reduce crossings.
 * - Rows are shared by all columns. Each node takes the free row nearest the median row of its
 *   dependencies. Every loop reserves a contiguous band of rows across its columns, so its body
 *   stays together and its tinted region never covers a node outside the body.
 * - Row and column gutters widen where a loop region (and its back-edge) needs the room.
 *
 * The result depends only on structure (never on status) and is memoized by a structure hash.
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

const ROW_H = NODE_H.task as number;
const COL_GAP = 44;
const ROW_GAP = 36;
const MARGIN = 24;
const LOOP_PAD_X = 18;
const LOOP_PAD_TOP = 34;
const LOOP_PAD_BOTTOM = 14;
const LOOP_NEST = 14;
/** Room above a loop region for its back-edge and iteration pill. */
const BACK_EDGE_ROOM = 40;

export function nodeSize(kind: string): { width: number; height: number } {
  return {
    width: kind === 'milestone' ? MILESTONE_W : CARD_W,
    height: NODE_H[kind] ?? ROW_H,
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
  const result = runLayout(input, hash);
  cache.set(hash, result);
  return result;
}

type ForwardEdge = { from: string; to: string; informs: boolean };

/**
 * Columns: the longest path from the sources (earliest start), then sources move right next to
 * their nearest dependant. Edges that would close a cycle are ignored.
 */
export function assignRanks(keys: string[], edges: ForwardEdge[]): Map<string, number> {
  const out = new Map<string, string[]>();
  const indeg = new Map<string, number>(keys.map((k) => [k, 0]));
  for (const e of edges) {
    out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const rank = new Map<string, number>(keys.map((k) => [k, 0]));
  const queue = keys.filter((k) => indeg.get(k) === 0);
  const seen = new Set<string>();
  while (queue.length) {
    const k = queue.shift() as string;
    seen.add(k);
    for (const t of out.get(k) ?? []) {
      rank.set(t, Math.max(rank.get(t) ?? 0, (rank.get(k) ?? 0) + 1));
      indeg.set(t, (indeg.get(t) ?? 0) - 1);
      if (indeg.get(t) === 0) queue.push(t);
    }
  }
  // Nodes on a cycle (invalid specs) keep the rank they reached.
  const hasIn = new Set(edges.map((e) => e.to));
  for (const k of keys) {
    if (hasIn.has(k) || !seen.has(k)) continue;
    const next = (out.get(k) ?? []).map((t) => rank.get(t) ?? 0);
    if (next.length) rank.set(k, Math.max(0, Math.min(...next) - 1));
  }
  return rank;
}

/** dagre's crossing-reduced order of the nodes within each column. */
function columnOrder(
  input: LayoutInput,
  edges: ForwardEdge[],
  rank: Map<string, number>,
): Map<string, number> {
  const g = new Graph({ multigraph: false });
  g.setGraph({ rankdir: 'LR', ranksep: COL_GAP, nodesep: ROW_GAP, ranker: 'network-simplex' });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of input.nodes) g.setNode(n.key, nodeSize(n.kind));
  for (const e of edges) {
    const minlen = Math.max(1, (rank.get(e.to) ?? 0) - (rank.get(e.from) ?? 0));
    g.setEdge(e.from, e.to, { weight: e.informs ? 1 : 2, minlen });
  }
  const order = new Map<string, number>();
  try {
    dagreLayout(g);
    for (const n of input.nodes) order.set(n.key, (g.node(n.key) as { y?: number })?.y ?? 0);
  } catch {
    input.nodes.forEach((n, i) => {
      order.set(n.key, i);
    });
  }
  return order;
}

type Band = { loop: string; start: number; height: number; r0: number; r1: number };

function runLayout(input: LayoutInput, hash: string): LayoutResult {
  const keys = input.nodes.map((n) => n.key);
  const keySet = new Set(keys);
  const kindOf = new Map(input.nodes.map((n) => [n.key, n.kind]));
  const edges: ForwardEdge[] = [];
  const edgeSeen = new Set<string>();
  for (const e of input.edges) {
    if (!keySet.has(e.from) || !keySet.has(e.to) || e.from === e.to) continue;
    const id = `${e.from}>${e.to}`;
    if (edgeSeen.has(id)) continue;
    edgeSeen.add(id);
    edges.push({ from: e.from, to: e.to, informs: e.kind === 'informs' });
  }
  const loops = input.loops
    .map((l) => ({ ...l, body: l.body.filter((k) => keySet.has(k)) }))
    .filter((l) => l.body.length > 0);
  const nesting = loopNesting(loops);
  const inner = innermostLoop(loops);
  const loopByKey = new Map(loops.map((l) => [l.key, l]));

  const rank = assignRanks(keys, edges);
  const order = columnOrder(input, edges, rank);
  const maxRank = Math.max(0, ...rank.values());

  // Loop rank spans and the rows each loop's band needs (children's bands plus own members).
  const span = new Map<string, [number, number]>();
  for (const l of loops) {
    const rs = l.body.map((k) => rank.get(k) ?? 0);
    span.set(l.key, [Math.min(...rs), Math.max(...rs)]);
  }
  const children = (key: string | undefined) =>
    loops.filter((l) => nesting.get(l.key) === key).map((l) => l.key);
  const bandHeight = new Map<string, number>();
  const heightOf = (key: string): number => {
    const known = bandHeight.get(key);
    if (known !== undefined) return known;
    const [a, b] = span.get(key) as [number, number];
    const kids = children(key);
    let h = 1;
    for (let r = a; r <= b; r++) {
      let rows = 0;
      for (const c of kids) {
        const [ca, cb] = span.get(c) as [number, number];
        if (r >= ca && r <= cb) rows += heightOf(c);
      }
      for (const k of (loopByKey.get(key) as LayoutLoopInput).body)
        if (inner.get(k) === key && rank.get(k) === r) rows += 1;
      h = Math.max(h, rows);
    }
    bandHeight.set(key, h);
    return h;
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

  // Grid occupancy: cell → node, and cell → innermost reserving loop.
  const cell = (r: number, row: number) => `${r}:${row}`;
  const taken = new Set<string>();
  const owner = new Map<string, string>();
  const rowOf = new Map<string, number>();
  const bands = new Map<string, Band>();

  // Rows never go above the first one, so the main line stays on top and branches stack below.
  const nearest = (want: number, ok: (row: number) => boolean): number => {
    const w = Math.max(0, want);
    for (let d = 0; d < 4096; d++) {
      if (ok(w + d)) return w + d;
      if (d > 0 && w - d >= 0 && ok(w - d)) return w - d;
    }
    return w + 4096;
  };
  const median = (xs: number[]): number | undefined => {
    if (!xs.length) return undefined;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor((s.length - 1) / 2)];
  };
  const preds = new Map<string, string[]>();
  for (const e of edges) preds.set(e.to, [...(preds.get(e.to) ?? []), e.from]);
  const byRank: string[][] = Array.from({ length: maxRank + 1 }, () => []);
  for (const k of keys) byRank[rank.get(k) ?? 0]?.push(k);
  for (const col of byRank) col.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));

  const wantRow = (k: string, fallback: number): number => {
    const m = median((preds.get(k) ?? []).map((p) => rowOf.get(p) ?? 0));
    return m ?? fallback;
  };

  for (let r = 0; r <= maxRank; r++) {
    const col = byRank[r] as string[];
    // Reserve bands for loops that start in this column, outer loops first.
    const starting = loops
      .filter((l) => (span.get(l.key) as [number, number])[0] === r)
      .sort((a, b) => depthOf(a.key) - depthOf(b.key));
    for (const l of starting) {
      const [a, b] = span.get(l.key) as [number, number];
      const h = heightOf(l.key);
      const parent = nesting.get(l.key);
      const members = col.filter((k) => l.body.includes(k));
      const want = Math.round(
        (members.reduce((s, k, i) => s + wantRow(k, i), 0) || 0) / Math.max(1, members.length),
      );
      const fits = (start: number) => {
        for (let rr = a; rr <= b; rr++)
          for (let row = start; row < start + h; row++) {
            const c = cell(rr, row);
            if (taken.has(c) || owner.get(c) !== parent) return false;
          }
        return true;
      };
      let start = nearest(want - Math.floor((h - 1) / 2), fits);
      if (start >= Math.max(0, want) + 4096) start = nearest(want, (s) => fits(s) || !parent);
      for (let rr = a; rr <= b; rr++)
        for (let row = start; row < start + h; row++) owner.set(cell(rr, row), l.key);
      bands.set(l.key, { loop: l.key, start, height: h, r0: a, r1: b });
    }
    // Place this column's nodes, nearest the median row of their dependencies.
    const wants = col.map((k, i) => ({ k, i, want: wantRow(k, i) }));
    wants.sort((x, y) => x.want - y.want || x.i - y.i);
    for (const w of wants) {
      const home = inner.get(w.k);
      const ok = (row: number) => !taken.has(cell(r, row)) && owner.get(cell(r, row)) === home;
      let row = nearest(w.want, ok);
      if (row >= Math.max(0, w.want) + 4096) row = nearest(w.want, (x) => !taken.has(cell(r, x)));
      taken.add(cell(r, row));
      rowOf.set(w.k, row);
    }
  }

  // Rows → y, widening the gap above rows where a loop region (and its back-edge) starts, and
  // below rows where one ends.
  const used = new Set<number>([...rowOf.values()]);
  for (const b of bands.values()) for (let i = 0; i < b.height; i++) used.add(b.start + i);
  const rows = [...used].sort((a, b) => a - b);
  const topExtra = new Map<number, number>();
  const bottomExtra = new Map<number, number>();
  const levels = new Map<string, number>();
  const levelOf = (key: string): number => {
    const known = levels.get(key);
    if (known !== undefined) return known;
    const kids = children(key);
    const lv = kids.length ? Math.max(...kids.map((c) => levelOf(c) + 1)) : 0;
    levels.set(key, lv);
    return lv;
  };
  for (const b of bands.values()) {
    const lv = levelOf(b.loop);
    const top = LOOP_PAD_TOP + lv * (LOOP_NEST + 18) + BACK_EDGE_ROOM;
    topExtra.set(b.start, Math.max(topExtra.get(b.start) ?? 0, top));
    const end = b.start + b.height - 1;
    bottomExtra.set(end, Math.max(bottomExtra.get(end) ?? 0, LOOP_PAD_BOTTOM + lv * LOOP_NEST));
  }
  const rowY = new Map<number, number>();
  let y = MARGIN;
  rows.forEach((row, i) => {
    if (i > 0) y += ROW_GAP + (bottomExtra.get(rows[i - 1] as number) ?? 0);
    y += topExtra.get(row) ?? 0;
    rowY.set(row, y);
    y += ROW_H;
  });

  // Columns → x, widening gutters next to nested loop regions.
  const colX: number[] = [];
  let x = MARGIN;
  for (let r = 0; r <= maxRank; r++) {
    if (r > 0) {
      // Each side of the gutter can hold a (nested) region edge; keep 12px between them.
      let left = 0;
      let right = 0;
      for (const b of bands.values()) {
        const pad = LOOP_PAD_X + levelOf(b.loop) * LOOP_NEST;
        if (b.r1 === r - 1) left = Math.max(left, pad);
        if (b.r0 === r) right = Math.max(right, pad);
      }
      x += Math.max(COL_GAP, left + right + (left && right ? 12 : 0));
    }
    colX.push(x);
    x += CARD_W;
  }

  const nodes: Record<string, Rect> = {};
  for (const k of keys) {
    const kind = kindOf.get(k) ?? 'task';
    const { width, height } = nodeSize(kind);
    const r = rank.get(k) ?? 0;
    const top = rowY.get(rowOf.get(k) ?? 0) ?? MARGIN;
    nodes[k] = {
      x: (colX[r] ?? MARGIN) + (CARD_W - width) / 2,
      y: kind === 'milestone' ? top + PORT_Y - height / 2 : top,
      width,
      height,
    };
  }

  const regions: Record<string, LoopRegion> = {};
  for (const l of loops) {
    const b = bands.get(l.key);
    if (!b) continue;
    const lv = levelOf(l.key);
    const x0 = (colX[b.r0] ?? 0) - LOOP_PAD_X - lv * LOOP_NEST;
    const x1 = (colX[b.r1] ?? 0) + CARD_W + LOOP_PAD_X + lv * LOOP_NEST;
    const y0 = (rowY.get(b.start) ?? 0) - LOOP_PAD_TOP - lv * (LOOP_NEST + 18);
    const y1 = (rowY.get(b.start + b.height - 1) ?? 0) + ROW_H + LOOP_PAD_BOTTOM + lv * LOOP_NEST;
    const parent = nesting.get(l.key);
    regions[l.key] = {
      key: l.key,
      x: x0,
      y: y0,
      width: x1 - x0,
      height: y1 - y0,
      depth: depthOf(l.key),
      level: lv,
      ...(parent ? { parent } : {}),
    };
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

// ─── Opening viewport ─────────────────────────────────────────────────────────

export type Padding = { top: number; right: number; bottom: number; left: number };
export type ViewportXYZ = { x: number; y: number; zoom: number };

/**
 * Where the canvas opens: the whole graph when it fits at a legible zoom; otherwise the design
 * reference's reading zoom anchored at the top-left of the active work (`focus`), shifted just
 * enough to keep the selected node in view.
 */
export function openingViewport(opts: {
  bounds: Rect;
  focus: Rect[];
  selected?: Rect | undefined;
  /** Where to anchor instead when the selection falls outside the focus view. */
  selectionFocus?: Rect[];
  width: number;
  height: number;
  pad: Padding;
  readingZoom?: number;
  minFitZoom?: number;
  maxZoom?: number;
}): ViewportXYZ {
  const { bounds, focus, selected, width, height, pad } = opts;
  const readingZoom = opts.readingZoom ?? 0.85;
  const minFit = opts.minFitZoom ?? 0.62;
  const maxZoom = opts.maxZoom ?? 1;
  const availW = Math.max(1, width - pad.left - pad.right);
  const availH = Math.max(1, height - pad.top - pad.bottom);
  const fit = Math.min(availW / Math.max(1, bounds.width), availH / Math.max(1, bounds.height));
  if (fit >= minFit) {
    const zoom = Math.min(fit, maxZoom);
    return {
      zoom,
      x: pad.left + (availW - bounds.width * zoom) / 2 - bounds.x * zoom,
      y: pad.top + (availH - bounds.height * zoom) / 2 - bounds.y * zoom,
    };
  }
  const zoom = readingZoom;
  const at = (rects: Rect[]) => {
    const anchor = rects.length ? union(rects) : bounds;
    return { x: pad.left - anchor.x * zoom, y: pad.top - anchor.y * zoom };
  };
  let { x, y } = at(focus);
  if (selected && opts.selectionFocus?.length) {
    const sx = selected.x * zoom + x;
    const sy = selected.y * zoom + y;
    const inside =
      sx >= pad.left &&
      sy >= pad.top &&
      sx + selected.width * zoom <= width - pad.right &&
      sy + selected.height * zoom <= height - pad.bottom;
    if (!inside) ({ x, y } = at(opts.selectionFocus));
  }
  if (selected) {
    // Shift each axis just enough; the left/top edge wins when the node is larger than the view.
    const keepIn = (offset: number, pos: number, size: number, lo: number, hi: number) => {
      const end = (pos + size) * zoom + offset;
      let out = end > hi ? offset - (end - hi) : offset;
      if (pos * zoom + out < lo) out = lo - pos * zoom;
      return out;
    };
    x = keepIn(x, selected.x, selected.width, pad.left, width - pad.right);
    y = keepIn(y, selected.y, selected.height, pad.top, height - pad.bottom);
  }
  return { x, y, zoom };
}

function union(rects: Rect[]): Rect {
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.width));
  const y1 = Math.max(...rects.map((r) => r.y + r.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
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
