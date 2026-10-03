/**
 * The graph canvas (docs/ui.md §5): dagre layout, node cards, loop regions with back-edges, the
 * orchestration lane, critical-path and focus modes, filters, minimap, zoom, keyboard map, and
 * the accessible table alternative. Also renders read-only previews of specs.
 */
import type { GraphView, NodeSummary, Note } from '@agent-graphs/sdk';
import {
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  type Edge as RFEdge,
  type Node as RFNode,
  useReactFlow,
  useStore,
  type Viewport,
} from '@xyflow/react';
import {
  Crosshair,
  Focus,
  Maximize,
  Minus,
  Plus,
  Route,
  Search,
  Table2,
  Waypoints,
} from 'lucide-react';
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { executorMismatch } from '../../../components/exec-badge';
import { toMs } from '../../../lib/format';
import {
  adjacency,
  CARD_W,
  type LayoutResult,
  lineage,
  neighborInDirection,
  neighbors,
  openingViewport,
  type Rect,
} from '../../../lib/layout';
import { viewToLayoutInput } from '../../../lib/preview';
import { ATTENTION_STATUSES } from '../../../lib/status';
import { cn } from '../../../lib/utils';
import type { CanvasSearch } from '../../../router';
import { type DepData, DepEdge, EdgeMarkers } from './dep-edge';
import { type LoopData, LoopRegionNode } from './loop-region';
import {
  ariaLabel,
  type CanvasActions,
  CanvasActionsContext,
  type CardData,
  type LoopMark,
  NodeCard,
  type NoteCounts,
} from './node-card';
import { NodeTable } from './node-table';
import { OrchestrationLane, scopeKeys } from './orchestration-lane';
import { useLayout } from './use-layout';

const nodeTypes = { card: NodeCard, loop: LoopRegionNode };
const edgeTypes = { dep: DepEdge };
const LANE_H = 62;
const HEARTBEAT_EVERY_MS = 300_000;

export type GraphCanvasProps = {
  view: GraphView;
  graph: string;
  selected?: string;
  selectedOrch?: string;
  search: CanvasSearch;
  onSearch?: (patch: Partial<CanvasSearch>) => void;
  onSelect?: (key: string | null) => void;
  onSelectOrch?: (key: string) => void;
  notes?: Note[];
  actions?: CanvasActions;
  showLane?: boolean;
};

