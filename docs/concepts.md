# Concepts & semantics

This is the **normative** definition of the Agent Graphs domain. The data model, API, UI, and
agent protocol must agree with it. When they disagree, this document wins and the others get fixed.

- [1. Glossary](#1-glossary)
- [2. Graph](#2-graph)
- [3. Nodes](#3-nodes)
- [4. Attempts](#4-attempts)
- [5. Edges](#5-edges)
- [6. Aims](#6-aims)
- [7. Iteration: retries and loops (failure-cycles)](#7-iteration-retries-and-loops-failure-cycles)
- [8. Orchestrators](#8-orchestrators)
- [9. Notes and execution annotations](#9-notes-and-execution-annotations)
- [10. Sessions, identity, and leases](#10-sessions-identity-and-leases)
- [11. Human-in-the-loop: requests and directives](#11-human-in-the-loop-requests-and-directives)
- [12. Context resilience](#12-context-resilience)
- [13. Events and audit](#13-events-and-audit)
- [14. Policies](#14-policies)
- [15. Invariants](#15-invariants)
- [16. Self-evolution (optional)](#16-self-evolution-optional)

---

## 1. Glossary

| Concept | One-liner |
|---|---|
| **Graph** | A plan for a body of work (for example "build the MVP") plus the live record of its execution. |
| **Node** | A unit of work (`task`), a decision checkpoint (`gate`), or a zero-work marker (`milestone`). |
| **Edge** | A dependency between nodes: `requires` (blocking) or `informs` (context only). Edges can carry procedural knowledge: `condition`, `guidance`, `pitfalls`. |
| **Aim** | A terminating condition. Either **qualitative** (judged) or **quantitative** (measured against a target). |
| **Attempt** | One execution of a node by one agent. Nodes iterate by making more attempts. |
| **Loop** | A bounded **failure-cycle**. When a trigger node fails its aims, a body of nodes is re-run, with feedback. |
| **Orchestrator** | A supervisory agent role that spans the whole graph, outside the task DAG. |
| **Note** | An annotated record attached to a node, orchestrator, or graph: proof, deliverable, finding, decision, handoff… |
| **Execution annotation** | Who and what produced something: agent, role, model, thinking level, provider, delivery mechanism, usage. |
| **Session** | A registered agent or human process. Sessions hold leases on attempts and orchestrator roles. |
| **Request** | An item that needs a human or orchestrator decision. Requests make up the **Inbox**. |
| **Directive** | Guidance or a change sent *to* agents. It is delivered, then acknowledged. |
| **Event** | An append-only, hash-chained audit record of every change. |
| **Briefing / Sitrep** | A token-budgeted context packet for one node (briefing) or for the whole graph (sitrep). |
| **Lesson** | Itemized procedural knowledge learned from experience (usually a failed→passed contrast), retrieved into briefings. *(Optional; see §16.)* |
| **Proposal** | A gated, audited edit to a graph or template, made by the `evolver` role. *(Optional; see §16.)* |

The server is a **coordination ledger and state machine**. It never runs agents itself. Agents pull
work, do it wherever they run (Claude Code, an SDK agent, another provider's CLI, or a human),
and report back. An optional built-in runner is a later milestone (see [PLAN](PLAN.md#7-roadmap)).

---

## 2. Graph

A graph holds: `title`, optional `slug`, `description`, `tags`, optional `repository`
(`url`, `branch`, `path`), shared `context` (markdown) and `constraints` (hard rules) that
appear in every briefing, **overall aims**, `policy` (section 14), `defaults` for nodes,
orchestrators, nodes, edges, and loops.

### 2.1 Status

| Status | Meaning |
|---|---|
| `draft` | An editable plan. Nothing can be claimed. |
| `active` | Executing. Ready nodes can be claimed. |
| `paused` | No new claims. Running attempts receive a `pause` directive but may still submit. |
| `verifying` | Every node is `done` or `skipped`. The graph's own aims are being evaluated. |
| `completed` | All terminating graph aims are met, waived, or accepted. |
| `failed` | Declared failed by a human or orchestrator decision, or by policy. |
| `cancelled` | Stopped by a human. Open attempts are cancelled. |

Archiving is orthogonal (`archivedAt`). Any graph that is not `active` or `verifying` can be
archived, and archived graphs are hidden from default lists.

```mermaid
stateDiagram-v2
    [*] --> draft
    draft --> active: start (or plan approved)
    active --> paused: pause
    paused --> active: resume
    active --> verifying: all nodes done/skipped (auto)
    verifying --> completed: terminating graph aims met / waived / accepted
    verifying --> active: graph aims unmet → "add work"
    verifying --> failed: escalation resolved as fail
    active --> failed: escalation resolved as fail / policy
    paused --> failed: escalation resolved as fail
    active --> cancelled: cancel
    paused --> cancelled: cancel
    verifying --> cancelled: cancel
    completed --> active: reopen (new nodes added)
    failed --> active: reopen
```

**Stalled** is a derived condition, not a status. An `active` graph is stalled when no node is
`ready`, `running`, or `evaluating` and at least one node is `needs_input`, `blocked`, or
`failed`. Stalled graphs get a badge, and the server opens an `escalation` request when a
terminally `failed` node blocks progress.

### 2.2 Plan approval

When `policy.requirePlanApproval` is true, a `start` from an agent creates an `approval` request
(the plan review) instead of starting the graph. A human can inspect and edit the graph in the UI,
then approve. Approval starts the graph. The graph stays `draft` with `pendingApproval = true`
until then.

---

## 3. Nodes

### 3.1 Kinds

| Kind | Does work? | Requirements | Completes when |
|---|---|---|---|
| `task` | Yes, by an agent | `prompt` and ≥1 **terminating** aim | Its terminating aims are satisfied (per `aimMode`). |
| `gate` | No, it is a decision | `gate.approver` (`human` or `orchestrator`) | The approver approves. Rejection fails it, and fires its loop if it triggers one. |
| `milestone` | No | none | All prerequisites are done (and its own aims, if any, are met). It completes automatically. |
| `group` *(M5)* | No, it is a container | ≥1 child | All children are done or skipped (and its own aims, if any, are met). |

### 3.2 Fields

| Field | Purpose |
|---|---|
| `key` | Stable, human-readable id, unique within the graph (`^[a-z0-9][a-z0-9-]{0,63}$`). Agents address nodes by key. |
| `title` | Short name. |
| `aim` | One-sentence **outcome** statement: what will be true when this node is done. |
| `purpose` | **Why** the node exists: how it serves the graph's aims. |
| `prompt` | **Instructions** for the executing agent (markdown). Required for tasks. |
| `context` | Extra node-specific background (markdown). |
| `deliverables` | Expected outputs (files, PRs, deployments, docs), as strings or `{name, description, required}`. |
| `checklist` | Optional procedural steps (`{key, title, required}`). Required items must be ticked, with evidence, before submit. |
| `aims` | Acceptance criteria (section 6). |
| `aimMode` | `all` (default) or `any`: how terminating aims combine. |
| `needs` / `informedBy` | Authoring sugar for `requires` and `informs` edges. |
| `priority` | `p0` (highest) to `p3`. Default `p2`. |
| `tags` | Free-form labels. Used for orchestrator scope, filters, and capability routing. |
| `executor` | **Recommendations** for who should run it: `role`, `model`, `thinking`, `provider`, `mechanism`, `instructions`. Also `requires`, a list of capabilities used as a **hard** filter by `next`. |
| `maxAttempts` | Self-iteration bound per activation (section 7.1). Default comes from policy (3). |
| `onExhausted` | `escalate` (default), `fail`, `skip`, or `accept`. |
| `leaseTtl`, `timeout` | Lease length override; soft maximum duration per attempt (exceeding it opens an escalation). |
| `metadata` | Free-form JSON for integrations. |

Runtime fields include `status`, `statusReason`, `activation` (incremented every time a loop
resets the node), `currentAttemptId`, `acceptedWithDeviation`, and timestamps.

### 3.3 Status

| Status | Meaning | Claimable | Terminal |
|---|---|---|---|
| `pending` | Waiting on prerequisites. | no | no |
| `ready` | Prerequisites satisfied; waiting for an agent. | **yes** (tasks) | no |
| `running` | An attempt holds a lease. | no | no |
| `evaluating` | Work submitted. Waiting on a judge (agent, orchestrator, or human) for some terminating aim. | no | no |
| `needs_input` | A decision is needed: a gate awaiting approval, or an escalation after exhaustion. | no | no |
| `blocked` | An agent reported an external blocker. A blocking request is open. | no | no |
| `paused` | Paused by a human or orchestrator. | no | no |
| `done` | Terminating aims satisfied, or accepted via escalation (`acceptedWithDeviation`). | — | yes (success) |
| `skipped` | Intentionally not executed, with a reason. Dependents may proceed. | — | yes (success) |
| `failed` | Exhausted or declared failed. | — | yes (failure) |
| `cancelled` | Its graph was cancelled. | — | yes (failure) |

```mermaid
stateDiagram-v2
    [*] --> pending
    pending --> ready: prerequisites satisfied
    ready --> running: claim (new attempt)
    running --> evaluating: submit (external judge needed)
    running --> done: submit (aims satisfied)
    evaluating --> done: verdicts satisfy aims
    running --> ready: aims unmet / errored / abandoned (retries left)
    evaluating --> ready: aims unmet (retries left)
    running --> blocked: blocker reported
    blocked --> ready: request resolved (unblock)
    running --> needs_input: exhausted (escalate)
    evaluating --> needs_input: exhausted (escalate)
    ready --> needs_input: gate becomes ready
    needs_input --> ready: retry granted
    needs_input --> done: approved / accepted
    needs_input --> skipped: skip
    needs_input --> failed: fail
    done --> pending: loop reset / reopen
    failed --> ready: retry granted
    pending --> paused
    ready --> paused
    running --> paused
    paused --> pending: resume (recompute)
    running --> failed: exhausted (fail policy)
    evaluating --> failed: exhausted (fail policy)
```

Notes:
- **Readiness.** A `pending` node becomes `ready` when the graph is `active`, the node is not
  paused, and every `requires` predecessor is `done`, or `skipped` when
  `policy.skippedSatisfiesDeps` is true (the default). Readiness is recomputed for successors
  after every status change.
- **Gates.** When a gate becomes ready it moves straight to `needs_input` and opens an
  `approval` request for its approver.
- **Milestones.** When a milestone becomes ready, its aims are evaluated immediately (they are
  usually derived metrics, or there are none) and it moves to `done`.
- **Pausing a running node.** The node shows `paused` at once. Its attempt receives a `pause`
  directive and should checkpoint, then release (that release is not counted). A submission
  that arrives while paused is still accepted. On resume, the node goes back to `pending` and
  readiness is recomputed.
- **Skipping** requires a reason and is recorded as an event and a `decision` note.
- **Reopening a done node** (human action) increments its `activation` and resets it to `pending`.
- **Manual completion** (admin action) records work done outside the system, for example by a
  human or before the graph was tracked. It creates an attempt executed by the caller, with
  evaluations and evidence. Terminating aims without a verdict are recorded as `waived`, with the
  summary as justification. The node becomes `done`, and the audit view marks it as manual.

---

## 4. Attempts

An attempt is one agent's execution of one node. It is created by **claim**. It records
`number` (per node, monotonic), `activation` (the node's activation when claimed), the
execution annotation of the claimer, optional `dispatchedBy` (the orchestrator that claimed on
someone's behalf), the lease (`leaseExpiresAt`, `lastHeartbeatAt`), progress (`progress` 0–100,
`currentStep`, `checkpoint` JSON), the `feedbackIn` snapshot (exactly what feedback the agent
was given at start), `summary` (required on submit), `outcomeReason`, `usage` (tokens, cost),
and timestamps.

| Attempt status | Meaning | Counts toward `maxAttempts`? |
|---|---|---|
| `running` | Lease held; work in progress. | — |
| `submitted` | Work submitted; awaiting external evaluation. | — |
| `passed` | Terminating aims satisfied. | — |
| `failed` | Evaluated; terminating aims unmet. | **yes**, unless the node triggers a loop that fires instead |
| `errored` | The agent reported an execution error. | **yes** |
| `abandoned` | The lease expired (counted) or the agent released voluntarily (not counted). | expired: **yes**; released: no |
| `blocked` | The agent stopped on an external blocker. | no |
| `superseded` | Its result was invalidated because an enclosing loop reset the node. | no |
| `cancelled` | The graph or node was cancelled while it was open. | no |

At most one attempt per node is `running` or `submitted` at any time.

---

## 5. Edges

- **`requires`** (from `needs`): the target cannot start until the source is done (or skipped,
  per policy). `requires` edges must form a **DAG**. The source's deliverables, summary, and
  handoff notes appear under *Inputs* in the target's briefing.
- **`informs`** (from `informedBy`): context only, never blocking. When the source has results,
  they appear under *Related context* in the target's briefing. A self-edge is invalid, and an
  `informs` edge that closes a cycle with `requires` edges produces a warning.
- An edge can carry a `label` that describes what flows along it (for example "API contract").
- **Procedural knowledge on edges**, following Procedural Graphs ([self-evolution
  §6](self-evolution.md#6-procedural-knowledge-on-edges)). An edge may carry `condition` (when the
  transition applies), `guidance` (how to execute the next step), and `pitfalls` (errors and dead
  ends to avoid), plus a semantic `relation`: `leads_to`, `triggers`, `provides_input_for`, or
  `converges_to`. When `relation` is omitted it defaults from the edge kind. Briefings render
  incoming edges' attributes under *Inputs* and outgoing edges' under *Downstream consumers*.
  The `relation` never changes scheduling; only `kind` does.
- Prerequisites cannot be added to a node that has already started (it is `running` or later).
  Reset the node first.

---

## 6. Aims

Aims are first-class terminating conditions. They exist on **nodes**, on the **graph**, and
optionally on **orchestrators** (where they are informational).

### 6.1 Shape

```ts
type Aim = {
  key: string;                    // unique within its owner
  title: string;                  // the statement, e.g. "API test suite passes"
  description?: string;
  kind: 'qualitative' | 'quantitative';
  terminating: boolean;           // default true: gates completion
  guard?: boolean;                // default false: watched continuously (6.6)
  weight?: number;                // for UI and scoring only
  // quantitative
  metric?: string;                // e.g. "test_pass_rate"
  comparator?: 'gte' | 'gt' | 'lte' | 'lt' | 'eq' | 'neq' | 'between';
  target?: number;
  targetMax?: number;             // for 'between'
  unit?: string;                  // "ratio", "%", "ms", "count", "usd", …
  source?: 'reported' | 'derived';     // default 'reported'
  aggregation?: 'latest' | 'min' | 'max' | 'avg' | 'sum';  // default 'latest'
  // qualitative
  criteria?: string[];            // rubric bullets for the judge
  evaluator?: 'self' | 'agent' | 'orchestrator' | 'human';  // default 'self'
  evaluatorKey?: string;          // a specific orchestrator, when evaluator = 'orchestrator'
};
```

Aim **status** within the owner's current activation is `pending` (not yet evaluated), `met`,
`unmet`, `partial`, or `waived`. `partial` counts as unmet for termination but is shown
distinctly.

### 6.2 The terminating rule

> Every `task` node must have **at least one terminating aim**, qualitative or quantitative or
> both. That aim is what makes "done" mean something.

Gates have an implicit terminating aim (the approval). Milestones and groups may have none.
Validation rejects tasks without a terminating aim.

Non-terminating aims (`terminating: false`) are tracked and charted but never block completion.
Use them for useful signals such as bundle size or performance.

### 6.3 Quantitative evaluation

- Agents **report metrics** during an attempt (`metrics_report`, or in notes and submissions).
  The value used is the attempt's metric series reduced by `aggregation` (latest by default).
- The server **computes the verdict** automatically:
  `gte: v ≥ t`, `gt: v > t`, `lte: v ≤ t`, `lt: v < t`, `eq: |v − t| ≤ 1e-9`,
  `neq: |v − t| > 1e-9`, `between: t ≤ v ≤ targetMax`.
- A submission that is missing a value for a terminating quantitative aim is rejected
  (`422 AIM_EVIDENCE_MISSING`) with a hint that names the metric. The agent must measure it,
  or call `fail` if it cannot.
- **Derived metrics** are computed by the server (`source: derived`):

| Metric | Scope | Meaning |
|---|---|---|
| `nodes_done_ratio` | graph | (done + skipped) / total nodes |
| `cost_usd` | graph, node | Sum of reported attempt usage cost |
| `tokens_total` | graph, node | Sum of reported tokens |
| `elapsed_hours` | graph | Wall time since start |
| `failed_attempts` | graph, node | Count of counted failures |
| `open_findings_high` | graph | Unretracted findings with severity ≥ high and no resolution |
| `children_done_ratio` | group | (done + skipped) children / children |

### 6.4 Qualitative evaluation

The `evaluator` decides who judges:

| Evaluator | Who submits the verdict | When |
|---|---|---|
| `self` | The working agent, inside its submission (verdict, rationale, evidence) | At submit. Missing verdicts are rejected (`422`). |
| `agent` | Any **independent** agent session, such as a judge subagent | After submit. The node is `evaluating` and the item is queued for reviewers. |
| `orchestrator` | An attached orchestrator with the `evaluate` capability whose scope covers the node (or the one named by `evaluatorKey`) | After submit; queued for that orchestrator. |
| `human` | A human in the UI | After submit. Opens an `approval` request in the Inbox. |

An evaluation records `verdict` (`met | unmet | partial`), `rationale`, `evidence[]`, optional
`score`, and the evaluator's execution annotation.

**Independence.** When `policy.evaluation.independent` is true (the default), verdicts from
`agent` or `orchestrator` evaluators must come from a session other than the attempt's executor.
Otherwise the server returns `403 POLICY_DENIED`.

### 6.5 Combining aims and finalizing

When every terminating aim of the current attempt has a verdict:

```
satisfied = aimMode == 'all'
  ? every terminating aim ∈ {met, waived}
  : some  terminating aim ∈ {met, waived}
```

`satisfied` → attempt `passed`, node `done`. Otherwise the attempt is `failed` and the failure
policy of section 7 applies. With `aimMode = any`, the attempt passes as soon as one terminating
aim is met. Evaluations still pending at that point are cancelled.

**Waiving.** A human (or an orchestrator with `resolve`) can waive an aim with a justification.
Waivers are events, and they are shown prominently in the audit view.

### 6.6 Graph aims and guard aims

- Graph aims use the same shape. Quantitative graph aims take values from graph-level metric
  reports or derived metrics. Qualitative graph aims are judged by an orchestrator or a human.
- Graph aims are **displayed live**, but they **terminate** only during `verifying`. If none
  are defined, the server adds the default derived aim `nodes_done_ratio ≥ 1` ("all nodes
  complete").
- A **guard aim** (`guard: true`) is evaluated continuously. When it becomes unmet (for example
  `cost_usd ≤ 40` is exceeded), the server **pauses the graph** and opens an escalation. Guards
  are how budgets and time limits are enforced.

---

## 7. Iteration: retries and loops (failure-cycles)

Iteration is always **bounded**. Two mechanisms cover it.

### 7.1 Self-iteration (`maxAttempts`)

A node may make up to `maxAttempts` **counted** attempts per activation (see the table in
section 4). After a counted outcome:

1. If the node **triggers a loop**, the outcome is `failed` (aims unmet), and the loop has
   iterations left, then **the loop fires** (7.2). This does not consume a self-retry.
2. Otherwise, if counted attempts < `maxAttempts`, the node returns to `ready`. The next
   attempt's briefing carries **feedback**: unmet aims with rationales and values for `failed`,
   the error for `errored`, and the last checkpoint and handoff for `abandoned`.
3. Otherwise the node is **exhausted** and `onExhausted` applies (7.4).

### 7.2 Loops

A loop is a bounded back-edge for cycles that span several nodes, the classic
*implement → test → (fail) → implement* cycle:

```yaml
loops:
  - key: api-fix-cycle
    from: api-tests        # trigger: when this node's terminating aims fail…
    to: implement-api      # …re-enter here
    maxIterations: 4       # total passes through the body, including the first
    onExhausted: escalate
```

- **Body**: every node on a `requires` path from `to` to `from`, inclusive. It is computed at
  validation time and stored.
- **Iteration counter**: starts at 1. It is shown as `↺ 2/4`.
- **Status**: `idle` (not entered yet), `active` (body in progress), `satisfied` (trigger
  passed), `exhausted`.

**Structure rules** (validation errors), which keep loops interpretable and resets well-defined:

1. `from ≠ to`. Use `maxAttempts` for self-retry.
2. `from` is reachable from `to` through `requires` edges.
3. **Laminar**: any two loop bodies are either disjoint or nested. They never partially overlap.
4. A node triggers **at most one** loop.
5. **Single exit**: every `requires` edge from a body node to a node outside the body must start
   at the trigger (`from`). An `informs` edge leaving the body produces a warning.
6. `1 ≤ maxIterations ≤ 50`.

External inputs into any body node are allowed. They are already satisfied, or are satisfied
concurrently.

**Firing.** When the trigger's attempt is `failed` (aims unmet, or a gate trigger is rejected)
and `iteration < maxIterations`, all of the following happen in one transaction:

1. `iteration += 1` and the loop is `active`.
2. Every body node: `activation += 1`, its last passed attempt becomes `superseded`, and its
   status becomes `pending`. Readiness is then recomputed, so `to` usually becomes `ready`.
3. Every loop nested inside the body resets to `iteration = 1` and `idle`.
4. **Loop feedback** is recorded: the trigger's unmet aims with values and rationales, its
   summary, and its `finding` notes. This feedback leads the briefing for `to` and appears in
   the briefings of every other body node in the new iteration.
5. Events `loop.iterated` and `node.status_changed` (one per body node) are emitted.

Every body node is guaranteed to be `done` when the trigger fails, because all of them are
ancestors of the trigger. Downstream nodes outside the body have not started, by the
single-exit rule. So a reset never invalidates in-flight work.

**Nesting.** An inner loop gets a fresh iteration budget on each outer iteration, like nested
`for` loops. The UI shows both counters.

### 7.3 Example

```
requirements → design → implement-api ⇄ api-tests → e2e ⇄ release-review
                         └─ inner loop (max 4) ─┘
               └──────────── outer loop design…release-review (max 2) ─────────┘
```

When `api-tests` fails on iteration 2/4, `implement-api` and `api-tests` reset and the loop goes
to 3/4. If `release-review` (a human gate) is rejected, everything from `design` onward resets.
The inner loop goes back to 1/4 and the outer loop goes to 2/2.

### 7.4 Exhaustion policies

| `onExhausted` | Node (self-iteration) | Loop |
|---|---|---|
| `escalate` *(default)* | Node → `needs_input` with an escalation request. Options: **retry** (+N attempts), **accept** as-is (`done` with `acceptedWithDeviation`), **skip**, **fail**, **edit & retry**. | Trigger → `needs_input` with an escalation request. Options: **extend** (+N iterations), **accept**, **fail**, **edit & retry**. |
| `fail` | Node → `failed`. | Trigger → `failed`. |
| `skip` | Node → `skipped` (reason: exhausted). | — |
| `accept` | Node → `done` with `acceptedWithDeviation`. | Trigger → `done` with `acceptedWithDeviation`. |

A terminally `failed` node with dependents makes the graph stalled (2.1). An escalation then
lets a human or an orchestrator retry, skip, or fail the graph.

---

## 8. Orchestrators

Orchestrators are **agent roles that run across the whole graph, outside the task DAG**. One
example is a lead agent that dispatches subagents. Others are a reviewer that judges quality,
an integrator that merges branches, and a monitor that audits proof or watches the budget.

| Field | Purpose |
|---|---|
| `key`, `name` | Identity within the graph. |
| `role` | `lead`, `reviewer`, `integrator`, `monitor`, `evolver` (optional self-evolution, §16), or `custom`. |
| `aim`, `purpose`, `prompt` | As for nodes: what it achieves, why, and how. |
| `scope` | `all`, `{ nodes: [...] }`, or `{ tags: [...] }`: which nodes it acts on. |
| `capabilities` | `dispatch` (claim on behalf of subagents), `evaluate` (judge aims), `mutate` (add or modify nodes, per policy), `resolve` (resolve requests and waive aims), `approve` (approve gates assigned to orchestrators), `evolve` (record lessons and submit evolution proposals, §16). |
| `triggers` | The event types it reacts to (for example `node.submitted`, `request.created`, `loop.exhausted`). These route notifications and feed its duty queue. |
| `aims` | Optional, informational. For example "every done node has a proof note". |
| `executor` | Recommended model, thinking, and mechanism. |

**Lifecycle.** An orchestrator is `idle` until a session **attaches** (`active`). Attaching takes
a lease, renewed by heartbeat. When the lease lapses, the orchestrator returns to `idle` and
another session can take the role over: the handoff. Humans can set it to `paused` or `stopped`.

**Duty queue.** For each orchestrator, the server computes the items it should act on, given its
capabilities and scope:
ready nodes to dispatch (`dispatch`), submitted attempts awaiting its verdict (`evaluate`), open
requests assigned to orchestrators or to it (`resolve` and `approve`), stale leases, guard
violations, and loop exhaustions (`resolve`).

**Acting on behalf.** An orchestrator with `dispatch` can claim a node *for* a subagent. The
attempt records `dispatchedBy`, and the subagent reports using the attempt id. Notes the
orchestrator writes about someone else's work carry `relayedBy`, so the audit trail shows who
did the work and who reported it.

Orchestrator actions appear in the event log with the orchestrator as actor. In the UI they
appear in the *orchestration lane* above the DAG.

---

## 9. Notes and execution annotations

### 9.1 Notes

Notes are append-only records written by agents, orchestrators, humans, or the system. A note
attaches to a **node** (optionally a specific attempt), an **orchestrator**, or the **graph**.

| Type | Use it for | Expectations |
|---|---|---|
| `proof` | **Proof of completion**: test output, verification commands, screenshots, CI links | Should include ≥1 evidence item. The audit view flags done nodes without one. |
| `deliverable` | **Real outcomes**: files, commits, PRs, deployments, artifacts, docs | Should include evidence (commit, PR, file, url). |
| `finding` | Discoveries, bugs, risks, insights | `severity`: `info`, `low`, `medium`, `high`, or `critical`. |
| `decision` | Decisions and their rationale (lightweight ADR) | Title states the decision; body gives alternatives and rationale. |
| `handoff` | A **checkpoint for whoever continues**: state, what's left, gotchas | Write one before stopping, before compaction, and at milestones in long tasks. |
| `progress` | Status updates during long work | Brief. |
| `question` | A question for a human or orchestrator | Creates a `question` request (section 11). |
| `blocker` | An external blocker | Created by the block action; creates a `blocker` request. |
| `comment` | Discussion, including human comments and replies | Threaded via `replyTo`. |

Fields: `type`, `title`, `body` (markdown), `severity?`, `evidence[]`, `metrics?` (also
recorded as metric reports), `author` (the execution annotation), `relayedBy?`, `usage?`,
`replyTo?`, `pinned`, `retractedAt?` and `retractedReason?`.

**Evidence item**: `{ kind, label?, value, meta? }`. `kind` is one of `url`, `file` (path plus
optional `repo`, `ref`, and line range), `commit` (sha plus repo and branch), `pr`, `command`
(the command line, plus `exitCode` and an `output` excerpt in `meta`), `metric`, `image`,
`text`, or `artifact`.

Notes are **never edited or deleted**. Correct a note by posting a new note with `replyTo`, or
**retract** it with a reason. The original stays visible in the audit trail.

### 9.2 Execution annotation

Every note, evaluation, attempt, metric report, and event carries an annotation of what
produced it:

```ts
type ExecutionAnnotation = {
  kind: 'agent' | 'human' | 'system';
  agent?: string;          // display name, e.g. "backend-dev subagent"
  role?: string;           // e.g. "worker", "lead", "reviewer"
  model?: string;          // e.g. "claude-opus-5-5"
  thinking?: string;       // 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | provider-specific
  thinkingBudget?: number; // tokens, when the provider uses budgets
  provider?: string;       // e.g. 'anthropic' | 'openai' | 'google' | 'aws-bedrock' | 'gcp-vertex' | 'azure' | 'local' | 'human'
  mechanism?: string;      // delivery mechanism, e.g. 'claude-code' | 'claude-code-web' | 'claude-agent-sdk' | 'claude-api'
                           // | 'codex' | 'gemini-cli' | 'cursor' | 'github-action' | 'mcp' | 'cli' | 'api' | 'ui'
  sessionId?: string;      // Agent Graphs session id
  clientSessionId?: string;// the agent runtime's own session id (e.g. a Claude Code session_id)
  parentSessionId?: string;// the session that spawned this one (e.g. a lead orchestrator)
  version?: string;        // client or runtime version
};
type Usage = { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number;
               cacheWriteTokens?: number; costUsd?: number; durationMs?: number };
```

The vocabularies are open (any string is accepted), but the listed values get first-class icons,
colors, and grouping in the UI. `GET /api/v1/vocab` publishes them. Defaults flow down: a note
written on an attempt inherits the attempt's annotation unless it overrides fields, so agents
declare their identity once, at claim time. A node's `executor` hints are compared with the
actual annotation, and the UI flags mismatches (for example "recommended Opus · high, ran on
Sonnet · medium").

---

## 10. Sessions, identity, and leases

- A **session** is a registered agent or human process: name, kind, role, model, thinking,
  provider, mechanism, `clientSessionId`, and `parentSessionId`. Registering is optional. A
  claim with an inline annotation creates or looks up the session, keyed by `clientSessionId`
  when one is given.
- **Leases.** Claims and orchestrator attachments take leases (default 30 min, set by
  `policy.leaseTtl` or the node's `leaseTtl`). Leases are renewed by **attempt heartbeats** or
  by **session heartbeats**, which renew every lease the session holds. Claude Code hooks send
  session heartbeats on tool use, keyed by the Claude `session_id`.
- **Sweeper.** Every 30 s the server expires leases. Expired attempts become `abandoned`
  (counted), and the node returns to `ready` or exhausts. Sessions with no heartbeat for longer
  than their longest lease become `lost`.
- **Trust model**: *honest but fallible agents*. API tokens keep outsiders out and assign roles
  (`admin`, `agent`, `viewer`). Within the agent role, the **attempt id is a capability**:
  whoever holds it can heartbeat, note, report, and submit for that attempt. Annotations are
  self-declared and shape-validated. The goal is to prevent mistakes (double claims, cross-talk,
  judging your own work) and to keep an honest record. It is not a defense against malicious
  agents. Per-session secrets can tighten this later.

---

## 11. Human-in-the-loop: requests and directives

The feedback loop between humans, orchestrators, and agents is explicit and auditable:

```
 agents ──(questions, blockers, escalations, approvals)──▶ Requests (Inbox) ──▶ humans / orchestrators
    ▲                                                                              │
    └──(guidance, changes, answers, pause/cancel)── Directives ◀── resolutions, config edits
```

### 11.1 Requests

| Kind | Raised by | Options and effects |
|---|---|---|
| `approval` | A gate becoming ready, a human-judged aim, plan approval, or (M5) a change proposal | **approve** (gate → done; aim → met; graph starts; change applied) or **reject** with comment (gate → failed, which fires its loop if any; aim → unmet; …). |
| `question` | An agent (`question` note or request) | **answer** (free text plus optional choice). The answer becomes an `answer` directive to the asking attempt or node. |
| `escalation` | Exhaustion, a stalled graph, a guard violation, or a timeout | **retry/extend** (+N), **accept**, **skip**, **fail**, **edit & retry**, or **resume** (for guards). |
| `blocker` | An agent's block action | **unblock** (with info, which becomes an `answer` directive; node → ready), **skip**, **fail**. |

A request has `assignee` (`human`, `orchestrator` with optional key, or `any`), `blocking`, and
`options`. Its status is `open`, `resolved`, `dismissed`, or `expired`. Resolving it records the
choice, comment, and annotation of the resolver, then applies the effect atomically.

### 11.2 Directives

Directives are messages *to* agents. Kinds: `guidance` (extra instructions), `change` (the
node's or graph's configuration changed), `answer` (a reply to a question or blocker), and
`pause`, `resume`, `cancel`.

- **Targets**: `graph` (everyone working in it), `node` (the current and future attempts of that
  node), `orchestrator`, or `session`.
- **Lifecycle**: `pending` → `delivered` (included in a claim, briefing, or heartbeat response)
  → `acknowledged` (the agent acked, optionally with a note on how it applied it). A directive
  becomes `superseded` when replaced.
- **Persistence**: node-targeted guidance stays active for future attempts until superseded, so
  it effectively amends the node's instructions. Briefings list active directives with a rule:
  *where a directive conflicts with the prompt, the directive wins.*
- **Auto-directives**: when a human edits a node's prompt, aims, executor hints, or limits while
  an attempt is running, the server creates a `change` directive with a diff summary. The agent
  sees it on its next heartbeat, along with `briefingChanged: true`.

The UI shows the round trip: *"Guidance sent → delivered to Opus 5.5 (claude-code) 40 s later →
acknowledged: 'Switched to Postgres for sessions table'."*

---

## 12. Context resilience

Agents have limited context windows, get compacted, crash, and hand off. Agent Graphs makes
progress **survive the agent**:

1. **The graph is the memory.** Prompts, aims, decisions, attempts, checkpoints, handoffs, and
   feedback all live in the graph, not in any one agent's context.
2. **Briefings.** `GET …/nodes/{key}/briefing?budget=N` returns a token-budgeted context packet
   with everything an agent needs to do the node *now*. It stays **local**: the node plus a 2-hop
   neighborhood (inputs and downstream consumers, with their edge guidance and pitfalls), never
   the whole history. It is truncated by priority (see
   [agent-protocol](agent-protocol.md#4-briefings-and-sitreps)). When `learn` mode is on, it
   includes relevant lessons. **Sitreps** do the same for orchestrators at graph level.
3. **Checkpoints and handoffs.** Heartbeats carry a machine-readable `checkpoint`. `handoff`
   notes carry the human-readable state. Both feed the next attempt's briefing.
4. **Leases.** Dead or stalled agents are detected and their work is recycled automatically.
5. **Hooks** (Claude Code integration). Briefings are re-injected after compaction or resume
   (`SessionStart`). Heartbeats ride on tool use (`PostToolUse`). Stopping with an open attempt
   is blocked unless the agent submits, releases, or hands off (`Stop`/`SubagentStop`).
   Compaction is recorded (`PreCompact`).
6. **Completion guards.** A node cannot be `done` without satisfying its terminating aims and
   required checklist items. A graph cannot complete until every node is `done` or `skipped`
   (with a reason) and its aims are met. Nothing is silently dropped.
7. **Audit gaps.** The server flags done nodes without `proof` notes, aims waived without
   justification, and attempts submitted without summaries. Monitor orchestrators get these in
   their duty queues.

---

## 13. Events and audit

- Every state change writes its state rows **and** one or more **events** in the same database
  transaction. An event records `type`, entity, the actor's execution annotation, `payload`
  (including before/after values for configuration edits), and `createdAt`.
- Events are **append-only** and **hash-chained** per graph:
  `hash = sha256(prevHash + canonicalJson(event))`. `GET /graphs/{id}/audit/verify` recomputes
  the chain, and the UI shows the verification state.
- Events drive the live UI (SSE), the activity feeds, the timeline, and audit export (JSONL).
- High-frequency heartbeats update attempt rows without writing events. An event is written only
  when `progress` or `currentStep` changes, rate-limited to one per minute per attempt.

---

## 14. Policies

Graph-level settings, with defaults:

| Policy | Default | Meaning |
|---|---|---|
| `maxAttempts` | `3` | Default node self-iteration bound per activation. |
| `onExhausted` | `escalate` | Default node exhaustion policy. |
| `leaseTtl` | `30m` | Default lease length. |
| `maxParallel` | `null` (unlimited) | Maximum concurrently running nodes. Enforced by claim and `next`. |
| `mutations` | `append` | Structural changes after start: `locked` (admins only), `append` (agents may add nodes, edges, and loops), `open` (agents may also modify or remove nodes that have not started). `propose` (agent changes become approval requests) arrives in M5. |
| `requirePlanApproval` | `false` | Agent-initiated `start` needs human approval. |
| `evaluation.independent` | `true` | Judges must differ from workers. |
| `skippedSatisfiesDeps` | `true` | A skipped prerequisite counts as satisfied. |
| `requireProofForDone` | `false` | When true, submit is rejected unless the attempt has ≥1 `proof` note. |
| `failFast` | `false` | When true, a terminal node failure fails the graph instead of stalling it. |
| `evolution` | `{ mode: off }` | Optional self-evolution: `off`, `learn`, `propose`, or `auto`, with scope, protected fields, validation, and budget (§16). |

---

## 15. Invariants

The engine must maintain these. Each one becomes a property-based or table-driven test in
`packages/core`.

1. `requires` edges form a DAG. Loop structure rules (7.2) hold after every mutation.
2. At most one attempt per node is `running` or `submitted`.
3. A node is `done` only if, in its current activation, its terminating aims are satisfied per
   `aimMode` (counting `waived` as met), or it was accepted through an escalation
   (`acceptedWithDeviation = true`). Gates: only when approved. Milestones: only when every
   prerequisite is done or skipped.
4. A node is `ready` or later only if every `requires` predecessor is `done` (or `skipped`, per
   policy), unless an explicit human override is recorded.
5. Counted attempts per activation ≤ `maxAttempts`, and `loop.iteration` ≤ `maxIterations`.
   Both bounds can only be raised by an explicit, evented extension.
6. A graph is `completed` only if every node is `done` or `skipped` and every terminating graph
   aim is met, waived, or accepted.
7. Every state change has at least one event with an actor annotation, and the per-graph hash
   chain is continuous.
8. Notes, evaluations, metric reports, and events are never updated or deleted. Only additive
   retractions are allowed.
9. When independence is on, an `agent` or `orchestrator` verdict never comes from the attempt's
   executor session.
10. A loop firing resets exactly its body and its nested loops. No node outside the body changes
    status.
11. *(With self-evolution)* No automatic edit ever changes a protected field (aims, guards,
    policies, validation suites, gate or evolution settings). Every committed proposal passed its
    gate and can be reverted.

---

## 16. Self-evolution (optional)

Graphs, templates, and briefings can improve from their own execution history. The design follows
*Procedural Graphs* (arXiv:2609.09153) and related work, and is specified in
[self-evolution.md](self-evolution.md). In short:

- **Modes**: `off` (the default), `learn`, `propose`, `auto`.
- **Learn**: when a node passes after failures, a lesson duty is created. The worker or the
  `evolver` records a **lesson** (guidance, a pitfall, or a suggested check), which future
  briefings retrieve with provenance and helpfulness counters. Edge `guidance` and `pitfalls`
  may be appended as soft guidance.
- **Propose and auto**: an orchestrator with role `evolver` and capability `evolve` contrasts
  high- and low-scoring traces and submits **proposals**: typed edits to topology, prompts,
  checklists, executor hints, or edge attributes. Each proposal passes a **validation ladder**
  (structural → counterfactual → replay → live A/B → human) and a **gate** that accepts when the
  candidate scores at least as well as the incumbent, ties included. Rejected proposals form a
  **rejection memory**, and identical re-proposals are refused.
- **Protected fields** are never changed automatically: aims, guards, policies, validation
  suites, and gate configuration.
- Everything is evented, diffable, monitored for regressions, and revertible.
