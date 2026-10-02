# Graph spec format (`agent-graphs/v1`)

A **graph spec** is the declarative, portable definition of a graph: aims, nodes, dependencies,
loops, orchestrators, and policy. Humans and agents author specs in **YAML or JSON**, then
create graphs from them (`POST /api/v1/graphs`, `agraph graph create -f`, or the `graph_create`
MCP tool). Any graph can be exported back to a spec (`GET /api/v1/graphs/{id}/spec`).

Semantics are defined in [concepts.md](concepts.md). This document defines **syntax and
validation**.

- The schema lives in `packages/core/src/spec/` as zod schemas. A JSON Schema is generated and
  served at `GET /api/v1/schema/graph-spec.json` for editor autocompletion. Add this line to a
  YAML file to use it:
  `# yaml-language-server: $schema=http://localhost:4747/api/v1/schema/graph-spec.json`
- The format is **flat** and **LLM-friendly**: dependencies use `needs:` (like GitHub Actions),
  and there are shorthands for common aims. Exports always emit the canonical (expanded) form.

## 1. Minimal example

```yaml
schema: agent-graphs/v1
title: Add dark mode
aims:
  - Dark mode ships behind a user toggle and persists across reloads   # shorthand; graph aims are judged by a human
nodes:
  - key: implement
    title: Implement dark mode
    aim: Theme toggle with persisted preference
    prompt: |
      Add a theme toggle to the settings page. Persist the choice in localStorage.
    aims:
      - check: test_pass_rate >= 1        # quantitative shorthand
      - title: Toggle is keyboard accessible and labelled
        evaluator: agent                  # judged by an independent agent
  - key: review
    title: Human design review
    kind: gate
    aim: A human confirms both themes look right
    needs: [implement]
    gate: { approver: human, instructions: Check contrast in both themes. }
loops:
  - { key: review-cycle, from: review, to: implement, maxIterations: 3 }
```

A fuller, realistic example is in [`examples/graphs/notes-app.yaml`](../examples/graphs/notes-app.yaml).
The build plan for this repository, expressed as a graph, is in [`build-graph.yaml`](build-graph.yaml).

## 2. Top level

| Field | Type | Req. | Notes |
|---|---|---|---|
| `schema` | `"agent-graphs/v1"` | ✓ | Format version marker. |
| `title` | string | ✓ | 1–200 chars. |
| `slug` | string | | Globally unique, kebab-case. Usable in API paths in place of the id. |
| `description` | markdown | | |
| `tags` | string[] | | |
| `repository` | `{ url, branch?, path? }` | | The codebase the work happens in. Shown in briefings. |
| `context` | markdown | | Shared background included in **every** briefing (stack, conventions, links). |
| `constraints` | string[] | | Hard rules included in every briefing ("no new runtime deps without a decision note"). |
| `aims` | Aim[] | | Overall graph aims. If omitted, `nodes_done_ratio ≥ 1` is added. |
| `policy` | Policy | | See section 7. |
| `defaults` | `{ executor?, tags?, maxAttempts?, onExhausted?, leaseTtl? }` | | Applied to every node unless overridden. Precedence: node > `defaults` > `policy`. `executor` is shallow-merged. |
| `orchestrators` | Orchestrator[] | | See section 6. |
| `nodes` | Node[] | ✓ | 1–2000 nodes. |
| `loops` | Loop[] | | See section 5. |
| `evolution` | Evolution | | Optional self-evolution settings. See section 7.1. |
| `metadata` | object | | Free-form. |

## 3. Nodes

```yaml
- key: implement-api            # ✓ kebab-case, unique in graph
  title: Implement REST API     # ✓
  kind: task                    # task (default) | gate | milestone
  aim: CRUD + auth endpoints for notes, matching docs/api.md     # ✓ for task & gate
  purpose: Everything in the UI depends on these endpoints       # recommended
  prompt: |                     # ✓ for task
    Implement the endpoints in docs/api.md §Notes using the existing Hono app…
  context: |                    # optional extra background
  deliverables:                 # expected outputs
    - src/api/notes.ts
    - { name: OpenAPI spec, description: Generated at /api/openapi.json, required: true }
  checklist:                    # optional procedural steps
    - Write handler tests first
    - { key: openapi, title: Regenerate OpenAPI, required: true }
  needs: [db-schema]            # requires-edges (blocking)
  informedBy: [architecture]    # informs-edges (context only)
  aims: [ … ]                   # ✓ ≥1 terminating aim for tasks
  aimMode: all                  # all | any
  priority: p1                  # p0 | p1 | p2 (default) | p3
  tags: [code, backend]
  executor:                     # recommendations; `requires` is a hard filter
    role: backend-engineer
    model: claude-opus-5-5
    thinking: high
    provider: anthropic
    mechanism: claude-code
    requires: [repo-write]      # skills the claiming session must declare
    instructions: Dispatch as a subagent in an isolated worktree.
  maxAttempts: 3
  onExhausted: escalate         # escalate | fail | skip | accept
  leaseTtl: 45m
  timeout: 3h
  gate:                         # only for kind: gate (an error on other kinds)
    approver: human             # human | orchestrator
    approverKey: reviewer       # optional, a specific orchestrator
    instructions: What the approver should check.
  metadata: {}
```

