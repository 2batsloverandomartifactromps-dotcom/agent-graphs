# Web UI

The UI is how humans **interrogate, steer, and audit** agent work. It has to make graph state
legible in seconds and keep every claim traceable to its evidence.

**Visual reference:** [`docs/design/ui-mockup.html`](design/ui-mockup.html), a self-contained
mockup you can open in any browser. Screenshots are in [`docs/design/screenshots/`](design/screenshots/).
The implementation should match its layout, density, and visual language. Where the mockup and
this document disagree on behavior, this document wins. On look and feel, the mockup wins.

## 1. Principles

1. **The 5-second rule.** On any graph, a person should see within 5 seconds where things stand,
   what is stuck, and who is working on what.
2. **Status is never color alone.** Every status pairs a color with an icon and a label, and
   fills are distinct (outlined = blocked, solid = failed, striped = skipped).
3. **Live but calm.** Updates stream in through SSE with subtle motion: pulses for running work,
   a brief highlight on change. Nothing jumps. The layout depends only on structure, never on
   status.
4. **Progressive disclosure.** Canvas → node card → inspector tabs → evidence → raw event JSON.
5. **Everything is evidence-linked.** Every aim verdict, metric, and status links to the note,
   evaluation, or event behind it. Execution annotations (model, thinking, provider, mechanism)
   appear wherever agent output appears.
6. **Every view is addressable.** Selection, tab, filters, and canvas focus live in the URL.
7. **Humans steer from the same place they observe.** Configuration edits, directives, and inbox
   resolutions happen next to the data, and their delivery and acknowledgment by agents is
   visible.

## 2. Information architecture

| Route | Screen |
|---|---|
| `/` | **Overview**: attention queue, KPIs, active graphs, live activity, models in use |
| `/graphs` | **Graphs**: all graphs, with saved views Active · Needs attention · Completed · Failed · Drafts · Archived |
| `/graphs/new` | **New graph**: from a spec (YAML editor + validation + live preview), from a template (M5), or blank |
| `/graphs/$graph` | **Graph workspace**, Canvas tab |
| `/graphs/$graph/timeline` · `/aims` · `/notes` · `/activity` · `/agents` · `/spec` · `/evolution` · `/settings` | Workspace tabs (Evolution only when enabled) |
| `/graphs/$graph/nodes/$node?tab=notes` | Canvas with the node inspector open (deep link) |
| `/graphs/$graph/orchestrators/$key` | Canvas with the orchestrator inspector open |
| `/inbox` | **Inbox**: approvals, questions, escalations, blockers across graphs |
| `/agents` | **Agents**: sessions (active and recent), what each is doing, usage by model, provider, and mechanism |
| `/notes` | **Notes explorer**: cross-graph search and filter (type, severity, model, provider, mechanism, node, time) |
| `/settings` | Display name, tokens (admin), theme, defaults, vocabulary overrides |

## 3. Global shell

- **Left sidebar** (collapsible): wordmark, Overview, Graphs, Inbox (with a live count badge),
  Agents, Notes, Settings. Pinned and recent graphs appear below.
- **Top bar**: breadcrumb, **⌘K command palette** (jump to a graph, node, or note; run actions
  such as "pause graph" or "open inbox"), a **live indicator** (● Live / reconnecting /
  offline), and the theme toggle.
- **Toasts** for completed actions. **Browser notifications** (opt-in) for new blocking inbox
  items.

## 4. Screens

### 4.1 Overview
A KPI row (active graphs, running nodes, needs attention, completed this week, spend today, each
with a sparkline). Below it: the **Needs attention** queue (approvals, escalations, questions,
stale leases, guard violations), sorted by blocking first, then age. **Active graph cards** show a
progress bar segmented by status, aims summary chips, live agent avatars with model badges, and
last activity. A **live activity feed** of significant events. **Models in use**: horizontal
bars by model, splittable by provider or mechanism, with cost.

### 4.2 Graphs list
A table or card toggle with: title, status pill, progress (segmented), aims (met/total with
chips), running/attention counts, cost, started, last activity, and tags. The table has
type-ahead search, filters, and sort. Saved views are tabs. Multi-select allows archive and
export.

