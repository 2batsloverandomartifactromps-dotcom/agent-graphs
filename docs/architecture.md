# Architecture

## 1. Runtime topology

```
   Agents (Claude Code, Agent SDK, other CLIs, CI)                   Humans
   ┌──────────────────────────┐   ┌──────────────┐               ┌──────────────┐
   │ MCP stdio (agraph mcp)   │   │ agraph CLI   │               │  Web UI      │
   │  └─ @agent-graphs/sdk    │   │ (+ hooks)    │               │  (React SPA) │
   └────────────┬─────────────┘   └──────┬───────┘               └──────┬───────┘
                │ HTTPS/JSON              │                     REST + SSE│
                ▼                         ▼                              ▼
   ┌────────────────────────────────────────────────────────────────────────────┐
   │ apps/server (single Node process)                                          │
   │  Hono routes (/api/v1, /mcp, static UI) → auth → zod validation            │
   │      → command services ──► @agent-graphs/core engine (pure transitions)   │
   │      → repositories (Drizzle) ──► SQLite (WAL)                             │
   │      → event log (hash chain) ──► event bus ──► SSE hub / webhooks (M5)    │
   │  background jobs: lease sweeper · guard & stall checks · purges            │
   └────────────────────────────────────────────────────────────────────────────┘
```

- **One process owns the database.** Writes are serialized through synchronous better-sqlite3
  transactions. That keeps every state transition atomic and makes the event order total.
- **The server is a ledger, not an executor.** Agents pull work. An optional runner (M6) is
  just another client of the API.
- **One schema source.** Zod schemas in `@agent-graphs/core` produce TypeScript types, request
  validation, the OpenAPI document, the JSON Schema for specs, MCP tool input schemas, and CLI
  argument validation.

## 2. Repository layout

```
agent-graphs/
├─ apps/
│  ├─ server/        @agent-graphs/server  Hono API, SSE, MCP-over-HTTP, jobs, serves the built UI
│  └─ web/           @agent-graphs/web     React SPA (Vite)
├─ packages/
│  ├─ core/          @agent-graphs/core    zod schemas · spec parse/normalize/validate · graph
│  │                                       algorithms · engine (pure transitions) · aim evaluation
│  │                                       · briefing/sitrep renderers · vocab · evolution (edit
│  │                                       DSL, gate, lesson ranking; optional)
│  ├─ sdk/           @agent-graphs/sdk     typed fetch client + SSE helper (browser & Node)
│  ├─ mcp/           @agent-graphs/mcp     MCP server: tools/prompts/resources over the sdk
│  ├─ cli/           agent-graphs          `agraph` bin: serve | mcp | hook | client commands (published)
│  └─ simulator/     @agent-graphs/simulator  fake agents, seed data, scenario runner
├─ integrations/claude-code/               skill, hooks wiring, settings + .mcp.json examples
├─ examples/graphs/                        example specs
├─ docs/                                   this plan
└─ scripts/                                repo tooling (license check, …)
```

**Dependency rules** (enforced by review, and later by lint):
`core` depends on nothing internal (only zod and yaml) and never does I/O.
`sdk` → `core`. `mcp` → `sdk`, `core`. `server` → `core`, and `mcp` for the HTTP transport.
`web` → `sdk`, `core` (types, vocab, validation for the spec editor). `cli` → everything it
bundles. `simulator` → `sdk`, `core`.

Workspace packages export TypeScript sources directly (`"exports": { ".": "./src/index.ts" }`).
Vite, Vitest, and tsx consume them without a build step. Publishable artifacts (the `agent-graphs`
CLI with the server, the MCP server, and the built UI) are bundled with **tsdown** at release time.

## 3. Server internals

### 3.1 Layers
| Layer | Responsibility |
|---|---|
| **Routes** (`src/routes/*`) | HTTP only: OpenAPI route definitions, auth, input/output schemas, ETag/If-Match, idempotency. No business logic. |
| **Commands** (`src/commands/*`) | One function per use case (`claimNode`, `submitAttempt`, `resolveRequest`, …). Opens a transaction, loads state, calls the engine, persists effects, appends events, and publishes after commit. |
| **Engine** (`@agent-graphs/core/engine`) | Pure functions: `(state, input, ctx) → { effects, events, result }`. `ctx` injects `now()` and `id()`, so it is deterministic and testable. Holds every rule from concepts.md. |
| **Repositories** (`src/db/*`) | Drizzle queries. Load a `GraphState` and apply `Effect[]`. Dialect specifics live here. |
| **Read models** (`src/read/*`) | GraphSummary, GraphView, NodeDetail, briefing and sitrep inputs. |
| **Event bus / SSE hub** (`src/events/*`) | In-process pub/sub after commit, fan-out to SSE subscribers, replay from the `events` table. |
| **Jobs** (`src/jobs/*`) | Timers (section 3.4). |

