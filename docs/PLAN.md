# Agent Graphs: plan

> **Status:** M0 (foundation) complete. Docs, design mockup, repo scaffold, CI, and license policy
> are in place. **Next: M1, the core engine.**

## 1. What we're building

**Agent Graphs** is a platform for **constructing, executing, monitoring, and auditing the graphs
that AI agents work through when they build software.**

A graph is a plan with teeth. Every node has an aim, a purpose, a prompt, acceptance aims, and
a status. Agents claim nodes, report progress, attach evidence-backed notes annotated with the
model, thinking level, provider, and delivery mechanism they used, and submit work that is
judged against qualitative and quantitative aims. Failed work iterates through **bounded
failure-cycles** until it meets its aims or escalates to a human. **Orchestrators** supervise the
whole graph from outside the task DAG. Humans watch everything live in a polished web UI and
steer through an **Inbox** and **directives** that agents receive and acknowledge.

Because all state lives in the graph rather than in any one agent's context window, work
**survives compaction, crashes, and handoffs**. Every stage gets executed, and every claim of
"done" is backed by an auditable record.

## 2. Goals and non-goals

**Goals**
1. Represent agent work as graphs with rich node metadata, overall aims, orchestrators, and
   bounded failure-cycles.
2. Make agents first-class API users through MCP, a CLI, and REST, with token-budgeted
   briefings and a protocol that is resilient to context loss.
3. Make status and history instantly interpretable in a beautiful, live UI.
4. Provide a complete, tamper-evident audit trail of who did what, with which model, and what
   proved it.
5. Close the loop between humans and agents with requests, directives, configuration edits, and
   acknowledgments.
6. Stay provider-agnostic, run locally with one command, and be permissively licensed for
   commercial use.

**Non-goals (for now)**
- Executing agents itself. The server is a ledger and state machine; an optional runner comes in
  M6.
- Being a general workflow engine (no arbitrary code steps, cron, or data pipelines).
- Multi-tenant SaaS concerns (orgs, billing). Single-team deployments only for now.
- Replacing Git, CI, or issue trackers. We **link** to them as evidence.

## 3. Requirements traceability