### 4.3 Graph workspace
**Header**: the title with an editable-inline status pill and lifecycle actions (Start, Pause,
Resume, Cancel, Reopen, Archive); **overall aim chips** (qualitative: verdict icon and evaluator;
quantitative: value against target as a mini gauge); a **segmented progress bar** with legend
and counts; stats (elapsed, spend against guard, attempts, active loops `↺`); and a stalled badge
when applicable.

**Tabs**
- **Canvas** (default, section 5).
- **Timeline**: Gantt-style swimlanes per node (toggle: per agent session). Attempts are bars
  colored by outcome, loop iterations are bracketed, there is a now-line, and zoom runs from
  minutes to days. It shows parallelism, idle gaps, and rework at a glance.
- **Aims**: graph aims as large cards (evidence, history). A node-aims matrix (rows are nodes,
  columns are aims, cells are verdicts). **Metric charts**: value per attempt and iteration
  with the target line (for example test pass rate across loop iterations).
- **Notes**: every note in the graph with facets (type, severity, model, provider, mechanism,
  node) and an **Audit** toggle that lists gaps (done nodes without proof, waivers, missing
  summaries).
- **Activity**: the live event feed with filters. Clicking an event opens it with actor, payload,
  and diff, plus the hash-chain status ("Audit chain verified ✓ · 12,345 events").
- **Agents**: sessions that touched this graph, attempts per session, usage and cost by model,
  and "recommended vs actual" executor mismatches.
- **Spec**: the canonical YAML export (copy or download). Edit-as-YAML applies a mutation batch
  with a diff preview. M5 adds revision history and diffs.
- **Evolution** *(when `evolution.mode` ≠ off; [self-evolution.md](self-evolution.md))*:
  - **Lessons**: scope, kind, content, provenance, helpful/harmful counters, retire and merge
    actions.
  - **Proposals**: each shows a diff of the ops, the **contrastive traces side by side** (the
    high-scoring attempt next to the low-scoring one), the validation ladder with per-stage
    scores, the gate decision, and approve, reject, or revert actions.
  - **Rejection memory** and **lineage**: a version tree with scores, for templates (E3).
  - **Settings**: mode, scope, protected fields, validation, budget, and a kill switch.
- **Settings**: policy, guard aims, orchestrators, and danger zone.

### 4.4 Node inspector (right drawer, resizable, about 420–560 px)
**Header**: status (icon, label, and reason), mono key, title, kind and priority, loop
membership (`↺ api-fix-cycle 2/4`), and quick actions: **Pause/Resume · Retry (+N) · Skip
(reason) · Add directive · Reopen**.