export function GraphCanvas(props: GraphCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function noteCountsByNode(notes: Note[] | undefined): Map<string, NoteCounts> {
  const out = new Map<string, NoteCounts>();
  for (const n of notes ?? []) {
    if (!n.nodeId || n.retractedAt) continue;
    const c = out.get(n.nodeId) ?? { total: 0 };
    c.total += 1;
    if (n.type === 'deliverable' || n.type === 'proof' || n.type === 'finding')
      c[n.type] = (c[n.type] ?? 0) + 1;
    else c.other = (c.other ?? 0) + 1;
    out.set(n.nodeId, c);
  }
  return out;
}

function isStale(n: NodeSummary, now: number): boolean {
  const a = n.currentAttempt;
  if (n.status !== 'running' || !a) return false;
  const last = toMs(a.lastHeartbeatAt) ?? toMs(a.startedAt);
  return last !== undefined && now - last > 2 * HEARTBEAT_EVERY_MS;
}

function matchesFilter(n: NodeSummary, s: CanvasSearch): boolean {
  if (s.status) {
    const wanted = s.status.split(',');
    const ok = wanted.some((w) =>
      w === 'attention' ? ATTENTION_STATUSES.has(n.status) : w === n.status,
    );
    if (!ok) return false;
  }
  if (s.tag && !n.tags.includes(s.tag)) return false;
  if (s.kind && n.kind !== s.kind) return false;
  if (s.model && (n.currentAttempt?.executor.model ?? n.executor.model) !== s.model) return false;
  return true;
}

function CanvasInner({
  view,
  graph,
  selected,
  selectedOrch,
  search,
  onSearch,
  onSelect,
  onSelectOrch,
  notes,
  actions,
  showLane = true,
}: GraphCanvasProps) {
  const rf = useReactFlow();
  const markerPrefix = `m${useId().replace(/:/g, '')}`;
  const input = useMemo(() => viewToLayoutInput(view), [view]);
  const layout = useLayout(input);
  const adj = useMemo(() => adjacency(input.edges), [input]);
  const [hovered, setHovered] = useState<string | null>(null);
  const [hoveredOrch, setHoveredOrch] = useState<string | null>(null);
  const [openEdge, setOpenEdge] = useState<string | null>(null);
  const [showInforms, setShowInforms] = useState(false);
  const [finding, setFinding] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const readOnly = actions?.readOnly ?? true;

  const counts = useMemo(() => noteCountsByNode(notes), [notes]);
  const gateRequests = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of view.requests)
      if (r.nodeId && r.status === 'open' && (r.subject === 'gate' || r.kind === 'approval'))
        m.set(r.nodeId, r.id);
    return m;
  }, [view.requests]);
  const nodeByKey = useMemo(() => new Map(view.nodes.map((n) => [n.key, n])), [view.nodes]);
  const loopMarks = useMemo(() => {
    const m = new Map<string, LoopMark[]>();
    for (const l of input.loops) {
      const loop = view.loops.find((x) => x.key === l.key);
      if (!loop) continue;
      for (const k of l.body) {
        const role: LoopMark['role'] = k === l.from ? 'trigger' : k === l.to ? 'entry' : 'body';
        m.set(k, [
          ...(m.get(k) ?? []),
          {
            key: l.key,
            status: loop.status,
            iteration: loop.iteration,
            max: loop.maxIterations + loop.grantedIterations,
            role,
          },
        ]);
      }
    }
    return m;
  }, [input.loops, view.loops]);

  const critical = useMemo(
    () => new Set(search.cp ? view.criticalPath : []),
    [search.cp, view.criticalPath],
  );
  const dimmed = useMemo(() => {
    let keep: Set<string> | undefined;
    if (hoveredOrch) {
      const o = view.orchestrators.find((x) => x.key === hoveredOrch);
      if (o) keep = scopeKeys(o, view.nodes);
    } else if (search.focus && selected) keep = lineage(selected, adj);
    else if (search.cp && critical.size) keep = critical;
    const filtered = search.status || search.tag || search.kind || search.model;
    const out = new Set<string>();
    for (const n of view.nodes) {
      if ((keep && !keep.has(n.key)) || (filtered && !matchesFilter(n, search))) out.add(n.key);
    }
    return out;
  }, [hoveredOrch, search, selected, adj, critical, view.nodes, view.orchestrators]);

  // Reuse card data objects whose inputs did not change, so memoized cards skip re-rendering.
  const dataCache = useRef(new Map<string, { sig: string; data: CardData }>());
  // `now` (staleness) is re-read whenever the view changes.
  const rfNodes = useMemo<RFNode[]>(() => {
    const now = Date.now();
    if (!layout) return [];
    const out: RFNode[] = [];
    for (const l of input.loops) {
      const region = layout.loops[l.key];
      const loop = view.loops.find((x) => x.key === l.key);
      if (!region || !loop) continue;
      const rel = (k: string): Rect | undefined => {
        const r = layout.nodes[k];
        return r ? { ...r, x: r.x - region.x, y: r.y - region.y } : undefined;
      };
      const trigger = rel(l.from);
      const entry = rel(l.to);
      const data: LoopData = {
        key: l.key,
        ...(loop.title ? { title: loop.title } : {}),
        status: loop.status,
        iteration: loop.iteration,
        max: loop.maxIterations + loop.grantedIterations,
        width: region.width,
        height: region.height,
        ...(trigger ? { trigger } : {}),
        ...(entry ? { entry } : {}),
        dim: Boolean(hoveredOrch || (search.focus && selected)),
      };
      out.push({
        id: `loop:${l.key}`,
        type: 'loop',
        position: { x: region.x, y: region.y },
        data: data as unknown as Record<string, unknown>,
        draggable: false,
        selectable: false,
        focusable: false,
        className: 'loop-host',
        zIndex: -10 + region.depth,
        width: region.width,
        height: region.height,
      });
    }
    for (const n of view.nodes) {
      const r = layout.nodes[n.key];
      if (!r) continue;
      const mismatch = executorMismatch(n.executor, n.currentAttempt?.executor);
      const awaiting = n.aims.filter(
        (a) => a.terminating && a.status === 'pending' && a.evaluator !== 'self',
      ).length;
      const flags = {
        loopMarks: loopMarks.get(n.key) ?? [],
        notes: counts.get(n.id),
        gateRequestId: gateRequests.get(n.id),
        stale: isStale(n, now),
        mismatch,
        dim: dimmed.has(n.key),
        hl: Boolean(hoveredOrch && !dimmed.has(n.key)),
        crit: critical.has(n.key),
        selected: selected === n.key,
        awaiting,
      };
      const sig = JSON.stringify([n, flags]);
      const cached = dataCache.current.get(n.key);
      let data: CardData;
      if (cached && cached.sig === sig) data = cached.data;
      else {
        data = { node: n, ...flags } as CardData;
        dataCache.current.set(n.key, { sig, data });
      }
      out.push({
        id: n.key,
        type: 'card',
        position: { x: r.x, y: r.y },
        data: data as unknown as Record<string, unknown>,
        draggable: false,
        selectable: false,
        width: r.width,
        // The minimap and fitView need a height; cards size themselves (no `height` style).
        initialHeight: r.height,
        ariaLabel: ariaLabel(n),
        zIndex: 1,
      });
    }
    return out;
  }, [
    layout,
    view,
    input.loops,
    loopMarks,
    counts,
    gateRequests,
    dimmed,
    critical,
    selected,
    hoveredOrch,
    search.focus,
  ]);

  const rfEdges = useMemo<RFEdge[]>(() => {
    if (!layout) return [];
    const focus = hovered ?? selected;
    return view.edges
      .map((e): RFEdge | undefined => {
        const from = e.from;
        const to = e.to;
        if (!from || !to || !layout.nodes[from] || !layout.nodes[to]) return undefined;
        const src = nodeByKey.get(from);
        const dst = nodeByKey.get(to);
        const live = dst?.status === 'running';
        const done =
          (src?.status === 'done' || src?.status === 'skipped') &&
          dst !== undefined &&
          ['done', 'running', 'evaluating', 'needs_input', 'blocked', 'ready'].includes(dst.status);
        const span = (layout.nodes[to] as Rect).x - (layout.nodes[from] as Rect).x;
        const touches = focus === from || focus === to;
        const orchDim = hoveredOrch ? dimmed.has(from) || dimmed.has(to) : false;
        const data: DepData = {
          kind: e.kind,
          state: live ? 'live' : done ? 'done' : 'idle',
          from,
          to,
          ...(e.relation ? { relation: e.relation } : {}),
          ...(e.condition ? { condition: e.condition } : {}),
          ...(e.guidance ? { guidance: e.guidance } : {}),
          ...(e.pitfalls ? { pitfalls: e.pitfalls } : {}),
          provenance: e.attrProvenance,
          hoverOnly: e.kind === 'informs' && span > 2 * (CARD_W + 44) + 10,
          shown: showInforms,
          emphasized: touches,
          dim: Boolean((hovered && !touches) || orchDim || (dimmed.has(from) && dimmed.has(to))),
          crit:
            critical.has(from) &&
            critical.has(to) &&
            e.kind === 'requires' &&
            isConsecutive(view.criticalPath, from, to),
          open: openEdge === e.id,
          markerPrefix,
          onToggle: setOpenEdge,
        };
        return {
          id: e.id,
          source: from,
          target: to,
          type: 'dep',
          data: data as unknown as Record<string, unknown>,
          selectable: false,
          focusable: false,
          zIndex: openEdge === e.id ? 20 : 0,
        };
      })
      .filter((x): x is RFEdge => Boolean(x));
  }, [
    layout,
    view.edges,
    view.criticalPath,
    nodeByKey,
    hovered,
    selected,
    hoveredOrch,
    dimmed,
    critical,
    showInforms,
    openEdge,
    markerPrefix,
  ]);

  // Fit once per structure; keep the viewport stable across status updates.
  const fittedHash = useRef<string | undefined>(undefined);
  const fitPadding = useMemo(
    () =>
      ({
        top: `${showLane ? LANE_H + 46 : 40}px`,
        bottom: '76px',
        left: '24px',
        right: '24px',
      }) as const satisfies Record<string, `${number}px`>,
    [showLane],
  );
  const fitAll = useCallback(
    (duration = 0) => {
      void rf.fitView({ padding: fitPadding, maxZoom: 1, minZoom: 0.2, duration });
    },
    [rf, fitPadding],
  );
  const onMove = useCallback((_: unknown, vp: Viewport) => {
    const el = containerRef.current;
    if (!el) return;
    const g = 20 * vp.zoom;
    el.style.backgroundSize = `${g}px ${g}px`;
    el.style.backgroundPosition = `${vp.x}px ${vp.y}px`;
  }, []);

  // The first fit for a structure owns the viewport; selection scrolling waits for it.
  const fitPending = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: fit once per structure, not per selection
  useEffect(() => {
    if (!layout || rfNodes.length === 0 || fittedHash.current === layout.hash) return;
    fittedHash.current = layout.hash;
    fitPending.current = true;
    // Open on the active frontier (live, waiting and ready work plus neighbors) at the design
    // reference's reading zoom, keeping the selection in view. "Fit graph" shows everything.
    const focus: Rect[] = [];
    for (const n of view.nodes) {
      if (!['running', 'evaluating', 'needs_input', 'blocked', 'ready'].includes(n.status))
        continue;
      for (const k of neighbors(n.key, adj)) {
        const r = layout.nodes[k];
        if (r) focus.push(r);
      }
    }
    // Keep loop regions around the focus whole, back-edge pill included.
    for (const l of input.loops) {
      const region = layout.loops[l.key];
      const touches = l.body.some((k) => {
        const r = layout.nodes[k];
        return r && focus.includes(r);
      });
      if (region && touches)
        focus.push({ ...region, y: region.y - 34, height: region.height + 34 });
    }
    requestAnimationFrame(() => {
      const el = containerRef.current;
      if (el) {
        const vp = openingViewport({
          bounds: layout.bounds,
          focus,
          selected: selected ? layout.nodes[selected] : undefined,
          width: el.clientWidth,
          height: el.clientHeight,
          pad: {
            top: (showLane ? LANE_H : 0) + 46,
            bottom: 76,
            left: 24,
            right: 24,
          },
        });
        void rf.setViewport(vp);
        onMove(null, vp);
      }
      fitPending.current = false;
    });
  }, [layout, rfNodes.length, rf, view.nodes, adj, showLane, input.loops]);

  // Bring a newly selected node into view (keyboard, palette, inbox links).
  useEffect(() => {
    if (!selected || !layout?.nodes[selected] || !containerRef.current || fitPending.current)
      return;
    if (!inView(selected, layout, rf, containerRef.current)) centerOn(selected, layout, rf, true);
  }, [selected, layout, rf]);

  const select = useCallback(
    (key: string | null) => {
      setOpenEdge(null);
      onSelect?.(key);
    },
    [onSelect],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (e.key === '/') {
      e.preventDefault();
      setFinding(true);
      return;
    }
    if (e.key === 'Escape') {
      if (openEdge) setOpenEdge(null);
      else if (finding) setFinding(false);
      else select(null);
      return;
    }
    if (e.key === 'Enter') {
      const id = target.closest('.react-flow__node')?.getAttribute('data-id');
      if (id && nodeByKey.has(id)) {
        e.preventDefault();
        select(id);
      }
      return;
    }
    const dir = (
      { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' } as const
    )[e.key as 'ArrowLeft'];
    if (dir && layout) {
      const from =
        selected ??
        target.closest('.react-flow__node')?.getAttribute('data-id') ??
        view.criticalPath[0] ??
        view.nodes[0]?.key;
      if (!from) return;
      e.preventDefault();
      const next = selected ? neighborInDirection(from, dir, layout.nodes, adj) : from;
      if (next) select(next);
    }
  };

  const actionsValue = actions ?? { readOnly: true, onApprove: () => {}, onReview: () => {} };

  if (search.table)
    return (
      <div className="canvas" ref={containerRef} style={{ overflow: 'auto' }}>
        {showLane && (
          <OrchestrationLane
            orchestrators={view.orchestrators}
            graph={graph}
            {...(selectedOrch ? { selected: selectedOrch } : {})}
            onHover={setHoveredOrch}
            onSelect={(k) => onSelectOrch?.(k)}
            readOnly={readOnly}
          />
        )}
        <CanvasTopBar
          search={search}
          {...(onSearch ? { onSearch } : {})}
          onFind={() => setFinding(true)}
          hasSelection={Boolean(selected)}
        />
        <NodeTable
          nodes={view.nodes}
          {...(selected ? { selected } : {})}
          onSelect={(k) => select(k)}
        />
      </div>
    );

  return (
    <CanvasActionsContext.Provider value={actionsValue}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the canvas keyboard map (docs/ui.md §5.3) */}
      <div className={cn('canvas')} ref={containerRef} onKeyDown={onKeyDown} data-testid="canvas">
        <EdgeMarkers prefix={markerPrefix} />
        {showLane && (
          <OrchestrationLane
            orchestrators={view.orchestrators}
            graph={graph}
            {...(selectedOrch ? { selected: selectedOrch } : {})}
            onHover={setHoveredOrch}
            onSelect={(k) => onSelectOrch?.(k)}
            readOnly={readOnly}
          />
        )}
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onMove={onMove}
          onInit={(inst) => onMove(null, inst.getViewport())}
          minZoom={0.2}
          maxZoom={1.6}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          panOnScroll
          zoomOnScroll={false}
          zoomOnPinch
          zoomOnDoubleClick={false}
          onlyRenderVisibleElements={view.nodes.length > 120}
          proOptions={{ hideAttribution: true }}
          onNodeClick={(_, node) => {
            if (node.type === 'card') select(node.id);
          }}
          onNodeDoubleClick={(_, node) => {
            if (node.type !== 'card') return;
            const ids = [...neighbors(node.id, adj)].map((id) => ({ id }));
            void rf.fitView({ nodes: ids, duration: 300, padding: 0.25, maxZoom: 1.1 });
          }}
          onNodeMouseEnter={(_, node) => node.type === 'card' && setHovered(node.id)}
          onNodeMouseLeave={() => setHovered(null)}
          onPaneClick={() => setOpenEdge(null)}
          aria-label={`Graph canvas: ${view.graph.title}`}
        >
          <CanvasToolbar
            onFit={() => fitAll(250)}
            showInforms={showInforms}
            onToggleInforms={() => setShowInforms((v) => !v)}
          />
        </ReactFlow>
        <CanvasTopBar
          search={search}
          {...(onSearch ? { onSearch } : {})}
          onFind={() => setFinding(true)}
          hasSelection={Boolean(selected)}
        />
        {finding && (
          <NodeFinder
            nodes={view.nodes}
            onPick={(k) => {
              setFinding(false);
              select(k);
              if (layout) centerOn(k, layout, rf, true);
            }}
            onClose={() => setFinding(false)}
          />
        )}
        {!layout && view.nodes.length > 0 && (
          <div className="empty" style={{ position: 'absolute', inset: 0 }}>
            Laying out…
          </div>
        )}
      </div>
    </CanvasActionsContext.Provider>
  );
}