### 3.2 A command end to end (claim)
1. The route validates the body (zod), resolves the actor (token, session, or inline annotation),
   and checks the idempotency key.
2. `claimNode` runs `BEGIN IMMEDIATE`. It loads `GraphState` for the graph (graph, nodes, edges,
   loops, aims, open attempts). This is a single-digit number of queries; around 1000 nodes
   take a few ms.
3. `engine.claim(state, { nodeKey, actor, dispatchedBy }, ctx)` validates the transition (node
   ready, graph active, `maxParallel` respected, executor `requires` met) and returns effects
   (insert attempt, update node, upsert session) and events (`attempt.claimed`,
   `node.status_changed`).
4. The repository applies the effects. The event log appends events with the hash chain (it
   reads `chain_head` and writes the new head).
5. `COMMIT`. The bus publishes the events with entity snapshots, and SSE pushes them to
   subscribers.
6. The route builds the response, optionally rendering the briefing (pure, from the read model)
   and attaching pending directives (marked `delivered` in a follow-up micro-transaction).

If profiling later calls for it, `GraphState` can be cached per graph in memory. Every write goes
through this process, so write-through invalidation is trivial.

### 3.3 Engine shape
```ts
type EngineCtx = { now: () => number; id: (prefix: IdPrefix) => string; policy: ResolvedPolicy };
type EngineResult<R> = { effects: Effect[]; events: DomainEvent[]; result: R };
// e.g.
claim(state: GraphState, input: ClaimInput, ctx: EngineCtx): EngineResult<ClaimResult>
submit(state, input: SubmitInput, ctx): EngineResult<SubmitResult>
evaluate(state, input: EvaluateInput, ctx): EngineResult<EvaluateResult>
expireLeases(state, ctx): EngineResult<void>
fireLoop(state, loopKey, feedback, ctx)   // internal, called by finalize
recomputeReadiness(state, changedNodeIds, ctx)
```
All of concepts.md §15 (invariants) is asserted after every engine call in tests, using
property-based testing (fast-check) over random graphs and random action sequences.

### 3.4 Background jobs
| Job | Interval | Does |
|---|---|---|
| Lease sweeper | 30 s | Expires attempt and orchestrator leases (`engine.expireLeases`). Marks sessions `lost`. |
| Guards | 60 s, and on usage changes | Re-evaluates derived metrics and guard aims (cost, elapsed time). Pauses the graph and escalates on violation. |
| Stall and timeout check | 60 s | Raises and clears the stalled flag. Opens escalations for timeouts. |
| Purges | hourly | Expired idempotency keys and old SSE replay buffers. |

Jobs run inside the server process. They are idempotent, so a restart is safe.

### 3.5 Configuration (environment)
| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `4747` / `127.0.0.1` | Bind address. A non-loopback host requires `AUTH_MODE=token`. |
| `DATA_DIR` | `./data` | SQLite file, backups, and blobs. |
| `DATABASE_PATH` | `$DATA_DIR/agent-graphs.sqlite` | |
| `AUTH_MODE` | `local` | `local` or `token`. |
| `PUBLIC_URL` | `http://HOST:PORT` | Used for links in briefings and notifications. |
| `LOG_LEVEL` | `info` | pino level. |
| `CORS_ORIGINS` | none | Extra origins (the UI is same-origin by default). |
| `LEASE_SWEEP_INTERVAL` | `30s` | |

### 3.6 Self-evolution (optional)
[self-evolution.md](self-evolution.md) specifies the behavior. Its implementation follows the
same layering:
- **`@agent-graphs/core/evolution`** (pure): edit-DSL schemas, normalization, and canonical
  hashing; patching a spec with ops, then re-validating it; checks for protected fields; the gate
  decision (`candidate ≥ incumbent`, plus constraints and sample minimums); objective scoring;
  lesson ranking for briefings; detecting lesson duties after a pass that followed failures.
- **Server commands**: lessons (create, merge, retire, tag, apply), proposals (create, refuse
  duplicates, record validation stages, decide, commit as a graph revision or template version,
  revert), and building the evolution packet (contrastive traces sorted by score, budgeted).
- **Jobs**: post-commit regression monitoring with auto-revert, lesson-counter rollups, and test
  audits for `auto` mode.
- **No LLM calls in the server.** Extraction, proposing, and counterfactual judging are done by
  agents (worker, evolver, independent judge) through the API, which keeps D1 intact. Replay and
  A/B runs are executed by the runner (M6) or by CI, and reported back.

