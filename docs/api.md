# HTTP API (`/api/v1`)

The REST API is the single source of truth for every client: the web UI, the CLI, the MCP
server, the simulator, and third-party agents. It is implemented with Hono and
`@hono/zod-openapi`, so request and response schemas come from the same zod definitions as the
core package. The **OpenAPI 3.1** document is served at `GET /api/v1/openapi.json`, and a
reference UI at `/api/docs`.

Semantics are defined in [concepts.md](concepts.md). Agent usage patterns are in
[agent-protocol.md](agent-protocol.md).

## 1. Conventions

**Base URL.** `http://localhost:4747/api/v1` by default (`AGENT_GRAPHS_URL`).

**Auth.** `Authorization: Bearer <token>`. Token roles:

| Role | Can |
|---|---|
| `admin` | Everything, including configuration edits, resolving requests, waivers, tokens, and deletes. Humans use this role through the UI. |
| `agent` | Read; create graphs; claim, heartbeat, note, report, submit, fail, block, and release; evaluate (subject to independence); attach orchestrators; create requests; ack directives; mutate graphs as their policy allows. |
| `viewer` | Read-only, including SSE. |

Auth modes are set by `AUTH_MODE`. In `local` mode (the default when bound to `127.0.0.1`),
requests without a token are treated as `admin`, and agent tokens are optional. In `token` mode
(required for any other bind address), every request needs a token. The UI then asks for one,
with OIDC to follow in M6.