| Requirement | Where it is addressed |
|---|---|
| Graphs with full node metadata: aim, purpose, prompt, other information, status | [concepts §3](concepts.md#3-nodes) · [spec §3](spec-format.md#3-nodes) · [ui §4.4](ui.md#44-node-inspector-right-drawer-resizable-about-420560-px) |
| Overall aims for the entire graph execution | Graph aims, the `verifying` state, guard aims · [concepts §6.6](concepts.md#66-graph-aims-and-guard-aims) |
| Orchestrator nodes that run across the whole graph, outside subagent tasks | [concepts §8](concepts.md#8-orchestrators) · orchestration lane · duty queues · attach/lease/handoff |
| Result notes: proof of completion, findings, real deliverable outcomes | [concepts §9.1](concepts.md#91-notes) · evidence items · audit gaps |
| Annotate model, thinking level, and provider/delivery mechanism on each note | Execution annotation on notes, evaluations, attempts, metrics, and events · [concepts §9.2](concepts.md#92-execution-annotation) |
| Failure-cycles: tasks iterate, boundedly, until they reach an aim | `maxAttempts` plus loops with carried feedback and exhaustion policies · [concepts §7](concepts.md#7-iteration-retries-and-loops-failure-cycles) |
| Qualitative and quantitative aims; at least one terminating | [concepts §6](concepts.md#6-aims) · the terminating rule (§6.2) is enforced by validation |
| A beautiful, interpretable UI to interrogate all, active, and completed graphs and statuses | [ui.md](ui.md) · [design mockup](design/ui-mockup.html) |
| An API to manage all of this | [api.md](api.md) · OpenAPI · SDK · MCP · CLI |
| Configuration in the UX, in a feedback loop with agents | Config edits → change directives → acknowledgments; Inbox · [concepts §11](concepts.md#11-human-in-the-loop-requests-and-directives) |
| Agents update graph status directly | [agent-protocol.md](agent-protocol.md): claim, heartbeat, notes, submit |
| Auditing and orchestration management | Append-only, hash-chained events; audit export, verify, and gaps · [concepts §13](concepts.md#13-events-and-audit) |
| All stages executed despite limited or large context | [concepts §12](concepts.md#12-context-resilience): briefings, sitreps, checkpoints, handoffs, leases, hooks, completion guards |
| Licensable as the owner chooses, permitted for the owner's commercial use, with no incompatible dependencies | [licensing.md](licensing.md): proprietary for now (A2A Adventures); permissive-only dependencies; CI license gate |
| Optional self-evolution mechanisms, based on *Procedural Graphs* (arXiv:2609.09153) and related work | [self-evolution.md](self-evolution.md): edge condition/guidance/pitfalls; lessons; an evolver role with gated proposals (≥ incumbent, ties accepted) and a rejection memory; protected fields; lineage. Phased E1 → E4. |

## 4. How it works: one graph, end to end

*Scenario: building a notes app ([`examples/graphs/notes-app.yaml`](../examples/graphs/notes-app.yaml)).*

1. **Plan.** The user asks their main Claude Code session (Opus, high thinking) to build a notes
   app. The session runs the `/plan` MCP prompt. It drafts a spec with 16 nodes, two loops, a
   budget guard aim, and lead, reviewer, and auditor orchestrators, then validates it and creates
   it as a **draft**. It then requests `start`. Policy requires plan approval, so an approval
   request appears in the **Inbox** instead.
2. **Human review.** The user opens the graph in the UI and sees the DAG with its loop regions.
   They tighten one prompt, raise a coverage target, and approve. The graph becomes `active`.
3. **Dispatch.** The session attaches as orchestrator `lead` and reads the **sitrep**:
   `requirements` is ready.
   - The lead claims the node on behalf of a subagent (Sonnet, medium), which creates a child
     session, then spawns the subagent with the briefing and attempt id.
   - The subagent works, heartbeating automatically through hooks. It posts a `deliverable` note
     (commit) and a `proof` note (doc lint output), then submits.
   - The node's qualitative aim is judged by the `reviewer` orchestrator, so the node is
     `evaluating` until the reviewer's verdict (met) arrives.
   - The node is `done`, and `architecture` becomes ready.
4. **Gate.** `plan-review` is a human gate. The user approves it from the Inbox. Two branches
   become ready and run in parallel (bounded by `maxParallel`).
5. **Failure-cycle.** `api-tests` reports `test_pass_rate = 0.92` against a target of `≥ 1`.
   The aim is unmet, so loop `api-fix-cycle` fires: `implement-api` and `api-tests` reset to
   iteration 2 of 4, and the failing tests plus the reviewer's finding lead the next briefing.
   Midway through, the agent's context is compacted. The `SessionStart(compact)` hook
   re-injects the briefing, and the agent carries on from its checkpoint. Tests reach 1.0 and the
   loop is `satisfied`.
6. **Feedback loop.** The user decides notes should be soft-deleted and sends a **directive**.
   The agent receives it on its next heartbeat, acknowledges it ("added `deleted_at`, 30-day
   purge job"), and records a `decision` note. The UI shows sent → delivered → acknowledged.
7. **Blocker.** `security-audit` needs staging credentials. The agent blocks, and a blocker
   request appears in the Inbox. The user provides access details, the node returns to `ready`,
   and the next attempt's briefing contains the answer.
8. **Escalation.** `e2e-tests` exhausts its attempts. An escalation offers Retry +2, Edit &
   retry, Accept, Skip, or Fail. The user edits the prompt and grants two more attempts.
9. **Verification.** Every node is done, so the graph enters `verifying`. The lead reports
   `e2e_pass_rate = 1.0` with CI evidence, and the user judges the qualitative aim ("a user can
   sign up, create, tag, and search notes") against the deployed URL. The graph is
   `completed`, the audit chain verifies, and the full record exports as JSONL.
10. **Learning (optional).** With `evolution.mode: learn`, the fix in step 5 left a lesson: "when
    refresh-token tests fail, check rotation first". The next graph built from this template
    briefs `implement-api` with that lesson up front. In `propose` mode, the evolver also
    suggests adding a `contract-check` step to `implement-api`'s checklist. The user approves it,
    and later runs show a higher first-pass yield for that node.

## 5. Architecture at a glance

A single Node.js server (Hono + SQLite) holds the state machine and an append-only,
hash-chained event log. It exposes REST and SSE, mounts MCP over HTTP, and serves the React
UI. Agents connect through the MCP server (stdio), the `agraph` CLI, or REST. A pure,
deterministic **engine** in `@agent-graphs/core` implements every rule, and **zod** schemas
there are the single source for types, validation, OpenAPI, JSON Schema, and MCP tool schemas.
Details are in [architecture.md](architecture.md).

## 6. Key decisions

| # | Decision | Why | Alternatives considered |
|---|---|---|---|
| D1 | The server is a **coordination ledger**; agents pull work | Provider-agnostic, simple, and works with any agent runtime. Orchestration stays in agents, where the judgment is. | Built-in executor (deferred to M6 as an optional client) |
| D2 | **TypeScript monorepo** with shared zod schemas | One source of truth for types, validation, OpenAPI, MCP, the CLI, and the UI | Python backend with a TS UI (duplicated types) |
| D3 | **SQLite (WAL) + better-sqlite3 + Drizzle**, single writer process | Zero-config, fast, atomic synchronous transactions, plenty for team scale | Postgres from day one (heavier ops; added later behind repositories) |
| D4 | **Hono** for REST (routes declared with zod schemas that also generate OpenAPI 3.1), **SSE** for live updates | Small, typed, standards-based. SSE is one-way, proxy-friendly, and resumable. A ~150-line `defineRoute` registry replaced `@hono/zod-openapi` in M2: same single schema source, far less boilerplate across ~90 routes. | Fastify; WebSockets; @hono/zod-openapi `createRoute` |
| D5 | **State tables plus a hash-chained event log**, not full event sourcing | Easy queries, a complete audit trail, tamper evidence, and replay for the UI | Pure event sourcing (complex projections) |
| D6 | **Bounded loops** as explicit back-edges with structured bodies (laminar, single-exit), plus `maxAttempts` | Interpretable visually, well-defined resets, no runaway cycles | Arbitrary cyclic graphs; loop-only-as-subgraph |
| D7 | **First-class aims**: quantitative auto-judged; qualitative judged by self, agent, orchestrator, or human; independence by default | "Done" means something, and evaluation is auditable | Free-form completion flags |
| D8 | A flat **YAML/JSON spec** with `needs:` and shorthands | LLM- and human-friendly; familiar from GitHub Actions | Kubernetes-style envelopes; a visual-only editor |
| D9 | **Self-declared annotations**, attempt id as a capability, role tokens | Fits the honest-but-fallible threat model and keeps agent ergonomics simple | Per-agent PKI (overkill for now) |
| D10 | **React 19 + Vite + TanStack + Tailwind + Radix + React Flow + dagre** | A modern, fast, accessible, permissively licensed UI stack | ELK layout (rejected: EPL/GPL); Next.js (unneeded SSR) |
| D11 | **MCP + CLI + REST** behind one `agraph` binary | MCP for Claude Code and other MCP clients, the CLI for shell agents and hooks, REST for everything else | MCP only |
| D12 | **Proprietary for now** (A2A Adventures, all rights reserved), permissive-only dependencies, enforced in CI | The owner keeps every option (closed, open, dual) open | Releasing now as `MIT OR Apache-2.0` (deferred) |
| D13 | **Optional, gated self-evolution** modelled on *Procedural Graphs*: edge condition/guidance/pitfalls, lessons, an `evolver` role, a validation gate (≥ incumbent), a rejection memory, protected fields | Graphs improve from their own traces without silent drift or objective hacking. Off by default, because benefits vary by model and scenario (AgentStream). | Free-form auto-rewriting of prompts and graphs (unsafe); no learning (wastes the trace data we already record) |

## 7. Roadmap

Each milestone ends in a **gate**: its acceptance criteria are verified with evidence (tests,
screenshots, proof notes). Once M2 lands, the remaining work is tracked **in Agent Graphs
itself** by importing [`build-graph.yaml`](build-graph.yaml).

### M0: Foundation ✅ (this change)
Planning docs, a high-fidelity UI mockup, example specs, the build graph, the monorepo scaffold
(all packages with placeholders, toolchain verified), license files and checker, CI,
`CLAUDE.md`, and a cloud-session start hook.

### M1: Core engine (`packages/core`)
- **Deliverables**: zod schemas (entities, spec, DTOs, annotations, vocab); spec
  parse/normalize/validate (every rule in [spec §8](spec-format.md#8-validation), with paths and
  hints); graph algorithms (topological order, cycle reporting, reachability, loop bodies,
  laminarity, single exit, critical path); the engine (claim, heartbeat, submit, evaluate, fail,
  block, release, lease expiry, readiness, gates, milestones, loop firing, exhaustion policies,
  pause/resume/skip/retry/reopen, graph verification and completion, guards, mutation
  validation); briefing and sitrep renderers with budgets (including *Lessons & pitfalls* and
  *Downstream consumers*); JSON Schema export.
- **Self-evolution groundwork** (E1 core, [self-evolution.md](self-evolution.md)): edge
  attributes and relations in the spec; the `evolution` policy; lesson ranking; lesson-duty
  detection in the engine; edit-DSL types plus validation; the canonical edit hash; a pure
  gate-decision function.
- **Done when**: every validation rule has tests; transition tables cover concepts §3–§7; the
  invariants in concepts §15 pass property tests (≥ 1000 random runs); coverage is ≥ 90%;
  briefing snapshots for the notes-app example stay within budget.

### M2: Server and API (`apps/server`)
- **Deliverables**: Drizzle schema and migrations; repositories; command services; every
  endpoint in [api.md](api.md) not marked M5; SSE with replay; jobs; auth modes; idempotency;
  error hints; OpenAPI and `/api/docs`; `agraph`-independent seed script.
- **Done when**: integration tests cover every endpoint; the scenario suite passes (nested loops,
  gate-rejection loop, lease expiry, escalations, directives and acks, guard pause, plan
  approval, mutations under each policy); the OpenAPI document validates; claim p95 is under
  20 ms on a 1000-node graph; the hash chain verifies after the scenario runs.

### M3: Agent interfaces (`packages/sdk`, `cli`, `mcp`, `simulator`, `integrations/claude-code`)
- **Deliverables**: typed SDK; the `agraph` CLI (serve, mcp, hook, client commands); MCP server
  (stdio and HTTP, profiles, prompts, resources); a simulator with fake agents (configurable
  models and failure rates; `pnpm demo`); Claude Code hooks, skill, and config examples.
- **Done when**: the simulator completes the notes-app example end to end, including at least
  one loop iteration and one escalation; MCP tool tests pass; **a real Claude Code session
  completes a node over MCP**, with proof recorded; the compaction re-injection and Stop-block
  hooks are verified. Until M5 packaging, MCP is configured through the repo-local bin
  (`node <repo>/packages/cli/bin/agraph.js mcp`).
- **Self-evolution E1 (learn mode)**: lessons storage and API, lesson duties on
  passing-after-failure, `lesson_add` and `lessons_search` MCP tools, edge-attribute endpoints,
  and briefing integration. Done when a simulated failure-cycle produces a lesson that appears,
  with provenance, in the next relevant briefing, and its counters update.

### M4: Web UI MVP (`apps/web`)
- **Deliverables**: design tokens and components (from the mockup); the shell; Overview; Graphs
  list; the graph workspace (Canvas, Activity, Notes, Agents, Spec, Settings); node and
  orchestrator inspectors (every tab); Inbox; New graph (spec editor with live preview); live
  SSE updates; a Playwright E2E suite.
- **Done when**: E2E passes for create → live progress → approve gate → resolve escalation →
  edit prompt → directive acknowledged; a human design review approves against the mockup; live
  latency is under 1 s; axe accessibility checks pass on key screens; a generated 500-node graph
  stays smooth.

### M5: Depth and hardening
Timeline/Gantt; the Aims tab with metric charts; groups and node expansion (hierarchy); graph
revisions and diffs; basic templates (store a spec and instantiate it); FTS search UI;
attachments; change proposals
(`mutations: propose`); webhooks; audit export and verify UI; secret redaction; a Docker image;
remote token-auth UX; a `/metrics` endpoint; `npx agent-graphs` packaging; third-party notices.
**Self-evolution E2 (propose)**: the evolver role, evolution packet, edit DSL proposals,
structural and counterfactual stages, human approval, rejection memory, revert, and the Evolution
tab.

### M6: Autonomy and scale (optional)
A built-in runner (Claude Agent SDK or headless Claude Code) with budgets and concurrency;
"Ask this graph" Q&A over the audit log; Slack and email notifications; Postgres; OIDC.
**Self-evolution E3 (auto)**: template versions and lineage, evaluation suites, replay through
the runner or CI, live A/B, an auto-commit gate, overfitting controls, model-tier
stratification, and reliability records. **E4**: node procedures with step-level heartbeat
guidance, and preplay.

## 8. Parallel work plan

```
M0 ──► M1 core ──► M2 server ──┬──► M3 agent interfaces ──┐
         │                     └──► M4 UI screens ────────┼──► MVP release ──► M5 ──► M6
         └──► M4 design system + shell (fixture data) ────┘
```
- The **design system and shell** can start right after M1 fixes the schemas, using typed
  fixtures.
- **M3 and M4** run in parallel once the M2 API is stable (its OpenAPI is the contract).
- **Dogfooding** starts the moment M2 is usable: import `build-graph.yaml`, attach a lead
  orchestrator, and run the rest of the build through the platform.

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Agents skip protocol steps (heartbeats, notes, submit) | Hooks automate heartbeats and context re-injection; the Stop hook blocks stopping with open attempts; leases recycle abandoned work; hints in every error; a small worker tool profile |
| The model feels too complex to author | Shorthands, defaults, templates (M5), `/plan` prompt, validation with "did you mean" hints, and examples |
| Large graphs become unreadable | Structure-stable layout, level of detail, focus mode, filters, critical path; groups in M5 |
| SQLite contention with many agents | A single writer, WAL, short transactions, measured targets; Postgres path kept open |
| Prompt injection through other agents' notes | Provenance-labelled `<agent-content>` blocks; only prompts, context, and directives instruct; sanitized rendering |
| Identity spoofing between agents | Acceptable under the threat model; per-session secrets later; tokens keep outsiders out |
| Gaps in TypeScript 7 tooling (tools that rely on the old JS compiler API) | We use only tools that do not need that API (Vite, tsx, Biome, Vitest). Pin TS 6 for one tool if needed. |
| Scope creep before the MVP | Milestone gates; M5 and M6 are explicitly deferred |
| Self-evolution games its own objective, overfits validation, or drifts | Protected fields (aims, guards, policies, suites) are never edited automatically; independent judges; rotating validation plus a hidden test split; regression monitoring with auto-revert; off by default ([self-evolution §12](self-evolution.md#12-safety-and-governance)) |

## 10. Open questions for the owner

1. **Deployment target**: local-only first, or a hosted instance that cloud agent sessions can
   reach? This decides how early token-auth UX and Docker matter.
2. **Default human checkpoints**: should agent-created graphs require plan approval by default?
3. **Agent runtimes beyond Claude Code** to prioritize (Codex, Gemini CLI, custom SDK agents)?
4. **Built-in runner (M6)**: do you eventually want the platform to launch agents itself?
5. **Self-evolution validation data**: which recurring kinds of work (bug fix, feature,
   dependency upgrade, …) should get templates and evaluation suites first? `auto` mode (E3)
   needs them.
6. **Paper access**: `arxiv.org` is blocked by this environment's network policy, so the
   self-evolution design relies on the abstract and two open-source reimplementations. If you
   allow `arxiv.org` (or paste the PDF), I will reconcile the details against the paper.

## 11. Document map

| Doc | Contents |
|---|---|
| [concepts.md](concepts.md) | **Normative semantics**: statuses, aims, loops, orchestrators, notes, requests, directives, invariants |
| [spec-format.md](spec-format.md) | YAML/JSON graph spec syntax, shorthands, validation rules |
| [data-model.md](data-model.md) | SQLite schema, event catalog, hash chain, read models |
| [api.md](api.md) | REST conventions, endpoints, SSE, key payloads |
| [agent-protocol.md](agent-protocol.md) | Worker and orchestrator loops, briefings, notes, MCP, CLI, Claude Code hooks |
| [ui.md](ui.md) | Screens, canvas, visual system, feedback-loop UX |
| [architecture.md](architecture.md) | Topology, layering, jobs, testing, CI, deployment, tech stack |
| [licensing.md](licensing.md) | Project license and dependency policy |
| [self-evolution.md](self-evolution.md) | Optional self-evolution: research basis, modes, lessons, evolver, gate, safety, phasing |
| [build-graph.yaml](build-graph.yaml) | This roadmap as an executable Agent Graphs spec |
| [design/](design/) | UI mockup and screenshots |