### 3.7 Observability
pino structured JSON logs with request ids and actor annotations. `GET /health` (liveness, plus
database check). M5 adds `GET /metrics` (Prometheus text: request latencies, open attempts,
SSE clients, events/s). OpenTelemetry is optional, later.

## 4. Web app internals

- **Routing**: TanStack Router (file-based, type-safe search params, so filters live in the URL
  and are shareable). **Server state**: TanStack Query. **UI state**: small zustand stores
  (theme, panel sizes, canvas preferences).
- **Live updates**: `useGraphStream(graphId)` subscribes to SSE and applies event `snapshot`s
  straight into the Query cache (`setQueryData`), falling back to invalidating on unknown
  events. The global stream drives the dashboard and the Inbox badge. Reconnects use
  `Last-Event-ID`.
- **Canvas**: React Flow (`@xyflow/react`) with custom node and edge components. Layout uses
  **dagre** (`@dagrejs/dagre`, MIT) in a **Web Worker**, run on the forward `requires`/`informs`
  DAG only. The layout is memoized by a **structure hash**, so status changes never move nodes.
  Loop back-edges are custom edges routed around the body's bounding box, and loop bodies are
  drawn as tinted hull regions behind their nodes. Manual positions (`node.position`) override
  the layout.
- **Rendering agent content**: `react-markdown` + `remark-gfm` + `rehype-sanitize`. Raw HTML is
  never rendered.
- **Design system**: Tailwind CSS v4 tokens (CSS variables for both themes) and hand-vendored
  shadcn-style components built on Radix primitives (`radix-ui`). The shadcn registry is not
  reachable from the build sandbox, so components are written in-repo under
  `apps/web/src/components/ui/`.
- **Spec editor**: CodeMirror 6 with YAML mode, live validation using `@agent-graphs/core` in
  the browser, and a live canvas preview.
- See [ui.md](ui.md) for screens and the visual system.

## 5. MCP and CLI internals

- `@agent-graphs/mcp` defines tools against an `AgentGraphsClient` interface (implemented by the
  sdk over HTTP). The **stdio** entry (`agraph mcp`) is what Claude Code spawns. The server
  mounts the same tools at `/mcp` (Streamable HTTP via `@hono/mcp`) using a loopback client.
- Tool input schemas reuse the core zod schemas. Results return concise markdown plus
  `structuredContent`.
- `agraph` uses commander. Client commands use the sdk. `serve` starts the server and serves the
  bundled UI. `hook` subcommands read the Claude Code hook JSON from stdin, must finish in under
  100 ms when throttled, and never throw (they fail open, except `stop` under the `block`
  policy).

## 6. Security

- Tokens are random 32-byte values shown once and stored as sha256 hashes with role scopes.
  `AUTH_MODE=token` is enforced for non-loopback binds.
- Inputs are validated by zod with size limits (note body ≤ 100 KB, checkpoint ≤ 64 KB, spec ≤
  1 MB, ≤ 2000 nodes per graph).
- XSS: all agent-written content is sanitized on render. API responses are JSON, and briefings
  are plain markdown.
- Prompt injection: briefings label other agents' content as data (agent-protocol §10).
- Audit integrity: append-only tables plus the per-graph hash chain, with a verify endpoint.
- CORS is same-origin by default. Rate limiting applies in token mode.
- Dependencies are permissive-licensed only, and checked in CI ([licensing.md](licensing.md)).

## 7. Testing strategy

| Layer | Tooling | What |
|---|---|---|
| Core unit | Vitest | Spec normalization and every validation rule; graph algorithms (cycles, bodies, laminarity, single exit, critical path); aim evaluation; table-driven state transitions; briefing and sitrep rendering (snapshots plus budget limits). |
| Core properties | Vitest + fast-check | concepts §15 invariants over random graphs and random action sequences. |
| Server integration | Vitest + `app.request()` + in-memory SQLite + fake clock | Every endpoint: auth, errors and hints, ETags, idempotency, SSE replay, hash chain. |
| Scenarios | `@agent-graphs/simulator` scenario runner (YAML scripts) | Multi-agent lifecycles: nested loops, gate rejection loops, lease expiry, escalations, directives and acks, guard pauses, plan approval, mutations under each policy. |
| MCP | MCP SDK client over an in-memory transport | Tool schemas, results, error hints. |
| E2E | Playwright (Chromium) against dev server + seed + simulator | Create from spec → live progress → approve gate → resolve escalation → edit prompt → directive acked. Screenshot checks of key screens. |
| Repo | Biome, `tsc` (TS 7), `scripts/check-licenses.mjs` | Lint, format, types, license policy. |

Coverage targets: core ≥ 90% lines, server ≥ 80%.

