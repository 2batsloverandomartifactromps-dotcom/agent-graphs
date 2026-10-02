# Self-evolution (optional)

> **Off by default.** Graphs, templates, and briefings can improve from their own execution
> history, but only through gated, audited, reversible edits. E1 (learn) ships with the MVP;
> E2–E4 land in M5–M6 ([PLAN §7](PLAN.md#7-roadmap)).

Agent Graphs already turns procedural knowledge (what to do, in what order, under which
conditions, and how to tell it is done) into an explicit, auditable structure. Recent work shows
that such structures can **learn from their own traces**. This document specifies how Agent
Graphs does that safely.

- [1. Research basis](#1-research-basis)
- [2. Findings → design rules](#2-findings--design-rules)
- [3. Mapping Procedural Graphs onto Agent Graphs](#3-mapping-procedural-graphs-onto-agent-graphs)
- [4. Modes](#4-modes)
- [5. What may evolve](#5-what-may-evolve)
- [6. Procedural knowledge on edges](#6-procedural-knowledge-on-edges)
- [7. Lessons (E1)](#7-lessons-e1)
- [8. The evolver and proposals (E2)](#8-the-evolver-and-proposals-e2)
- [9. Validation and the gate (E2–E3)](#9-validation-and-the-gate-e2e3)
- [10. Templates, lineage, and reliability (E3)](#10-templates-lineage-and-reliability-e3)
- [11. Step-level guidance and preplay (E4)](#11-step-level-guidance-and-preplay-e4)
- [12. Safety and governance](#12-safety-and-governance)
- [13. Additions to the model, API, protocol, and UI](#13-additions-to-the-model-api-protocol-and-ui)
- [14. Phasing and acceptance](#14-phasing-and-acceptance)
- [15. Measuring the evolution system itself](#15-measuring-the-evolution-system-itself)

---

## 1. Research basis

**Primary.** *Procedural Graphs: Self-Evolving Execution Structures for LLM Agents*: Yuxing Lu,
Yicheng Chen, Shanchan Wu, Sercan Ö. Arık. arXiv:2609.09153, 8 Sep 2026.

- **Problem.** Most agents choose actions by unconstrained generation over an ever-growing
  history. As trajectories lengthen, they lose track of objectives, invoke tools out of order, and
  repeat unproductive actions.
- **Representation.** A *Procedural Graph* stores procedural knowledge as
  `(procedure, relation, procedure)` triplets, the way a knowledge graph stores facts.
  - Relations: `LEADS_TO`, `TRIGGERS`, `PROVIDES_INPUT_FOR`, `CONVERGES_TO`.
  - Edges carry three attributes: **condition** (when the transition applies), **guidance** (how
    to execute the next step), and **pitfalls** (errors and dead ends to avoid). Guidance is the
    most consistently populated of the three.
- **Runtime.** A per-step guidance runtime localizes the agent in the graph (by its last action)
  and turns the local neighborhood into step-level guidance for the next turn.
- **Self-evolution.** An offline, gated **refiner** contrasts failed and successful trajectories
  and edits the graph's topology and attributes. It **commits an edit only if held-out
  validation performance is preserved or improved**, and **keeps rejected edits in memory** to
  discourage repeating them.
- **Results** (as reported in the abstract and HTML).
  - Seven benchmarks: HotpotQA, MultiChallenge, GDPval, ALFWorld, τ-bench, BFCL, EnterpriseArena.
  - First or joint first in 21 of 24 model–benchmark settings. Against the strongest baseline in
    each setting: 19 wins, 2 ties, 3 losses.
  - Starting from a **minimal skeleton**, the loop builds graphs that match or surpass
    hand-designed ones, and it can **repair a flawed expert prior**.
  - Example: EnterpriseArena survival with Gemini 3.1 Pro rose from 6% to 34%.

> **Sources.** `arxiv.org` was not reachable from the build environment's network policy. The
> details above come from the abstract (via search) and two independent open-source
> reimplementations: `vikm2o/proceduralgraph` (Apache-2.0) and
> `paulbruffett/agentic-procedural-graphs` (MIT). We implement our own design and copy no code.
> Re-check against the paper when access allows.

The reimplementations describe Algorithm 1 like this:
- **Guidance.** The guidance step localizes by exact match on the last action and serializes the
  2-hop neighborhood (the whole graph when matching fails) plus the last 3 steps. Guidance is
  injected for that turn only.
- **Refiner.** The refiner sees a batch of traces ordered high-score first. It returns one batch
  of `add/delete` node and edge edits; a revision is a delete followed by an add.
- **Checks.** Structural checks (known types, valid endpoints, cycle policy, every node reaches
  a terminal) run before validation.
- **Gate.** The gate accepts if the validation score is **≥** the incumbent's (ties accepted).
- **Rounds.** Up to 10 rounds. Duplicates of rejected edits are refused without validation.
- **Overfitting.** One reimplementation observed **validation overfitting** on HotpotQA:
  validation rose from 0.70 to 0.77 over five rounds while the test score did not move.

**Related work**

| Work | Key idea | What we adopt |
|---|---|---|
| **ProPlay** (arXiv:2606.12780, 2026) | A procedure graph whose transitions carry *reliability records*. Before each episode, the agent rehearses a task-specific path that is injected as **soft guidance, not a hard constraint**. After execution, the graph is refined. | Reliability stats on edges and nodes; preplay (E4); evolved knowledge enters as guidance only |
| **AgentStream** (arXiv:2608.00155, 2026) | Evaluates self-evolving agents under task streams (isolated, sequential, interleaved). Reliability varies by scenario, the benefit is gated by model capability and is **non-monotonic in model strength**, and **no single method dominates**. | Evolution is optional, pluggable, measured per model tier and scenario, and easy to revert |
| **Self-Evolving Coding Agents** survey (arXiv:2608.03392, 2026) | Coding agents improve by updating their framework, memory, skills, tools, models, or collaboration structures from prior interactions | Our scopes (§5) map onto these dimensions |
| **ACE**, Agentic Context Engineering (2025) | Contexts as evolving *playbooks*, built by a generator, a reflector, and a curator. Itemized **incremental delta updates** avoid brevity bias and context collapse. | Itemized lessons, delta updates, helpful/harmful counters |
| **GEPA** (2025) | Reflective prompt evolution from natural-language trajectory analysis, with Pareto-front candidate selection; sample-efficient compared with RL | Reflection-driven prompt deltas; multi-objective selection |
| **Darwin Gödel Machine** (2025), **ADAS** (2024) | An archive of agent variants, open-ended exploration, empirical validation instead of proofs. DGM reports objective-hacking incidents and argues for sandboxing and oversight. | Version lineage (an archive), rollback, protected fields, human oversight |
| **AFlow** (2024) | Search over code-represented workflows (MCTS) with execution feedback | Topology edits validated by execution |
| **Agent Workflow Memory** (2024), **ExpeL** (2023), **ReasoningBank** (2025), **Reflexion** (2023) | Induce reusable workflows and insights from experience. Contrast successes with failures. Verbal self-reflection after failure. | Lessons from failed→passed contrasts; loop feedback (already in core) |

## 2. Findings → design rules

| # | Finding | Design rule in Agent Graphs |
|---|---|---|
| R1 | Explicit procedural structure beats unconstrained generation over long horizons (PG) | The graph stays the agent's source of truth; briefings ground each attempt in it ([concepts §12](concepts.md#12-context-resilience)) |
| R2 | Local context (neighborhood plus recent steps) is enough to guide well (PG runtime) | Briefings are **local and budgeted**: the node plus a 2-hop neighborhood (inputs *and* downstream consumers), not the whole graph |
| R3 | Transitions carry the know-how: condition, guidance, pitfalls (PG §3.1) | Edges get `condition`, `guidance`, and `pitfalls` attributes (§6). They are rendered in briefings and are the primary target of evolution. |
| R4 | Contrasting failed and successful traces yields targeted edits (PG, ExpeL, ReasoningBank) | The evolver's input packet is contrastive: traces sorted by score, highest first |
| R5 | Commit only when held-out validation does not drop, ties accepted (PG) | The gate rule (§9): `candidate ≥ incumbent`, plus constraints |
| R6 | Remembering rejected edits prevents repeats (PG) | Rejection memory: rejected proposals are kept, deduplicated by canonical hash, refused without validation, and shown to the evolver |
| R7 | Graphs can grow from a minimal skeleton and repair flawed expert priors (PG) | Templates may start minimal. Human-authored templates are not sacred, but changes go through the same gates. |
| R8 | Validation sets get overfit (reimplementation observation) | Rotating validation splits, a never-shown test split, periodic test audits, round caps, small edits |
| R9 | Benefits vary by model and scenario; no method dominates (AgentStream) | Off by default; per-graph opt-in; stratified metrics; one-click revert and kill switch |
| R10 | Incremental deltas beat monolithic rewrites (ACE) | Lessons and prompt edits are itemized deltas, never wholesale regeneration |
| R11 | Learned knowledge works best as soft guidance (ProPlay) | Evolution writes guidance, checklists, and prompt deltas. **Aims, guards, and policies stay human-owned.** |
| R12 | Self-modifying systems can hack their objectives (DGM) | Protected fields, independent validation, and audit with lineage (§12) |

## 3. Mapping Procedural Graphs onto Agent Graphs

| Procedural Graphs | Agent Graphs |
|---|---|
| Procedure node (tool, reasoning step, task status) | **Node** (task, gate, milestone): a *macro* procedure. Optional **in-node procedure** steps are *micro* procedures (E4). |
| Relations `LEADS_TO`, `TRIGGERS`, `PROVIDES_INPUT_FOR`, `CONVERGES_TO` | Edge **`relation`** label (§6). Scheduling semantics stay in `kind` (`requires` / `informs`). Loop back-edges are `triggers`. |
| Edge attributes condition / guidance / pitfalls | The same three edge attributes |
| Per-step guidance from a localized 2-hop neighborhood | **Briefing** (2-hop, budgeted) at claim time. **Heartbeat guidance** keyed by `stepKey` (E4). |
| Trace with outcome score | Attempts with evaluations, metrics, notes, usage, `feedbackIn`, and durations. **Already recorded** by the core engine. |
| Offline refiner | **`evolver`** orchestrator role with the `evolve` capability |
| `add/delete` node and edge edits | **Edit DSL** (§8.3), a superset with attribute and loop operations |
| Structural checks | The spec validator ([spec §8](spec-format.md#8-validation)), plus terminal reachability and protected-field checks |
| Held-out validation and gate (≥, ties accepted) | **Validation ladder** and **gate** (§9) |
| Rejection memory | Proposals with `status: rejected` (the tabu list) |

## 4. Modes

Graph-level `evolution.mode` (templates have their own):

| Mode | What happens | Risk |
|---|---|---|
| `off` *(default)* | Nothing beyond normal loop feedback | — |
| `learn` | **Lessons** are captured from failed→passed contrasts and retrieved into briefings. Edge `guidance` and `pitfalls` can be appended as *soft* guidance on the live graph. No structural changes. | Low |
| `propose` | `learn`, plus the **evolver** proposes edits (structure, prompts, checklists, executor hints). They go through the validation ladder and **require approval** (human, or an orchestrator with `resolve`). | Medium, human-gated |
| `auto` | `propose`, plus edits in the allowed `scope` that **pass the gate are committed automatically**. Protected fields still require humans. | Higher; requires validation suites (E3) |

## 5. What may evolve

`evolution.scope` lists which classes may change. Ordered from least to most risky:

| Scope | Examples |
|---|---|
| `guidance` | Edge `condition`, `guidance`, `pitfalls`; lessons |
| `checklists` | Add, reword, or retire checklist items ("regenerate OpenAPI before submit") |
| `prompts` | Itemized deltas to node prompt or purpose (append a clarification, replace a sentence) |
| `executor` | Recommended model or thinking per node, based on cost and first-pass yield |
| `topology` | Add or remove nodes, edges, and loops; split a node; insert a verification node; change `maxAttempts` or `maxIterations` |

**Protected (never automatic):**
- aims (targets, comparators, evaluators, `terminating`)
- guard aims
- policies (including evaluation independence)
- validation suites
- the **evolution gate's** configuration (its objective weights, constraints, and sample
  minimums)
- the `evolution` settings

An edit that touches these always requires human approval. Loosening a target is the easiest way
to "improve" a score, so it is never automatic (R12). Node `gate:` blocks are not protected
fields, but changing them belongs to the `topology` scope.

## 6. Procedural knowledge on edges

These edge attributes are useful with or without evolution:

```yaml
- key: implement-api
  needs:
    - key: db-schema
      relation: provides_input_for          # leads_to | triggers | provides_input_for | converges_to
      condition: Migrations applied and generated types exported
      guidance: Import entity types from src/db/schema.ts instead of redefining them
      pitfalls: Do not change column names here; schema changes go through db-schema
```

- **Defaults** when `relation` is omitted:
  - `requires` → `leads_to`
  - `requires` into a milestone, or a gate with ≥ 2 inputs → `converges_to`
  - `informs` → `provides_input_for`
  - Loop back-edges → `triggers`
- **Briefings** render incoming edges' attributes under *Inputs* (direct prerequisites, 1 hop).
  Outgoing edges' attributes go under a new *Downstream consumers* section ("who uses your
  output, and what they need"), which reaches up to 2 hops. Together they form the local
  neighborhood of R2.
- Attributes are authored by humans, by agents (a `decision` or `handoff` can suggest them), or
  appended by `learn` mode. Each appended item carries provenance.

## 7. Lessons (E1)

A **lesson** is an itemized, reusable piece of procedural knowledge learned from experience.

```ts
type Lesson = {
  id: string;
  scope: { graph?: string; template?: string; nodeKey?: string; edge?: [string, string];
           tags?: string[]; kind?: NodeKind } | 'global';
  kind: 'guidance' | 'pitfall' | 'check';      // check: suggests a checklist item
  condition?: string;                          // when it applies
  content: string;                             // one or two sentences, imperative
  evidence: { failedAttempts: string[]; passedAttempts: string[]; notes?: string[] };
  source: 'worker' | 'evolver' | 'human' | 'import';
  counters: { applied: number; helpful: number; harmful: number };
  status: 'active' | 'retired';
  author: ExecutionAnnotation;
  createdAt: string; updatedAt: string;
};
```

- **Capture.** The server is still a ledger and never calls an LLM itself.
  - When a node **passes after one or more failed attempts or loop iterations**, the server
    creates a *lesson duty*. Two agents can fulfil it:
    - **The worker**: its submit response asks it to record what made the difference
      (`lesson_add`).
    - **The evolver**: the duty appears in its queue, and it records the lesson from the
      contrast between the failed and passed attempts.
  - Humans can add lessons from the UI. Findings can be promoted to lessons.
- **Retrieval.** Briefings get a **"Lessons & pitfalls"** section, below directives and above
  inputs, as part of the budgeted section list.
  - Ranking: scope match (edge > node key > template > tags/kind > global), then helpfulness
    `(helpful + 1) / (applied + 2)`, then recency.
  - The section is capped at about 10% of the budget and labelled with provenance and stats.
- **Counters.** Including a lesson in the briefing of a **claimed attempt** increments `applied`
  once, recorded in `lesson_applications`. UI previews never count.
  - The evolver (acting as reflector, like ACE) tags outcomes `helpful` or `harmful`.
  - The server also tracks passive pass rates with and without each lesson.
  - Lessons with `harmful > helpful` and `applied ≥ 5` are flagged for retirement.
- **Curation.** Only incremental operations are allowed: add, merge (on near-duplicates), reword
  (as a new version), retire. There is never a wholesale rewrite (R10). Every operation is an
  event.

## 8. The evolver and proposals (E2)

### 8.1 The `evolver` role
An orchestrator with role `evolver` and capability `evolve`. It runs on these triggers:

| Trigger | When |
|---|---|
| **Online** (inside a run) | Loop iterations, exhaustion escalations, repeated findings with the same cause, guard violations |
| **Harvest** (end of a run) | The graph completed or failed. Lessons and edits are proposed back to the source template. |
| **Offline rounds** (across runs) | Scheduled or manual. Each round contrasts a template's run history. |

### 8.2 Evolution packet
The evolver's briefing contains:
- The objective and incumbent scores.
- The procedural graph: the live spec, or the template version, in compact form.
- **Contrastive traces**: for the targeted nodes, attempts sorted by score from highest to lowest,
  truncated to budget (R4).
- **Rejection memory**: rejected proposals with their reasons.
- Active lessons.
- The protected-field list.
- The edit DSL.

### 8.3 Edit DSL
A proposal is a list of typed operations, validated as one batch:

| Op | Payload |
|---|---|
| `add_node` / `delete_node` | Node spec / key |
| `add_edge` / `delete_edge` | `{from, to, kind, relation?, condition?, guidance?, pitfalls?}` (in a spec, an edge is identified by `from`, `to`, and `kind`) |
| `set_edge_attributes` | `{from, to, kind, condition?, guidance?, pitfalls?, mode: append | replace}` |
| `set_node_field` | `{key, field: prompt | purpose | checklist | executor | maxAttempts | priority, delta}` |
| `add_loop` / `delete_loop` / `set_loop` | Loop spec / key / `{maxIterations, onExhausted}` |
| `add_lesson` / `merge_lessons` / `retire_lesson` | Lesson payloads |

As in PG, a *revision* may be expressed as delete plus add. The server normalizes, so equivalent
edit sets hash the same.

### 8.4 Proposal lifecycle
Statuses match `PROPOSAL_STATUSES` and [data-model](data-model.md#self-evolution-tables-optional-self-evolutionmd):
```
proposed → checking (structural + protected) ──► refused   (same hash as a rejected proposal)
         → validating (ladder) → awaiting_approval (when required) → committed ──► reverted
                                                                   └──► rejected ──► rejection memory
```
After a commit, monitoring watches for regressions and auto-reverts (→ `reverted`). An edit that
was reverted may be proposed again; one that was *rejected* may not.
A proposal records:
- `target`: a live graph revision or a template version
- `ops`
- `rationale`
- `evidence`: attempt ids, high and low scorers
- `expectedEffect`
- `riskClass`
- `canonicalHash`
- `validation[]` and `decision`
- the author's annotation

A commit creates a new graph revision or template version. A revert restores the previous one
and records both as events.

## 9. Validation and the gate (E2–E3)

**Ladder.** Stages run in order and are configurable per scope; every stage leaves evidence.

1. **Structural** (always): the patched spec passes full validation, every node still reaches a
   sink, and no protected field is touched (or approval is required if one is).
2. **Counterfactual screen** (cheap): an independent judge model replays the *failed* traces with
   the candidate guidance in place and scores "would this likely have prevented the failure?"
   It is used to discard weak proposals early, never as the only evidence for `auto`.
3. **Replay** (E3): run the template on its **evaluation suite's validation split**. Small,
   automatically scored tasks are executed by the runner (M6) or by CI, and the results are
   reported through the API.
4. **Live A/B** (templates, E3): new graph instances are split between incumbent and candidate
   until each arm has `minRuns`, then compared on the objective.
5. **Human approval**: always for protected fields. Configurable for `topology` and `prompts`.

**Objective** (`evolution.objective`, defaults shown):

| Signal | Weight | Notes |
|---|---|---|
| Graph success (completed, terminating aims met) | 0.40 | |
| First-pass yield (activations passing on attempt 1) | 0.25 | The process-quality signal |
| Loop iterations per loop entry (inverse) | 0.10 | |
| Human interventions per run (inverse) | 0.10 | Escalations, blockers, rejections |
| Cost per run (inverse, normalized) | 0.10 | |
| Wall time per run (inverse, normalized) | 0.05 | |

Hard constraints: no regression beyond tolerance on guard metrics (cost and time) or on open
high-severity findings.

**Gate.** Accept if `score(candidate) ≥ score(incumbent)` (ties accepted, R5), every constraint
holds, and sample-size minimums are met. Otherwise, reject into the rejection memory with
reasons.

**Overfitting controls** (R8):
- Validation splits rotate every K rounds.
- A test split is never shown to the evolver; test audits run every N commits, and a widening
  validation-test gap pauses `auto`.
- At most `maxRounds` per cycle (default 10).
- At most `maxOpsPerProposal` (default 5).
- Topology edits must improve or tie on two splits.

**Stratification** (R9): scores are recorded per executor model tier and scenario. A commit can
be limited to the tiers where it validated.

## 10. Templates, lineage, and reliability (E3)

- A **template** is a reusable procedural graph (a spec). **Basic templates ship in M5**: store a
  spec and instantiate graphs from it. **E3 adds versions**. Graph instances record their template
  version, so every run is a trace for its version.
- **Lineage** is a tree of versions (an archive, as in DGM and ADAS) with scores, decisions,
  diffs, and authorship (human or evolver). The default for new instances is the best gated
  version; exploration can select parents by score plus novelty. Revert takes one click.
- **Reliability records** (ProPlay): per-edge and per-node statistics across a template's runs.
  They cover pass contribution, mean attempts, iteration counts, cost, and common failure
  reasons. They feed the evolver, preplay, and an optional *reliability view* on the canvas
  (edge opacity and width).

## 11. Step-level guidance and preplay (E4)

- **Node procedures** (optional): a micro procedural graph inside a task, made of steps (`key`,
  `title`, `kind: tool | reasoning | status`, `required?`) connected by the four relations, with
  the same edge attributes. Agents report `stepKey` in heartbeats.
  - The server localizes the step by exact match and returns **next-step guidance**: the step's
    2-hop neighborhood with condition, guidance, and pitfalls. When there is no match, it returns
    the whole procedure (PG runtime).
  - Required steps act as checklist items. The evolver refines procedures from step traces.
- **Preplay** (ProPlay): on claim, a task-specific path through the template's graph is computed
  from reliability records and failure lessons. It is shown in the briefing as *suggested
  path*, which is soft guidance.

## 12. Safety and governance

- **Opt-in** per graph and per template. The kill switch (`mode: off`) takes effect immediately.
- **Protected fields** (§5) and **independent validation**: the evolver cannot score its own
  proposals. Judges are independent sessions or humans, as with aims.
- **Budgets**: `evolution.budget` (cost and tokens), proposal rate limits, and round caps.
- **Full audit**: every lesson operation, proposal, validation, gate decision, commit, and revert
  is an event in the hash chain, with diffs and evidence.
- **Monitoring**: committed edits are watched for M runs or activations and auto-reverted on
  regression.
- **Provenance in briefings**: evolved guidance is labelled (source, version, helpfulness), so
  agents and humans can tell learned advice from authored instructions. Directives still take
  precedence over everything.

## 13. Additions to the model, API, protocol, and UI

| Area | Additions |
|---|---|
| Spec ([spec-format](spec-format.md)) | Edge long-form fields `relation`, `condition`, `guidance`, `pitfalls`; top-level and template `evolution` block; node `procedure` (E4) |
| Data ([data-model](data-model.md)) | `edges` columns for relation and attributes; tables `lessons`, `lesson_applications`, `evolution_proposals`, `evolution_validations`, `templates`, `template_versions`, `eval_suites`, `eval_runs`; event families `lesson.*`, `proposal.*`, `template.*`, `eval.*` |
| API ([api](api.md)) | `/lessons` (+ duties), `/graphs/{g}/edges/{id}/attributes`, `/graphs/{g}/evolution` (status, packet, proposals), `/evolution/proposals/{id}/…` (validate, decide, revert), `/templates/*` (versions, lineage, reliability), `/eval-suites`, `/eval-runs` |
| Protocol ([agent-protocol](agent-protocol.md)) | Briefing sections *Lessons & pitfalls* and *Downstream consumers*; the submit response may ask for a lesson; the evolver loop; MCP tools `lesson_add`, `lessons_search`, `evolution_queue`, `proposal_create`, `proposal_validate`, `eval_report` |
| UI ([ui](ui.md)) | An **Evolution** tab (lessons, proposals with diff and contrastive traces, validation ladder, lineage, rejection memory, settings); a lessons panel in the node inspector; edge attribute popovers; a reliability view |

## 14. Phasing and acceptance

| Phase | Ships in | Scope | Done when |
|---|---|---|---|
| **E1 Learn** | MVP (M1–M3) | Edge attributes and relations; `evolution` policy; lessons (capture duties, `lesson_add`, retrieval, counters); briefing sections; UI lessons panel | A notes-app simulation with a failure-cycle produces a lesson that appears in the next briefing with provenance; counters update; everything is evented |
| **E2 Propose** | M5 | Evolver role; edit DSL; proposals; structural and counterfactual stages; human approval; rejection memory; Evolution tab | A seeded repeated failure yields a proposal, approving it applies it as a new revision, rejecting it blocks an identical re-proposal, and revert works |
| **E3 Auto** | M6 | Templates and lineage; evaluation suites; replay via the runner or CI; live A/B; the gate; auto-commit; overfitting controls; stratification; reliability records | On a synthetic template with a known flaw, rounds repair it under the gate without touching protected fields; the validation-test gap is reported |
| **E4 Steps** | M6+ | Node procedures; heartbeat step guidance; preplay | A heartbeat with `stepKey` returns localized guidance; the suggested path appears in briefings |

## 15. Measuring the evolution system itself

Following AgentStream, evolution is evaluated on **streams of runs**, not single tasks:
- isolated, sequential, and interleaved streams of graphs from the same and from different
  templates
- reported per model tier

Tracked over time:
- first-pass yield and cost per run
- proposals by status (proposed, accepted, rejected, reverted)
- regressions caught by monitoring
- the validation-test gap
- the share of briefing tokens spent on lessons

If evolution does not pay for itself on a stream, the right setting is `off`.