A **checklist** item may be a plain string. It normalizes to `{ key: <kebab-case of the title>,
title, required: false }`.

**Long-form edges** carry labels and procedural knowledge (edge attributes follow
*Procedural Graphs*; see [self-evolution §6](self-evolution.md#6-procedural-knowledge-on-edges)).
The same form works in `informedBy`:

```yaml
  needs:
    - key: db-schema
      label: schema types
      relation: provides_input_for   # leads_to | triggers | provides_input_for | converges_to (defaults from kind)
      condition: Migrations applied and generated types exported
      guidance: Import entity types from src/db/schema.ts instead of redefining them
      pitfalls: Do not change column names here; schema changes go through db-schema
```

## 4. Aims

Canonical form:

```yaml
# quantitative
- key: tests-green              # optional; derived from title if omitted (kebab-cased, de-duplicated)
  title: API test suite passes
  metric: test_pass_rate        # presence of `metric` implies kind: quantitative
  comparator: gte               # gte | gt | lte | lt | eq | neq | between
  target: 1
  targetMax: 1.5                # only for between
  unit: ratio
  source: reported              # reported | derived
  aggregation: latest           # latest | min | max | avg | sum
  terminating: true
  guard: false
  description: Run `pnpm test --filter server`; report passed/total.

# qualitative
- key: layering
  title: Handlers follow docs/architecture.md layering
  kind: qualitative
  criteria:
    - No business logic in route handlers
    - All inputs validated with zod
  evaluator: orchestrator       # self (default) | agent | orchestrator | human
  evaluatorKey: reviewer
  terminating: true
```

**Shorthands.** They are normalized on import, and exports always use the canonical form.

| Shorthand | Expands to |
|---|---|
| `- "Toggle persists across reloads"` (a plain string) | A qualitative, terminating aim. On a node, `evaluator: self`. On the graph, `evaluator: human`, because graph aims can't be self-judged. |
| `- check: "coverage >= 0.8"` | quantitative: `metric: coverage, comparator: gte, target: 0.8` |
| `- check: "p95_ms < 200"` | `comparator: lt` (operators `>= > <= < == !=`) |
| `- check: "bundle_kb in [100, 250]"` | `comparator: between, target: 100, targetMax: 250` |

The shorthand grammar is `metric (>=|>|<=|<|==|!=) number` or `metric in [number, number]`,
where metric names match `^[a-z][a-z0-9_.]*$`. A `check` can be combined with other fields
(`title`, `evaluator`, …).

**Derived titles and keys.** When omitted, an aim's `title` defaults to its `check` string.
Its `key` is derived from the title: lowercase, every run of characters other than `[a-z0-9]`
(underscores and dots included) becomes `-`, leading and trailing hyphens are trimmed, and the
result is truncated to 64 characters. Collisions within the owner get `-2`, `-3`, and so on.
For example, `check: "test_pass_rate >= 1"` gets the key `test-pass-rate-1`.

## 5. Loops (failure-cycles)

```yaml
loops:
  - key: api-fix-cycle          # ✓
    title: API fix cycle
    from: api-tests             # ✓ trigger node
    to: implement-api           # ✓ entry node
    maxIterations: 4            # total passes incl. the first (default 3; 1–50)
    onExhausted: escalate       # escalate (default) | fail | accept  (skip is invalid for loops)
    feedback: Include failing test names and the first error of each.   # what to carry forward
```

The body is computed (every node on a `requires` path from `to` to `from`), and the structure
rules in [concepts §7.2](concepts.md#72-loops) are enforced.

## 6. Orchestrators

```yaml
orchestrators:
  - key: lead                   # ✓
    name: Lead orchestrator     # ✓
    role: lead                  # lead | reviewer | integrator | monitor | evolver | custom
    aim: Drive the graph to completion within budget
    purpose: Keeps every stage moving and documented across context resets
    prompt: |
      You are the lead. Loop: sitrep → dispatch ready nodes to subagents → …
    scope: all                  # all | { nodes: [a, b] } | { tags: [code] }
    capabilities: [dispatch, evaluate, mutate, resolve, approve]   # + evolve (evolver role)
    triggers: [attempt.submitted, request.created, loop.exhausted]   # event catalog names
    aims:
      - title: Every done node has a proof note
        terminating: false
    executor: { model: claude-opus-5-5, thinking: high, mechanism: claude-code }
```

## 7. Policy

```yaml
policy:
  maxAttempts: 3
  onExhausted: escalate
  leaseTtl: 30m
  maxParallel: 4                # or null
  mutations: append             # locked | append | open
  requirePlanApproval: false
  evaluation: { independent: true }
  skippedSatisfiesDeps: true
  requireProofForDone: false
  failFast: false
```

**Durations** are either strings matching `^\d+(s|m|h|d)$` (`90s`, `30m`, `2h`, `1d`) or
integer seconds.

### 7.1 Evolution (optional)

Self-evolution is off unless enabled ([self-evolution.md](self-evolution.md)). The block below
shows the full shape with the defaults that apply once a mode is chosen:

```yaml
evolution:
  mode: learn                  # off (default) | learn | propose | auto
  scope: [guidance, checklists]  # guidance | checklists | prompts | executor | topology
  online: true                 # learn within this run (lessons, edge guidance/pitfalls)
  harvest: true                # on completion, propose improvements to the source template (E2+)
  approval: human              # who approves proposals in `propose` mode: human | orchestrator
  validation:                  # E2–E3
    ladder: [structural, counterfactual, human]   # + replay, ab (with templates/suites)
    suite: null                # evaluation suite id (required for replay/ab and for `auto`)
    minRuns: 5                 # per arm for live A/B
    maxRounds: 10
    maxOpsPerProposal: 5
  objective:                   # weights (defaults; see self-evolution.md §9)
    graphSuccess: 0.40
    firstPassYield: 0.25
    loopIterations: 0.10       # inverse
    humanInterventions: 0.10   # inverse
    cost: 0.10                 # inverse, normalized
    wallTime: 0.05             # inverse, normalized
  budget: { costUsd: 10 }
```

Protected fields can never appear in `scope`: aims, guards, policy, validation suites, the
evolution gate's configuration, and the evolution settings. See
[self-evolution §5](self-evolution.md#5-what-may-evolve).

## 8. Validation

`POST /api/v1/graphs/validate` (also `agraph graph validate`, `graph_validate`) returns the
normalized spec plus `errors[]` and `warnings[]`. A spec with errors cannot be created. Each
issue looks like this:

```json
{ "path": "nodes[3].aims[0].target", "code": "required",
  "message": "Quantitative aim 'tests-green' needs a numeric target.",
  "hint": "Add `target: 1`, or use the shorthand `check: \"test_pass_rate >= 1\"`." }
```

**Errors**
- Schema violations: wrong types, missing required fields, unknown fields (strict mode, with a
  "did you mean" hint).
- Duplicate `key`s among nodes, loops, orchestrators, or aims (within an owner).
- References to unknown nodes in `needs`, `informedBy`, loops, `scope`, or `evaluatorKey`.
- A cycle among `requires` edges (the error reports the cycle path), or a self-dependency.
- A `task` without `aim`, without `prompt`, or without a terminating aim. A `gate` without `aim`
  or without `gate.approver`. A `gate:` block on a node that isn't a gate.
- A graph aim with `evaluator: self` or `agent`. Graph aims are judged by an orchestrator or a
  human.
- `evaluator: orchestrator` (or `gate.approver: orchestrator`) without a key, when no
  orchestrator has the `evaluate` (or `approve`) capability.
- A quantitative aim missing `metric`, `comparator`, or `target`; `between` without `targetMax`;
  `targetMax < target`.
- An unknown derived metric (`source: derived` with a metric not in the catalog).
- Loop rules: `from == to`; `from` unreachable from `to`; partially overlapping bodies; a node
  triggering more than one loop; a `requires` edge leaving a body from a node other than the
  trigger; `maxIterations` outside 1–50; `onExhausted: skip`.
- `maxAttempts` outside 1–20.
- `evaluatorKey` or `approverKey` naming a missing orchestrator, or one without the
  `evaluate`/`approve` capability.
- An edge `relation` outside `leads_to | triggers | provides_input_for | converges_to`.
- Evolution settings that can't work:
  - `evolution.mode: auto` without `validation.suite`.
  - A `validation.ladder` containing `replay` or `ab` without `validation.suite`.
  - `evolution.scope` containing an unknown or protected class.
  - `evolution.mode` other than `off` with `approval: orchestrator`, but no orchestrator holding
    `resolve`.

**Warnings**
- A node without `purpose`. A gate without `instructions`.
- An `informs` edge leaving a loop body, or closing a cycle with `requires` edges.
- An orchestrator scope that matches no nodes. An orchestrator `triggers` entry that isn't an
  event type in the [catalog](data-model.md#event-catalog).
- No graph aims (the default aim is added).
- An unknown model, provider, or mechanism (not in the vocabulary, but accepted).
- A prompt longer than 20k characters.
- Nodes with no edges in a multi-node graph.
- An `eq` or `neq` comparison on a metric whose unit suggests floats.

## 9. Versioning

- `schema: agent-graphs/v1` is required. Additive, backwards-compatible fields can arrive
  within v1. Breaking changes bump to `v2`, and the server will accept both for at least one
  minor release, with a migration (`agraph spec migrate`).
- Specs are stored on graph creation, and on every structural revision (M5: `graph_revisions`),
  so how a plan changed over time is auditable.