## 8. CI/CD

GitHub Actions (`.github/workflows/ci.yml`): `pnpm install --frozen-lockfile` → `pnpm lint` →
`pnpm typecheck` → `pnpm check:licenses` → `pnpm test` → `pnpm build`. The E2E job (with the
pre-installed Playwright Chromium) is added in M4. Releases (M5) tag, bundle with tsdown, publish
`agent-graphs` to npm, and build a Docker image.

## 9. Packaging and deployment

- **Local**: `pnpm dev` (server with watch + Vite with proxy) for development, and
  `npx agent-graphs serve` for users. Data goes to `./data`.
- **Docker** (M5): a single image with a volume at `/data` and `AUTH_MODE=token`.
- **Remote** (for cloud agent sessions): run behind a TLS reverse proxy. Agents use `agent`
  tokens and humans use the UI with `admin` tokens (OIDC in M6).

## 10. Performance targets

| Metric | Target |
|---|---|
| Claim, heartbeat, submit (server time, p95, graphs ≤ 1000 nodes) | < 20 ms |
| GraphView, 500 nodes | < 100 ms |
| Commit → SSE delivered | < 250 ms |
| Sustained writes | 200/s with 50 concurrent agents |
| Canvas: 500 nodes | 60 fps pan/zoom; layout < 300 ms in the worker |

## 11. Extension points

The built-in **runner** (M6; launches agents for ready nodes through the Claude Agent SDK or
headless Claude Code, with concurrency and budget limits), **webhooks** (M5), a **Postgres**
repository implementation, **OIDC** login, **"Ask this graph"** Q&A over the audit log (M6), and
templates (M5).

## 12. Tech stack

All versions were verified on npm on 2026-10-02. The license policy is in
[licensing.md](licensing.md).

| Area | Choice | Version | License |
|---|---|---|---|
| Runtime | Node.js | ≥ 22.12 (LTS) | MIT |
| Package manager | pnpm workspaces | 10.x | MIT |
| Language / typecheck | TypeScript (native `tsc`, TS 7) | 7.0 | Apache-2.0 |
| Dev runner | tsx | 4.x | MIT |
| Bundler (publish) | tsdown | 0.23 | MIT |
| Lint / format | Biome | 2.5 | MIT OR Apache-2.0 |
| Tests | Vitest · fast-check · Playwright | 5.0 · 4.x · 1.63 | MIT · MIT · Apache-2.0 |
| Schemas | zod | 4.x | MIT |
| HTTP | Hono · @hono/node-server · @hono/zod-openapi | 4.13 · 2.1 · 1.6 | MIT |
| DB | better-sqlite3 (SQLite: public domain) · Drizzle ORM · drizzle-kit | 13 · 0.45 · 0.31 | MIT · Apache-2.0 · MIT |
| IDs / YAML / logs | ulid · yaml · pino | 3 · 2.9 · 10 | MIT · ISC · MIT |
| MCP | @modelcontextprotocol/sdk · @hono/mcp | 1.31 · 0.3 | MIT |
| CLI | commander | 15 | MIT |
| UI framework | React · Vite · @vitejs/plugin-react | 19.3 · 8.3 · 6.1 | MIT |
| Routing / data | @tanstack/react-router · @tanstack/react-query · @tanstack/react-virtual | 1.170 · 5.104 · 3.x | MIT |
| Styling | Tailwind CSS · radix-ui · cva · clsx · tailwind-merge | 4.3 · 1.6 · 0.7 · 2 · 3 | MIT · MIT · Apache-2.0 · MIT · MIT |
| Graph canvas / layout | @xyflow/react · @dagrejs/dagre | 12.12 · 1.x | MIT · MIT |
| Charts | recharts | 3.10 | MIT |
| Markdown | react-markdown · remark-gfm · rehype-sanitize | 10 · 4 · 6 | MIT |
| Editor | CodeMirror 6 (@uiw/react-codemirror, @codemirror/lang-yaml) | 4.25 · 6.1 | MIT |
| UX bits | lucide-react · cmdk · sonner · motion · date-fns · zustand | 1.50 · 1.1 · 2.0 · 14 · 4.4 · 5.0 | ISC · MIT · MIT · MIT · MIT · MIT |
| Fonts | @fontsource-variable/inter · @fontsource-variable/jetbrains-mono | — | OFL-1.1 (fonts) |

**Rejected**: `elkjs` (EPL-2.0 OR GPL-3.0, which is not permissive; dagre replaces it).
**Build-time only**: `lightningcss` (MPL-2.0), pulled in by Vite 8 and Tailwind v4. It is
unmodified, not distributed, and allowed by policy (see [licensing.md](licensing.md)).
