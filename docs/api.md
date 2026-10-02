# HTTP API (`/api/v1`)

The REST API is the single source of truth for every client: the web UI, the CLI, the MCP
server, the simulator, and third-party agents. It is implemented with Hono and
`@hono/zod-openapi`, so request and response schemas come from the same zod definitions as the
core package. The **OpenAPI 3.1** document is served at `GET /api/v1/openapi.json`, and a
reference UI at `/api/docs`.

Semantics are defined in [concepts.md](concepts.md). Agent usage patterns are in
[agent-protocol.md](agent-protocol.md).

## 1. Conventions

**Base URL.** `$AGENT_GRAPHS_URL/api/v1`. `AGENT_GRAPHS_URL` is the server **origin**, default
`http://localhost:4747`. Every client and tool uses it that way.

**Auth.** `Authorization: Bearer <token>`. Token roles:

| Role | Can |
|---|---|
| `admin` | Everything, including configuration edits, resolving requests, waivers, tokens, and deletes. Humans use this role through the UI. |
| `agent` | Read; create graphs; claim, heartbeat, note, report, submit, fail, block, and release; evaluate (subject to independence); attach orchestrators; create requests; ack directives. Orchestrator-only actions additionally need an attached orchestrator with the matching capability (see the matrix below). |
| `viewer` | Read-only, including SSE. |

**Permission matrix** for agent tokens. Admin can do everything.

| Action | Requires |
|---|---|
| Work on an attempt (heartbeat, notes, metrics, submit, fail, block, release) | Possession of the attempt id |
| Claim a node for yourself | The node's `executor.requires` ⊆ your declared `skills` |
| Claim on behalf (`dispatchedBy`) | An attached orchestrator with `dispatch` |
| Judge an aim (`agent` evaluator) | Any session other than the executor's |
| Judge an aim (`orchestrator` evaluator) | An attached orchestrator with `evaluate` whose scope covers the node |
| Structural mutations, `PATCH` node or graph config | An attached orchestrator with `mutate`, within the `mutations` policy |
| Pause, resume, skip, fail, or retry a node; extend a loop; waive an aim; resolve questions, blockers, and escalations | An attached orchestrator with `resolve` |
| Resolve approvals assigned to orchestrators (gates) | An attached orchestrator with `approve` |
| Lessons, proposals, evolution packet | Recording a lesson: any session holding a lesson duty, or `evolve`. Curation and proposals: `evolve`. |
| Reopen, complete manually, edit protected fields (aims, guards, policy, evolution settings), tokens | Admin only |

An orchestrator's capability is exercised by sending its session (`X-Agent-Session`) while it
holds the orchestrator lease.

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
  "details": [ … ], "docs": "/docs/agent-protocol.md#2-worker-loop" } }