**Actor annotation.** Mutating requests may send `X-Agent-Session: se_…`, or put an inline
`actor` object in the body (an [execution annotation](concepts.md#92-execution-annotation)).
Attempt-scoped calls default to the attempt's executor annotation. In local mode, humans in the
UI send `X-Actor-Name`.

**IDs and keys.** `{graph}` is a graph id (`gr_…`) or slug. `{node}` is a node **key**.
`{attempt}` is an attempt id (`at_…`), which acts as a capability for attempt-scoped calls.

**Formats.** JSON request and response bodies. Timestamps are ISO-8601 UTC. Specs are accepted
as JSON objects or as YAML strings (`{ "format": "yaml", "spec": "…" }`). Briefings and sitreps
support `?format=md|json`.

**Views.** List endpoints return compact rows. Pass `?view=full` for complete objects and
`?include=notes,attempts,…` to embed relations.

**Pagination.** Cursor-based: `?limit=50&cursor=…` returns `{ items, nextCursor }`. The maximum
limit is 200.

**Concurrency.** Configuration resources return an `ETag: "<version>"`. A `PATCH` must send
`If-Match`, and a mismatch returns `409 CONFLICT` with the current resource in `details`.

**Idempotency.** Any `POST` can send `Idempotency-Key: <uuid>`. Repeats with the same key and
body within 24 h return the original response. The same key with a different body returns
`422 IDEMPOTENCY_MISMATCH`. Agents should always send one for claim, submit, and notes.

**Errors.**
```json
{ "error": { "code": "AIM_EVIDENCE_MISSING",
  "message": "Aim 'unit-tests' requires metric 'unit_test_pass_rate' before submit.",
  "hint": "Report it with POST /attempts/at_…/metrics {\"metrics\":{\"unit_test_pass_rate\":0.98}} or call /fail if you cannot measure it.",
  "details": [ … ], "docs": "/docs/agent-protocol.md#submitting" } }
```

| HTTP | `code` |
|---|---|
| 400 | `VALIDATION_FAILED` (`details` holds spec-style issues), `BAD_REQUEST` |
| 401 / 403 | `UNAUTHENTICATED`, `FORBIDDEN`, `POLICY_DENIED` (for example independence or mutation policy) |
| 404 | `NOT_FOUND` |
| 409 | `CONFLICT` (version), `INVALID_TRANSITION` (for example claiming a non-ready node), `ALREADY_CLAIMED`, `LEASE_EXPIRED`, `MAX_PARALLEL_REACHED` |
| 410 | `ATTEMPT_CLOSED` (the attempt is no longer open; the body says why and what to do) |
| 422 | `AIM_EVIDENCE_MISSING`, `CHECKLIST_INCOMPLETE`, `PROOF_REQUIRED`, `IDEMPOTENCY_MISMATCH` |
| 429 | `RATE_LIMITED` (token mode only) |

Every agent-facing error includes a `hint` with the concrete next call. Error texts are written
for LLMs as much as for humans.

## 2. Endpoint reference

`A` = admin, `G` = agent, `V` = viewer (and above).

### Graphs
| Method & path | Role | Purpose |
|---|---|---|
| `GET /graphs` | V | List with filters `status`, `tag`, `q`, `archived`, `stalled`, and `sort` (`activity | created | title | progress`). Returns GraphSummary rows. |
| `POST /graphs` | G | Create from a spec. `?start=true` starts it too (or requests plan approval). Returns the GraphView. |
| `POST /graphs/validate` | V | Validate a spec. Returns `{ normalized, errors, warnings, stats }`. |
| `GET /graphs/{graph}` | V | GraphView: nodes, edges, loops, orchestrators, aims, stats. |
| `PATCH /graphs/{graph}` | A·G\* | Update title, description, context, constraints, aims, policy, or tags. \*Agents are limited by the mutation policy. |
| `DELETE /graphs/{graph}` | A | Drafts only. Other graphs must be archived. |
| `POST /graphs/{graph}/start` · `pause` · `resume` · `cancel` · `reopen` · `archive` · `unarchive` | A·G\* | Lifecycle. An agent `start` under `requirePlanApproval` opens an approval request. |
| `POST /graphs/{graph}/clone` | G | New draft from this graph's current spec. |
| `GET /graphs/{graph}/spec?format=yaml|json` | V | Export the canonical spec. |
| `POST /graphs/{graph}/mutations` | G·A | Batch structural changes (`addNodes`, `updateNodes`, `removeNodes`, `addEdges`, `removeEdges`, `addLoops`, `updateLoops`) validated as a whole and applied atomically. Bumps `revision`. |
| `GET /graphs/{graph}/sitrep?budget=&orchestrator=&format=` | V | Graph-wide situation report for orchestrators ([format](agent-protocol.md#4-briefings-and-sitreps)). |
| `POST /graphs/{graph}/next` | G | Pick the best ready node for the caller. Body `{ session?, actor?, role?, capabilities?, claim?: boolean, briefing?: { budget } }`. |
| `GET /graphs/{graph}/stats` | V | Counts, durations, cost and tokens by model, attempts per node, loop iterations, throughput. |
| `GET /graphs/{graph}/metrics?name=&node=` | V | Metric series. |
| `POST /graphs/{graph}/metrics` | G | Graph-level metric reports (for graph aims). |
| `GET /graphs/{graph}/events?after=&types=&entity=&limit=` | V | Event history (paginated by `seq`). |
| `GET /graphs/{graph}/events/stream` | V | SSE live stream (section 3). |
| `GET /graphs/{graph}/audit/export?format=jsonl` | V | Full audit bundle: spec, entities, and events with hashes. |
| `GET /graphs/{graph}/audit/verify` | V | Recompute the hash chain. Returns `{ ok, events, firstMismatch? }`. |
| `GET /graphs/{graph}/audit/gaps` | V | Done nodes without proof, waivers without justification, submissions without summaries, … |

### Nodes
| Method & path | Role | Purpose |
|---|---|---|
| `GET /graphs/{graph}/nodes?status=&tag=&kind=` | V | Node summaries. |
| `GET /graphs/{graph}/nodes/{node}` | V | NodeDetail. |
| `PATCH /graphs/{graph}/nodes/{node}` | A·G\* | Edit configuration (prompt, aims, executor, limits, priority, tags, …). Emits `node.updated` with a diff, plus a `change` directive if an attempt is open. |
| `GET /graphs/{graph}/nodes/{node}/briefing?budget=&format=&protocol=` | V | Context packet for this node, as the next attempt would see it. |
| `POST /graphs/{graph}/nodes/{node}/claim` | G | Body `{ actor | session, clientSessionId?, dispatchedBy?, briefing?: { budget, format } }`. Returns `{ attempt, lease, briefing?, directives }`. |
| `POST /graphs/{graph}/nodes/{node}/pause` · `resume` | A·G(orch) | |
| `POST /graphs/{graph}/nodes/{node}/skip` | A·G(orch) | Body `{ reason }` (required). |
| `POST /graphs/{graph}/nodes/{node}/retry` | A·G(orch: resolve) | Grant `{ extraAttempts: n }` and return the node to ready (from `failed` or `needs_input`). |
| `POST /graphs/{graph}/nodes/{node}/reopen` | A | Done → pending in a new activation. |
| `POST /graphs/{graph}/nodes/{node}/complete-manually` | A | Record work done outside the system (by a human, or before the graph was tracked). Body `{ summary, evidence, notes?, evaluations? }`. Creates an attempt executed by the caller, plus evaluations; the node becomes `done`. Terminating aims without a verdict are recorded as `waived`, with the summary as justification. |
| `GET /graphs/{graph}/nodes/{node}/attempts` | V | |
| `GET /graphs/{graph}/nodes/{node}/notes?type=` · `POST …/notes` | V · G | Node-level notes not tied to an attempt (human comments, orchestrator notes). |
| `POST /graphs/{graph}/nodes/{node}/aims/{aim}/waive` | A·G(orch: resolve) | Body `{ justification }`. |

### Attempts (capability-scoped)
| Method & path | Purpose |
|---|---|
| `GET /attempts/{attempt}` | Attempt plus node summary and lease state. |
| `POST /attempts/{attempt}/heartbeat` | Body `{ progress?, step?, checkpoint?, usage?, checklist? }`. Returns `{ leaseExpiresAt, directives: [new], pauseRequested, cancelRequested, briefingChanged }`. |
| `GET /attempts/{attempt}/directives?status=` | Active directives for this attempt's node, graph, and session. |
| `POST /attempts/{attempt}/notes` | Add a note (the author defaults to the attempt executor). |
| `POST /attempts/{attempt}/metrics` | `{ metrics: { name: value } }` or `[{ name, value, unit? }]`. |
| `POST /attempts/{attempt}/checklist` | `{ items: { [key]: { done, evidence? } } }` |
| `POST /attempts/{attempt}/submit` | Body `{ summary, evaluations?: [{ aim, verdict, rationale, evidence? }], metrics?, notes?: [...], usage? }`. Returns `{ attempt, node, outcome: passed | failed | evaluating, next, lessonDuty? }`. `lessonDuty` appears when the attempt passes after earlier failures and `learn` mode is on; it asks the worker to record what made the difference (`POST /lessons`). |
| `POST /attempts/{attempt}/evaluations` | Judge a submitted attempt: `{ aim, verdict, rationale, evidence?, score? }`. For evaluators. |
| `POST /attempts/{attempt}/fail` | `{ reason, retryable?: true }` → `errored`. |
| `POST /attempts/{attempt}/block` | `{ reason, request: { title, body, options? } }` → `blocked`, plus a blocker request. |
| `POST /attempts/{attempt}/release` | `{ reason, handoff? }`. Voluntary release; not counted. |

### Edges, loops, aims
| Method & path | Role | Purpose |
|---|---|---|
| `POST /graphs/{graph}/edges` · `DELETE /graphs/{graph}/edges/{id}` | A·G\* | Single edge operations (validated like mutations). |
| `GET /graphs/{graph}/loops` · `PATCH …/loops/{key}` | V · A·G\* | For example raising `maxIterations`. |
| `POST /graphs/{graph}/loops/{key}/extend` | A·G(orch: resolve) | `{ extraIterations, reason }`. |
| `GET /graphs/{graph}/aims` | V | Graph and node aims with status. |
| `POST /graphs/{graph}/aims/{aim}/evaluations` | G·A | Verdicts on graph-level qualitative aims during `verifying`. |

### Orchestrators
| Method & path | Role | Purpose |
|---|---|---|
| `GET /graphs/{graph}/orchestrators` · `POST` · `PATCH …/{key}` | V · A·G\* | |
| `POST /graphs/{graph}/orchestrators/{key}/attach` | G | Body `{ actor | session }`. Takes the lease and returns `{ orchestrator, lease, briefing (role prompt + sitrep + queue) }`. Returns `409` if another session holds it. |
| `POST /graphs/{graph}/orchestrators/{key}/heartbeat` | G | Same response shape as an attempt heartbeat. |
| `GET /graphs/{graph}/orchestrators/{key}/queue` | V | The duty queue. |
| `POST /graphs/{graph}/orchestrators/{key}/notes` | G | Decisions, dispatch logs, … |
| `POST /graphs/{graph}/orchestrators/{key}/detach` | G | `{ handoff? }` |

### Sessions
| Method & path | Role | Purpose |
|---|---|---|
| `POST /sessions` | G | Register. Body is an annotation plus `capabilities?` and `meta?`. Returns `{ session }`. |
| `GET /sessions?status=&graph=` | V | |
| `PATCH /sessions/{id}` | G | For example the model changed mid-session. |
| `POST /sessions/{id}/heartbeat` · `POST /sessions/by-client/{clientSessionId}/heartbeat` | G | Renews every lease the session holds. The `by-client` form is used by hooks. |
| `POST /sessions/{id}/events` | G | Client lifecycle signals, for example `{ type: "compacted" }` from a PreCompact hook. |
| `POST /sessions/{id}/end` | G | |

### Requests (Inbox) and directives
| Method & path | Role | Purpose |
|---|---|---|
| `GET /requests?status=open&graph=&kind=&assignee=` | V | Cross-graph inbox. |
| `POST /graphs/{graph}/requests` | G | Raise a question or approval: `{ kind, title, body, node?, attempt?, options?, assignee?, blocking? }`. |
| `POST /requests/{id}/resolve` | A·G(orch: resolve/approve) | `{ choice, comment?, data? }` |
| `POST /requests/{id}/dismiss` | A | `{ reason }` |
| `GET /graphs/{graph}/directives?status=&target=` | V | |
| `POST /graphs/{graph}/directives` | A·G(orch) | `{ target: { type, key | id }, kind, title, body, requiresAck? }` |
| `POST /directives/{id}/ack` | G | `{ note? }` |

### Procedural knowledge and self-evolution (optional; [self-evolution.md](self-evolution.md))
| Method & path | Role | Purpose |
|---|---|---|
| `PATCH /graphs/{graph}/edges/{from}/{to}` | A·G\* | Set or append edge `relation`, `condition`, `guidance`, `pitfalls`, with provenance. In `learn` mode, agents may append guidance and pitfalls. |
| `GET /lessons?graph=&template=&node=&status=&q=` | V | Search lessons. Briefings use the same ranking. |
| `POST /lessons` | G·A | Record a lesson: `{ scope, kind, condition?, content, evidence }`. Fulfils a lesson duty when `dutyId` is given. |
| `POST /lessons/{id}/merge` · `revise` · `retire` · `tag` | A·G(evolve) | Incremental curation and helpful/harmful tagging. |
| `GET /graphs/{graph}/evolution` | V | Mode, scores, open duties, proposals, rejection memory. |
| `GET /graphs/{graph}/evolution/packet?budget=` | G(evolve) | The evolution packet: contrastive traces, graph, rejection memory, lessons, protected fields, edit DSL. |
| `POST /graphs/{graph}/evolution/proposals` | G(evolve)·A | Submit a proposal `{ ops, rationale, evidence, expectedEffect }`. Duplicates of rejected proposals are refused (`409 PROPOSAL_REJECTED_BEFORE`). |
| `GET /evolution/proposals/{id}` · `POST …/validate` · `POST …/decide` · `POST …/revert` | V · G(evolve) · A · A | Inspect, run or record ladder stages, approve or reject (humans), revert. |
| `GET /templates` · `GET /templates/{key}/versions` · `GET …/lineage` · `GET …/reliability` | V | Templates (E3): versions, lineage tree, per-edge and per-node reliability. |
| `POST /templates/{key}/proposals` | G(evolve)·A | Proposals against a template version (offline rounds, harvest). |
| `GET /eval-suites` · `POST /eval-runs` | V · G | Evaluation suites and run results (replay, A/B, test audits). |

### Meta
`GET /health` · `GET /api/v1/openapi.json` · `GET /api/v1/schema/graph-spec.json` ·
`GET /api/v1/vocab` (models, providers, mechanisms, thinking levels, and their display metadata) ·
`GET /api/v1/me` (token role and identity) · `GET|POST /api/v1/tokens` (A) ·
`GET /api/v1/search?q=` (FTS over notes, prompts, and titles) ·
`GET /api/v1/events/stream?graphs=` (global SSE for dashboards) ·
`POST|GET|DELETE /mcp` (MCP Streamable HTTP transport; see the agent protocol).

## 3. Server-Sent Events

- `GET /graphs/{graph}/events/stream` and `GET /events/stream?graphs=a,b` (or all graphs).
- Each message is `id: <seq>`, `event: <type>`, `data: <json>`. The data is
  `{ seq, type, graphId, entity, actor, payload, snapshot }`, where `snapshot` is a compact view
  of the changed entity (node summary, attempt summary, request, …).
- Reconnecting with `Last-Event-ID` replays the missed events (up to 10k, then
  `event: resync`, which tells the client to refetch).
- A heartbeat comment (`: ping`) is sent every 15 s. Responses use
  `Cache-Control: no-cache` and `X-Accel-Buffering: no`.

## 4. Key payloads

### Claim
```http
POST /api/v1/graphs/notes-mvp/nodes/implement-api/claim
Idempotency-Key: 7f9c…
{ "actor": { "kind": "agent", "agent": "backend-dev", "model": "claude-opus-5-5", "thinking": "high",
             "provider": "anthropic", "mechanism": "claude-code", "clientSessionId": "c0ffee…" },
  "briefing": { "budget": 6000, "format": "md" } }
```
```json
{ "attempt": { "id": "at_01J…", "number": 2, "activation": 2, "status": "running" },
  "lease": { "expiresAt": "2026-10-02T18:40:00Z", "ttlSeconds": 1800, "heartbeatEvery": 300 },
  "directives": [ { "id": "dr_…", "kind": "guidance", "title": "Use argon2id", "requiresAck": true } ],
  "briefing": "# Briefing: implement-api (attempt 2 · loop api-fix-cycle 2/4)\n…" }
```

### Heartbeat
```json
// request
{ "progress": 60, "step": "Fixing refresh-token rotation",
  "checkpoint": { "done": ["middleware"], "next": ["rotation", "tests"] },
  "usage": { "inputTokens": 182000, "outputTokens": 9400, "costUsd": 1.92 } }
// response
{ "leaseExpiresAt": "…", "pauseRequested": false, "cancelRequested": false, "briefingChanged": true,
  "directives": [ { "id": "dr_…", "kind": "change", "title": "Prompt updated by a human",
                    "body": "Prompt: added requirement to keep /v1 routes backwards compatible." } ] }
```

### Submit
```json
{ "summary": "Rewrote auth middleware; added refresh-token rotation; all unit tests pass locally.",
  "metrics": { "unit_test_pass_rate": 1.0 },
  "evaluations": [
    { "aim": "handles-errors", "verdict": "met",
      "rationale": "All handlers return the error envelope; see tests in errors.spec.ts",
      "evidence": [ { "kind": "file", "value": "src/api/errors.spec.ts" } ] } ],
  "notes": [
    { "type": "deliverable", "title": "Auth middleware + rotation",
      "evidence": [ { "kind": "commit", "value": "3f9a2c1" }, { "kind": "pr", "value": "https://github.com/acme/notes/pull/42" } ] },
    { "type": "proof", "title": "Unit tests 50/50",
      "evidence": [ { "kind": "command", "value": "pnpm test api --project unit", "meta": { "exitCode": 0, "output": "50 passed" } } ] } ] }
```
```json
{ "outcome": "evaluating",
  "attempt": { "id": "at_…", "status": "submitted" },
  "node": { "key": "implement-api", "status": "evaluating" },
  "next": "Aim 'readable' awaits orchestrator 'reviewer'. You may stop; do not claim this node again." }
```

### Next
```json
// POST /graphs/notes-mvp/next  { "actor": {…}, "capabilities": ["repo-write"], "claim": true }
{ "node": { "key": "docs", "title": "Write user docs", "priority": "p2", "reason": "highest priority ready node; unblocks mvp-ready" },
  "attempt": { "id": "at_…" }, "briefing": "…" }
// or, when nothing is ready:
{ "node": null, "reason": "no_ready_nodes",
  "running": [ { "key": "implement-api", "holder": "Opus 5.5 · claude-code", "progress": 60 } ],
  "needsInput": [ "design-review" ], "blocked": [ "security-audit" ],
  "suggestion": "Wait for running nodes or resolve inbox items; poll again in ~5 minutes." }
```