function isConsecutive(path: string[], a: string, b: string): boolean {
  const i = path.indexOf(a);
  return i >= 0 && path[i + 1] === b;
}

function inView(
  key: string,
  layout: LayoutResult,
  rf: ReturnType<typeof useReactFlow>,
  el: HTMLElement,
): boolean {
  const r = layout.nodes[key];
  if (!r) return true;
  const vp = rf.getViewport();
  const x0 = r.x * vp.zoom + vp.x;
  const y0 = r.y * vp.zoom + vp.y;
  return (
    x0 > 0 &&
    y0 > LANE_H &&
    x0 + r.width * vp.zoom < el.clientWidth &&
    y0 + r.height * vp.zoom < el.clientHeight - 60
  );
}

function centerOn(
  key: string,
  layout: LayoutResult,
  rf: ReturnType<typeof useReactFlow>,
  animate: boolean,
) {
  const r = layout.nodes[key];
  if (!r) return;
  const zoom = Math.max(rf.getZoom(), 0.7);
  void rf.setCenter(r.x + r.width / 2, r.y + r.height / 2 - 20, {
    zoom,
    duration: animate ? 300 : 0,
  });
}

function CanvasToolbar({
  onFit,
  showInforms,
  onToggleInforms,
}: {
  onFit: () => void;
  showInforms: boolean;
  onToggleInforms: () => void;
}) {
  const rf = useReactFlow();
  const zoom = useStore((s) => s.transform[2]);
  const line = (stroke: string, w: number, dash?: string) => (
    <svg className="k" viewBox="0 0 22 8" aria-hidden="true">
      <path
        d="M1,4 H21"
        stroke={stroke}
        strokeWidth={w}
        {...(dash ? { strokeDasharray: dash } : {})}
      />
    </svg>
  );
  return (
    <div className="cv-tools" role="toolbar" aria-label="Canvas tools">
      <div className="zoom">
        <button
          type="button"
          aria-label="Zoom out"
          title="Zoom out"
          onClick={() => void rf.zoomOut({ duration: 150 })}
        >
          <Minus size={14} />
        </button>
        <span className="zv" aria-live="polite">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          aria-label="Zoom in"
          title="Zoom in"
          onClick={() => void rf.zoomIn({ duration: 150 })}
        >
          <Plus size={14} />
        </button>
        <span className="vr" />
        <button type="button" aria-label="Fit graph" title="Fit graph" onClick={onFit}>
          <Maximize size={14} />
        </button>
      </div>
      <div className="cv-legend">
        <span>{line('var(--edge-done)', 1.6)}requires</span>
        <button
          type="button"
          className={cn(showInforms && 'on')}
          onClick={onToggleInforms}
          aria-pressed={showInforms}
          title="Long informs edges show on hover or selection — click to show all"
        >
          {line('var(--edge-informs)', 1.5, '4 3')}informs
        </button>
        <span>{line('var(--accent)', 1.8, '5 4')}loop</span>
        <span>{line('var(--s-running)', 1.6, '1.5 4')}live input</span>
        <span>
          <svg className="k" viewBox="0 0 22 8" aria-hidden="true">
            <path d="M1,4 H21" stroke="var(--edge-done)" strokeWidth="1.4" />
            <circle
              cx="11"
              cy="4"
              r="3.2"
              fill="var(--card)"
              stroke="var(--accent-fg)"
              strokeWidth="1.3"
            />
          </svg>
          edge guidance
        </span>
      </div>
      <div className="minimap" title="Minimap">
        <MiniMap
          pannable
          zoomable
          ariaLabel="Minimap"
          nodeBorderRadius={14}
          nodeClassName={(n) => {
            if (n.type === 'loop') return 'mm-loop';
            const d = n.data as unknown as CardData;
            return `mm-node st-${d.node.status}${d.selected ? ' mm-sel' : ''}`;
          }}
          style={{ width: 196, height: 40 }}
        />
      </div>
    </div>
  );
}