| Tab | Content |
|---|---|
| **Overview** | Aim, purpose, **prompt** (rendered, with copy and a "view raw" toggle), context, deliverables, checklist with tick state and evidence, dependencies (in and out, clickable, each with its edge condition, guidance, and pitfalls), executor hints, and **lessons & pitfalls** for this node (when `learn` mode is on). |
| **Aims** | Each aim: status, kind, evaluator, criteria, latest verdict with rationale, evaluator annotation, and evidence. Quantitative aims get a sparkline across attempts with the target line. Waive action (admin). |
| **Attempts** | An iteration timeline grouped by activation (loop iteration). Each attempt shows its executor badge, duration, outcome, summary, evaluations, `feedbackIn` ("what the agent was told"), checkpoint, and usage. The running attempt shows a live lease countdown and heartbeat age. |
| **Notes** | Typed note cards (icon and type), title, annotation badge (model · thinking · provider · mechanism), time, markdown body, evidence chips (commit, PR, file, url, command with exit code and an expandable output). Filter by type. Replies are threaded. Retracted notes are shown struck through, with the reason. |
| **Activity** | Events for this node. |
| **Briefing** | **The exact briefing an agent would receive now** (budget slider, copy). This is the main tool for debugging prompts. |
| **Config** | Editable prompt, aim, purpose, deliverables, aims (targets, thresholds, evaluator), `maxAttempts`, `onExhausted`, executor hints, priority, and tags. Saving shows a diff preview. If an attempt is open, a **change directive** is created and tracked inline (pending → delivered → acknowledged, with the agent's ack note). |

### 4.5 Orchestrator inspector
Role, status, and bound session (annotation, lease, heartbeat), aim, purpose, prompt, scope
(highlighted on the canvas), capabilities, the **duty queue**, notes (decisions, dispatch log),
activity, and config.

### 4.6 Inbox
Request cards across graphs, filterable by kind, graph, assignee, and blocking. Each card shows:
kind icon, title, graph › node, who raised it (with annotation), age, blocking badge, context
(evidence links, the relevant aim or diff), and inline **actions**:
- Approval: **Approve** / **Request changes** (comment required on reject).
- Question: an answer box (plus choice buttons when options exist). It sends an `answer`
  directive.
- Escalation: buttons for each option (Retry +N, Extend +N, Accept as-is, Skip, Fail, Edit &
  retry), each with a short consequence line.
- Blocker: Provide info & unblock / Skip / Fail.

Resolved items move to a "Resolved" tab with the outcome and the downstream effect.

### 4.7 New graph
A split view: CodeMirror YAML on the left (schema-aware autocompletion, inline validation
markers with hints) and a live canvas preview on the right, with warnings and errors listed
below. Actions: Validate · Create draft · Create & start. Drafts open in the workspace with
editing enabled.

## 5. Canvas

### 5.1 Layout
- Left-to-right layered layout (dagre in a Web Worker) of the forward `requires` and `informs`
  DAG. The layout is memoized by a structure hash, so status changes never relayout.
- **Loop bodies** are drawn as softly tinted rounded regions behind their nodes, labelled
  `↺ name · 2/4`. **Back-edges** are dashed accent curves routed below or above the body, with a
  pill showing the iteration. The active loop's dashes animate. Exhausted loops turn red, and
  satisfied loops show a check.
- The **orchestration lane** is a fixed band above the canvas with orchestrator cards (role
  icon, name, status, bound model badge, action counters, duty-queue size). Hovering one
  highlights the nodes in its scope and dims the rest. Dispatch and evaluation events briefly
  animate a pulse from the lane to the target node.
- Edge styles: `requires` is solid, `informs` is dashed and thinner, labels appear on hover.
  Edges into and out of the selected node are emphasized. Edges that carry procedural knowledge
  get a small dot. Hover or click opens a popover with `relation`, `condition`, `guidance`, and
  `pitfalls`, plus provenance (authored or learned). An optional **reliability view** (E3) sets
  edge opacity and width from historical success contribution.

### 5.2 Node card (about 240 × 104 px at 100% zoom)
```
┌─────────────────────────────────────────────┐
│▌ ◉ Running            implement-api   2/3 ↺ │  status icon+label · mono key · attempts · loop mark
│  Implement REST API                          │  title
│  CRUD + auth endpoints for notes…            │  aim (1 line, muted)
│  ▓▓▓▓▓▓▓░░░ 64% · Fixing auth middleware     │  progress + current step (running only)
│  ○ unit-tests  ○ layering  ○ handles-errors  │  aim chips (last values on hover)
│  [Opus 5.5 ▮▮▮▮ ⌘]            ◆2  ✓1  ⚑1     │  executor badge · note counts (deliverable/proof/finding)
└─────────────────────────────────────────────┘
```
- **Gate**: shield accent and approver chip, plus "awaiting approval · 25m" when `needs_input`.
  **Milestone**: a compact flag pill.
- **Level of detail**: below 60% zoom, cards collapse to status and title. Below 35%, they are
  colored dots with titles on hover.
- States: running gets a soft pulsing glow; selected gets a focus ring; stale (no heartbeat for
  more than 2× the cadence) gets an amber clock badge; executor mismatch gets a subtle warning
  dot on the executor badge.

### 5.3 Interactions
Click selects (the inspector opens). Double-click focuses the node's neighborhood. Hover shows a
dependency trace. Press `/` to search nodes. Filter chips work by status, tag, kind, and
assignee model. There is a **critical path** toggle, a **focus mode** (dims everything outside
the selection's ancestors and descendants), a minimap, zoom controls, fit, and a keyboard map
(arrows move between neighbors, Enter opens, Esc closes). A **Table** toggle shows the same
nodes as an accessible, sortable table.

## 6. Visual system

Tokens are defined as CSS variables in `apps/web/src/styles/tokens.css`, with dark (default) and
light themes. The mockup's final values are recorded in [§6.6](#66-mockup-tokens). Use those.

### 6.1 Status palette (hue families)
| Status | Hue | Icon | Treatment |
|---|---|---|---|
| pending | zinc | hollow circle | muted |
| ready | sky | circle-dot / play | outline accent |
| running | violet | spinning ring | glow + pulse |
| evaluating | amber | scale | |
| needs_input | orange | hand / message-question | attention |
| blocked | red | octagon-alert | **outlined** |
| paused | slate | pause | |
| done | emerald | check-circle | |
| failed | rose | x-circle | **solid** |
| skipped | zinc | skip-forward | **diagonal stripes** |
| cancelled | dark zinc | ban | |

Attempt outcomes and aim verdicts reuse these families (met = emerald, unmet = rose, partial =
amber, waived = slate with a strike).

### 6.2 Typography and layout
Inter (variable) for UI and JetBrains Mono for keys, ids, code, and metrics, both self-hosted
through `@fontsource-variable` (OFL-1.1). Sizes: 12/13/14 px UI text, 16/18/20 px headings,
tabular numbers for metrics. 4 px spacing grid. Radii of 6 (controls), 10 (cards), and 14
(panels). Hairline borders. Sparing, soft elevation.

### 6.3 Execution annotation badges
`[Opus 5.5 ▮▮▮▮ ⌘]`: the friendly model name (from `/vocab`; unknown models show their raw id),
a **thinking meter** (0–5 bars for off/low/medium/high/xhigh/max), and a **mechanism icon**
(terminal = claude-code, cloud = claude-code-web, braces = agent-sdk, plug = mcp, user = ui,
gear = system). The tint comes from the provider family, using neutral generic tints (no brand
logos). The tooltip shows the full annotation including session and usage.

### 6.4 Motion
150–200 ms ease-out for UI transitions. A 2 s pulse cycle on running nodes. A dash-offset
animation on active loop edges. A 600 ms highlight fade on updated rows and cards. All of it
respects `prefers-reduced-motion`.

### 6.5 Accessibility
WCAG AA contrast in both themes, visible focus rings, full keyboard operation, ARIA labels on
canvas nodes ("implement-api, running, attempt 2 of 3, 64 percent"), the Table alternative to
the canvas, and color-blind-safe redundancy (icons and patterns).

### 6.6 Mockup tokens
*Filled in from the final mockup. See the mockup's `:root` and `[data-theme="light"]` blocks;
they are the source of truth until `tokens.css` exists.*

## 7. Feedback loop UX
- **Edits** to running nodes show a banner: "An agent is working on this node. Saving sends a
  change directive." After saving, a directive chip tracks delivery and acknowledgment live.
- **Directives** can be composed from the node inspector, the orchestrator inspector, or the
  graph header (graph-wide). The composer has a "requires acknowledgment" option.
- **Inbox actions** are optimistic, and roll back on error with a toast that explains the
  server's hint.
- **Destructive actions** (cancel graph, fail, skip) need a confirmation with a reason field.
  The reason is stored in the event.

## 8. Live updates
SSE event snapshots patch the Query cache directly. Changed cards and rows get a brief
highlight. Feeds show a "N new events" pill instead of auto-scrolling when the user has scrolled
away. Counters animate. Reconnection is automatic, with `Last-Event-ID` replay. On `resync`,
views refetch.

## 9. Performance
Lists are virtualized (`@tanstack/react-virtual`). The canvas uses level-of-detail rendering,
`onlyRenderVisibleElements`, memoized node components, and worker layout. Charts only render
when visible. Targets are in [architecture.md §10](architecture.md#10-performance-targets).

## 10. UI action → API
| Action | Call |
|---|---|
| Start / pause / resume / cancel / reopen graph | `POST /graphs/{g}/{action}` |
| Edit node config | `PATCH /graphs/{g}/nodes/{n}` (If-Match), which auto-creates a change directive |
| Send directive | `POST /graphs/{g}/directives` |
| Retry / skip / pause / reopen node | `POST /graphs/{g}/nodes/{n}/{action}` |
| Extend loop | `POST /graphs/{g}/loops/{key}/extend` |
| Waive aim | `POST /graphs/{g}/nodes/{n}/aims/{aim}/waive` |
| Approve / reject / answer / resolve | `POST /requests/{id}/resolve` |
| Create from spec | `POST /graphs/validate` (live), then `POST /graphs` |
| Apply YAML edits | `POST /graphs/{g}/mutations` |
| Live data | `GET /graphs/{g}/events/stream`, `GET /events/stream` |