```

| HTTP | `code` |
|---|---|
| 400 | `VALIDATION_FAILED` (`details` holds spec-style issues), `BAD_REQUEST` |
| 401 / 403 | `UNAUTHENTICATED`, `FORBIDDEN`, `POLICY_DENIED` (for example independence or mutation policy) |
| 404 | `NOT_FOUND` |
| 409 | `CONFLICT` (version), `INVALID_TRANSITION` (for example claiming a non-ready node), `ALREADY_CLAIMED`, `LEASE_EXPIRED`, `MAX_PARALLEL_REACHED`, `PROPOSAL_REJECTED_BEFORE` (an identical edit set was rejected for this target) |
| 410 | `ATTEMPT_CLOSED` (the attempt is no longer open; the body says why and what to do) |
| 422 | `AIM_EVIDENCE_MISSING`, `CHECKLIST_INCOMPLETE`, `PROOF_REQUIRED`, `IDEMPOTENCY_MISMATCH` |
| 429 | `RATE_LIMITED` (token mode only) |

Every agent-facing error includes a `hint` with the concrete next call. Error texts are written
for LLMs as much as for humans.

## 2. Endpoint reference

`A` = admin, `G` = agent, `V` = viewer (and above). `G(orch: x)` means an agent session holding
an orchestrator lease with capability `x`.

**Milestones.** Untagged endpoints ship in **M2**. Tagged ones ship later: **(M5)** for templates,
search, revisions, and attachments; **(E1)** for learn mode, which ships in M3; **(E2)** for
proposals, M5; **(E3)** for template versions and eval suites, M6.

### Graphs
| Method & path | Role | Purpose |
|---|---|---|
| `GET /graphs` | V | List with filters `status`, `tag`, `q`, `archived`, `stalled`, and `sort` (`activity | created | title | progress`). Returns GraphSummary rows. |
| `POST /graphs` | G | Create from a spec. `?start=true` starts it too (or requests plan approval). Returns the GraphView. |
| `POST /graphs/validate` | V | Validate a spec. Returns `{ normalized, errors, warnings, stats }`. |
| `GET /graphs/{graph}` | V | GraphView: nodes, edges, loops, orchestrators, aims, stats. |
| `PATCH /graphs/{graph}` | A·G(orch: mutate)\* | Update title, description, tags, repository, context, constraints, defaults, aims, policy, or `evolution`. \*Agents are limited by the mutation policy. Aims, policy, and `evolution` are protected (admin only). Setting `evolution.mode: off` is the kill switch. |
| `DELETE /graphs/{graph}` | A | Drafts only. Other graphs must be archived. |
| `POST /graphs/{graph}/start` · `pause` · `resume` · `cancel` · `reopen` · `archive` · `unarchive` | A·G\* | Lifecycle. An agent `start` under `requirePlanApproval` opens an approval request. |
| `POST /graphs/{graph}/clone` | G | New draft from this graph's current spec. |
| `GET /graphs/{graph}/spec?format=yaml|json` | V | Export the canonical spec. |
| `POST /graphs/{graph}/mutations` | G(orch: mutate)·A | Batch structural changes, validated as a whole and applied atomically: `addNodes`, `updateNodes`, `removeNodes`, `addEdges`, `updateEdges`, `removeEdges`, `addLoops`, `updateLoops`, `removeLoops`, `addOrchestrators`, `updateOrchestrators`, `removeOrchestrators`, and (admin only) `addGraphAims`, `updateGraphAims`, `removeGraphAims`. Bumps `revision`. The Spec tab's "Edit as YAML" is applied as a diff through this. |
| `GET /graphs/{graph}/sitrep?budget=&orchestrator=&format=` | V | Graph-wide situation report for orchestrators ([format](agent-protocol.md#4-briefings-and-sitreps)). |
| `POST /graphs/{graph}/next` | G | Pick the best item for the caller. Body `{ session?, actor?, role?: 'worker' \| 'reviewer', skills?, claim?: boolean, briefing?: { budget } }`. With `role: worker` (the default) it returns a ready node it can claim. With `role: reviewer` it returns a pending evaluation the caller is independent from. |
| `GET /graphs/{graph}/stats` | V | Counts, durations, cost and tokens by model, attempts per node, loop iterations, throughput. |
| `GET /graphs/{graph}/metrics?name=&node=` | V | Metric series. |
| `POST /graphs/{graph}/metrics` | G | Graph-level metric reports (for graph aims). |
| `GET /graphs/{graph}/events?after=&types=&entity=&limit=` | V | Event history (paginated by `seq`). |
| `GET /graphs/{graph}/events/stream` | V | SSE live stream (section 3). |
| `GET /graphs/{graph}/audit/export?format=jsonl` | V | Full audit bundle: spec, entities, and events with hashes. |
| `GET /graphs/{graph}/audit/verify` | V | Recompute the hash chain. Returns `{ ok, events, firstMismatch? }`. |
| `GET /graphs/{graph}/audit/gaps` | V | Done nodes without proof, nodes accepted with deviation, waived aims, manual completions, open high-severity findings. |
| `GET /graphs/{graph}/notes?type=` · `POST /graphs/{graph}/notes` | V · G | Graph-level notes (not tied to a node). |

### Nodes
| Method & path | Role | Purpose |
|---|---|---|
| `GET /graphs/{graph}/nodes?status=&tag=&kind=` | V | Node summaries. |
| `GET /graphs/{graph}/nodes/{node}` | V | NodeDetail. |
| `PATCH /graphs/{graph}/nodes/{node}` | A·G(orch: mutate)\* | Edit configuration (prompt, aims, executor, limits, priority, tags, …). Aims are protected (admin only). Emits `node.updated` with a diff, plus a `change` directive if an attempt is open. |
| `GET /graphs/{graph}/nodes/{node}/briefing?budget=&format=&protocol=` | V | Context packet for this node, as the next attempt would see it. A preview: it does not mark directives delivered or lessons applied. |
| `POST /graphs/{graph}/nodes/{node}/claim` | G | Body `{ actor \| session, clientSessionId?, skills?, dispatchedBy?, briefing?: { budget, format } }`. With `dispatchedBy`, it creates a child session for `actor`. Returns `{ attempt, lease, briefing?, directives }`. |
| `POST /graphs/{graph}/nodes/{node}/pause` · `resume` | A·G(orch: resolve) | Allowed source statuses per [concepts §3.4](concepts.md#34-actions-by-humans-and-orchestrators). |
| `POST /graphs/{graph}/nodes/{node}/skip` · `fail` | A·G(orch: resolve) | Body `{ reason }` (required). Cancels an open attempt. |
| `POST /graphs/{graph}/nodes/{node}/retry` | A·G(orch: resolve) | Grant `{ extraAttempts: n }` and return the node to ready (from `failed` or `needs_input`). |
| `POST /graphs/{graph}/nodes/{node}/reopen` | A | Done, skipped, or failed → pending in a new activation. **Cascades** to started descendants ([concepts §3.3](concepts.md#33-status)). |
| `POST /graphs/{graph}/nodes/{node}/complete-manually` | A | Record work done outside the system (by a human, or before the graph was tracked). Body `{ summary, evidence, notes?, evaluations? }`. Creates an attempt executed by the caller, plus evaluations; the node becomes `done`. Terminating aims without a verdict are recorded as `waived`, with the summary as justification. |
| `GET /graphs/{graph}/nodes/{node}/attempts` | V | |
| `GET /graphs/{graph}/nodes/{node}/notes?type=` · `POST …/notes` | V · G | Node-level notes not tied to an attempt (human comments, orchestrator notes). |
| `POST /graphs/{graph}/nodes/{node}/aims/{aim}/waive` | A·G(orch: resolve) | Body `{ justification }`. |

### Attempts (capability-scoped)
| Method & path | Purpose |
|---|---|
| `GET /attempts/{attempt}` | Attempt plus node summary and lease state. |
| `GET /attempts/{attempt}/briefing?budget=&format=` | The briefing for this attempt, as delivered or re-fetched. It marks directives delivered. |
| `POST /attempts/{attempt}/heartbeat` | Body `{ progress?, step?, checkpoint?, usage?, checklist? }`. `usage` is cumulative for the attempt. Returns `{ leaseExpiresAt, directives: [new], pauseRequested, cancelRequested, briefingChanged }`. |
| `GET /attempts/{attempt}/directives?status=` | Active directives for this attempt's node, graph, and session. |
| `POST /attempts/{attempt}/notes` | Add a note (the author defaults to the attempt executor). |
| `POST /attempts/{attempt}/metrics` | `{ metrics: { name: value } }` or `[{ name, value, unit? }]`. |
| `POST /attempts/{attempt}/checklist` | `{ items: { [key]: { done, evidence? } } }` |
| `POST /attempts/{attempt}/submit` | Body `{ summary, evaluations?: [{ aim, verdict, rationale, evidence? }], metrics?, notes?: [...], usage? }`. Returns `{ attempt, node, outcome: passed | failed | evaluating, next, lessonDuty? }`. `lessonDuty` appears when the attempt passes after earlier failures and `learn` mode is on; it asks the worker to record what made the difference (`POST /lessons`). |
| `POST /attempts/{attempt}/evaluations` | Judge a submitted attempt: `{ aim, verdict, rationale, evidence?, score? }`. For evaluators. |
| `POST /attempts/{attempt}/fail` | `{ reason, retryable?: true }` → `errored`. With `retryable: false` the node exhausts at once (its `onExhausted` applies). |
| `POST /attempts/{attempt}/block` | `{ reason, request: { title, body, options? } }` → `blocked`, plus a blocker request. |
| `POST /attempts/{attempt}/release` | `{ reason, handoff? }`. Voluntary release; not counted. |

### Edges, loops, aims
| Method & path | Role | Purpose |
|---|---|---|
| `POST /graphs/{graph}/edges` · `PATCH …/edges/{id}` · `DELETE …/edges/{id}` | A·G(orch: mutate) | Single edge operations, validated like mutations. `PATCH` sets `label`, `relation`, `condition`, `guidance`, and `pitfalls`. Edges are always addressed by id. |
| `GET /graphs/{graph}/loops` · `PATCH …/loops/{key}` | V · A·G(orch: mutate) | For example raising `maxIterations`. |
| `POST /graphs/{graph}/loops/{key}/extend` | A·G(orch: resolve) | `{ extraIterations, reason }`. If the loop is exhausted, it fires immediately. |
| `GET /graphs/{graph}/aims` | V | Graph and node aims with status. |
| `POST /graphs/{graph}/aims/{aim}/evaluations` | G(orch: evaluate)·A | Verdicts on graph-level qualitative aims during `verifying`. |
| `POST /graphs/{graph}/aims/{aim}/waive` | A·G(orch: resolve) | Waive a graph aim. Body `{ justification }`. |
| `GET /evaluations/pending?graph=` | G | Submitted attempts awaiting `agent`-evaluator verdicts, excluding those the caller's session executed. For judge subagents. |

### Orchestrators
| Method & path | Role | Purpose |
|---|---|---|
| `GET /graphs/{graph}/orchestrators` · `POST` · `PATCH …/{key}` | V · A·G\* | |
| `POST /graphs/{graph}/orchestrators/{key}/attach` | G | Body `{ actor | session }`. Takes the lease and returns `{ orchestrator, lease, briefing (role prompt + sitrep + queue) }`. Returns `409` if another session holds it. |
| `POST /graphs/{graph}/orchestrators/{key}/heartbeat` | G | Same response shape as an attempt heartbeat. |
| `GET /graphs/{graph}/orchestrators/{key}/queue` | V | The duty queue. |
| `POST /graphs/{graph}/orchestrators/{key}/notes` | G | Decisions, dispatch logs, … |
| `POST /graphs/{graph}/orchestrators/{key}/detach` | G | `{ handoff? }` |
| `POST /graphs/{graph}/orchestrators/{key}/pause` · `resume` · `stop` | A | Human control of an orchestrator role. |

### Sessions
| Method & path | Role | Purpose |
|---|---|---|
| `POST /sessions` | G | Register. Body is an annotation plus `skills?` and `meta?`. Returns `{ session }`. |
| `GET /sessions?status=&graph=` | V | |
| `PATCH /sessions/{id}` | G | For example the model changed mid-session. |
| `POST /sessions/{id}/heartbeat` · `POST /sessions/by-client/{clientSessionId}/heartbeat` | G | Renews every lease held by the session **and its descendant sessions** (dispatched subagents). The `by-client` form is used by hooks. Returns `{ attempts: [{ id, nodeKey, leaseExpiresAt, newDirectives, pauseRequested, cancelRequested }] }`, so a hook can surface new directives as additional context. |
| `POST /sessions/{id}/events` | G | Client lifecycle signals, for example `{ type: "compacted" }` from a PreCompact hook. |
| `POST /sessions/{id}/end` | G | |

### Requests (Inbox) and directives
| Method & path | Role | Purpose |
|---|---|---|
| `GET /requests?status=open&graph=&kind=&assignee=` | V | Cross-graph inbox. |
| `POST /graphs/{graph}/requests` | G | Raise a question or approval: `{ kind, title, body, node?, attempt?, options?, assignee?, blocking? }`. |
| `POST /requests/{id}/resolve` | A·G(orch: resolve/approve) | `{ choice, comment?, data? }`. Option ids and `data` per the [option catalog](concepts.md#111-requests). |
| `POST /requests/{id}/dismiss` | A | `{ reason }` |
| `GET /graphs/{graph}/directives?status=&target=` | V | |
| `POST /graphs/{graph}/directives` | A·G(orch: resolve) | `{ target: { type: graph \| node \| attempt \| orchestrator \| session, key \| id }, kind, title, body, requiresAck?, expiresAt?, supersedes? }` |
| `POST /directives/{id}/ack` | G | `{ note?, attemptId? }`. Acknowledges for one recipient. |

### Notes (cross-cutting)
| Method & path | Role | Purpose |
|---|---|---|
| `GET /notes?graph=&type=&severity=&model=&provider=&mechanism=&node=&q=&since=` | V | Cross-graph notes query for the Notes explorer. |
| `POST /notes/{id}/retract` | A·author | `{ reason }`. Additive retraction stamp. |
| `POST /notes/{id}/resolve` | A·G(orch: resolve) | Findings only. `{ comment }` posts a reply note and stamps `resolvedAt`. |

### Procedural knowledge and self-evolution (optional; [self-evolution.md](self-evolution.md))
| Method & path | Role | Purpose |
|---|---|---|
| `POST /graphs/{graph}/edges/{id}/attributes` (E1) | G | In `learn` mode, **append** `guidance` or `pitfalls`, with provenance. Any session holding a lesson duty, or with `evolve`, may do this. Replacing attributes uses `PATCH …/edges/{id}`. |
| `GET /lessons?graph=&template=&node=&status=&q=` (E1) | V | Search lessons. Briefings use the same ranking. |
| `POST /lessons` (E1) | G·A | Record a lesson: `{ scope, kind, condition?, content, evidence, dutyId? }`. With `dutyId`, it fulfils that lesson duty. |
| `POST /lessons/duties/{id}/dismiss` (E1) | G(orch: evolve)·A | `{ reason }` |
| `POST /lessons/{id}/merge` · `revise` · `retire` · `tag` (E1) | A·G(orch: evolve) | Incremental curation and helpful/harmful tagging. |
| `GET /graphs/{graph}/evolution` (E1) | V | Mode, scores, open lesson duties, proposals, rejection memory. |
| `GET /graphs/{graph}/evolution/packet?budget=` (E2) | G(orch: evolve) | The evolution packet: contrastive traces, graph, rejection memory, lessons, protected fields, edit DSL. |
| `POST /graphs/{graph}/evolution/proposals` (E2) | G(orch: evolve)·A | Submit a proposal `{ ops, rationale, evidence, expectedEffect }`. Duplicates of rejected proposals are refused (`409 PROPOSAL_REJECTED_BEFORE`). |
| `GET /evolution/proposals/{id}` · `POST …/validate` · `POST …/decide` · `POST …/revert` (E2) | V · G · A · A | Inspect; record a ladder stage result (from an independent session, or the runner or CI); approve or reject (humans); revert. |
| `GET /templates` · `POST /templates` · `POST /templates/{key}/instantiate` (M5) | V · A · G | Basic templates: reusable specs. |
| `GET /templates/{key}/versions` · `GET …/lineage` · `GET …/reliability` (E3) | V | Template versions, lineage tree, per-edge and per-node reliability. |
| `POST /templates/{key}/proposals` (E3) | G(orch: evolve)·A | Proposals against a template version (offline rounds, harvest). |
| `GET /eval-suites` · `POST /eval-runs` (E3) | V · G | Evaluation suites and run results (replay, A/B, test audits). |

### Meta
`GET /health` · `GET /api/v1/openapi.json` · `GET /api/v1/schema/graph-spec.json` ·
`GET /api/v1/vocab` (models, providers, mechanisms, thinking levels, and their display metadata) ·
`PUT /api/v1/vocab` (A; display overrides) ·
`GET /api/v1/me` (token role and identity) · `GET|POST /api/v1/tokens` · `DELETE /api/v1/tokens/{id}` (A; revoke) ·
`GET /api/v1/search?q=` (M5; FTS over notes, prompts, and titles) ·
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
  "next": "Aim 'layering' awaits orchestrator 'reviewer'. You may stop; do not claim this node again." }
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