const FILTERS: Array<{ id: string; label: string }> = [
  { id: '', label: 'All' },
  { id: 'running', label: 'Running' },
  { id: 'attention', label: 'Attention' },
  { id: 'ready', label: 'Ready' },
  { id: 'evaluating', label: 'Evaluating' },
  { id: 'done', label: 'Done' },
];

function CanvasTopBar({
  search,
  onSearch,
  onFind,
  hasSelection,
}: {
  search: CanvasSearch;
  onSearch?: (patch: Partial<CanvasSearch>) => void;
  onFind: () => void;
  hasSelection: boolean;
}) {
  if (!onSearch) return null;
  return (
    <div className="cv-top" role="toolbar" aria-label="Canvas view options">
      <select
        className="input"
        style={{ height: 26, width: 132, fontSize: 12, boxShadow: 'var(--shadow-md)' }}
        value={search.status ?? ''}
        onChange={(e) => onSearch({ status: e.target.value || undefined })}
        aria-label="Filter nodes by status"
      >
        {FILTERS.map((f) => (
          <option key={f.id || 'all'} value={f.id}>
            {f.id ? `Show: ${f.label}` : 'All statuses'}
          </option>
        ))}
      </select>
      <button
        type="button"
        className={cn('btn sm', search.cp && 'primary')}
        aria-pressed={Boolean(search.cp)}
        onClick={() => onSearch({ cp: search.cp ? undefined : true })}
        title="Highlight the critical path"
      >
        <Route />
        Critical path
      </button>
      <button
        type="button"
        className={cn('btn sm', search.focus && 'primary')}
        aria-pressed={Boolean(search.focus)}
        onClick={() => onSearch({ focus: search.focus ? undefined : true })}
        title={
          hasSelection
            ? 'Dim everything outside the selection’s ancestors and descendants'
            : 'Select a node, then focus on its lineage'
        }
      >
        <Focus />
        Focus
      </button>
      <button
        type="button"
        className={cn('btn sm', search.table && 'primary')}
        aria-pressed={Boolean(search.table)}
        onClick={() => onSearch({ table: search.table ? undefined : true })}
        title="Show nodes as a table"
      >
        {search.table ? <Waypoints /> : <Table2 />}
        {search.table ? 'Canvas' : 'Table'}
      </button>
      <button
        type="button"
        className="btn sm"
        onClick={onFind}
        title="Find a node (/)"
        aria-label="Find a node"
      >
        <Search />
      </button>
    </div>
  );
}

function NodeFinder({
  nodes,
  onPick,
  onClose,
}: {
  nodes: NodeSummary[];
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const matches = nodes
    .filter(
      (n) =>
        !q || n.key.includes(q.toLowerCase()) || n.title.toLowerCase().includes(q.toLowerCase()),
    )
    .slice(0, 8);
  return (
    <div className="canvas-search popover" role="dialog" aria-label="Find a node">
      <div className="row" style={{ gap: 6 }}>
        <Crosshair size={14} className="muted" />
        <input
          className="input"
          // biome-ignore lint/a11y/noAutofocus: opened by the `/` shortcut
          autoFocus
          value={q}
          placeholder="Find a node by key or title"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'Enter' && matches[0]) onPick(matches[0].key);
          }}
          aria-label="Find a node"
        />
      </div>
      <div style={{ marginTop: 6 }}>
        {matches.map((n) => (
          <button
            key={n.id}
            type="button"
            className="menu-item"
            style={{ width: '100%' }}
            onClick={() => onPick(n.key)}
          >
            <span className="mono">{n.key}</span>
            <span className="ellipsis muted">{n.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
