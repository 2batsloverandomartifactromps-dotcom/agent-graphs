# Handoff: Agent Graphs

Checkpoint for the next orchestrator. It covers state, how to run things, open work, and
gotchas. A copy-paste prompt is at the end.

## State at checkpoint

- **Repository:** `https://github.com/2batsloverandomartifactromps-dotcom/agent-graphs.git`,
  branch `claude/youthful-rubin-rfskjz`. Develop and push only there; do not open PRs unless asked.
- **License:** proprietary (Copyright A2A Adventures). Dependencies must be permissive only;
  `pnpm check:licenses` gates this.
- **Built and tested:** M1 core, M2 server, M3 (SDK, CLI, MCP, Claude Code hooks, simulator),
  M4 web UI, and E1 learn mode.
- **Verification:**
  - `pnpm check` (lint, typecheck, licenses, tests) exits 0 with 367 tests.
  - Line coverage: core 94.7%, server 89%.
  - E2E: `pnpm -F @agent-graphs/web test:e2e` passes 7/7 against `agraph serve`, using the
    pre-installed Chromium.
  - GitHub CI was green on the last pushes.
- **Normative docs:** `docs/concepts.md` (semantics), then `docs/api.md`, `docs/agent-protocol.md`,
  `docs/ui.md`, `docs/data-model.md`, and `docs/architecture.md`. When code and docs disagree, the
  docs win. Intentional deviations are recorded in the docs. For example, PLAN D4 records that a
  small route registry replaced `@hono/zod-openapi`.

### Where things live

| Area | Path | Notes |
|---|---|---|
| Engine (pure) | `packages/core/src/engine/*` | `run(state, ctx, fn)` gives `{result, effects, events}`; invariants in `packages/core/test/invariants.test.ts` |
| Spec | `packages/core/src/spec/*` | Validate with `agraph graph validate -f <file>` |
| Briefings and sitreps | `packages/core/src/briefing/*` | |
| Evolution core | `packages/core/src/evolution/*` | DSL, gate, lessons; E2 proposal routes not built (M5) |
| Server | `apps/server/src/*` | Routes declared in `routes/define.ts` generate OpenAPI; `test/contract.test.ts` checks every documented endpoint |
| SDK | `packages/sdk` | `AgentGraphsClient`, `subscribe()` for SSE |
| MCP | `packages/mcp` | 36 tools, profiles; mounted at `/mcp`; stdio via `agraph mcp` |
| CLI | `packages/cli` | `node packages/cli/bin/agraph.js --help` |
| Simulator | `packages/simulator` | YAML scenarios; `agraph simulate`; `pnpm demo` |
| Web UI | `apps/web` | Served by the server from `apps/web/dist` (`pnpm build` first) |
| Claude Code integration | `integrations/claude-code/` | `agraph claude install --dir <repo>` |

## Running it

```bash
pnpm install && pnpm build                       # build the web UI so the server serves it at /
DATA_DIR=/tmp/ag node packages/cli/bin/agraph.js serve --port 4747
# UI: http://localhost:4747 · API: /api/v1 · OpenAPI: /api/v1/openapi.json · MCP: /mcp
node packages/cli/bin/agraph.js graph create -f examples/graphs/notes-app.yaml --start
node packages/cli/bin/agraph.js simulate examples/graphs/notes-app.yaml   # makes the UI come alive
```

## Open work, in priority order

### 1. Personal-site dogfood run (requested by the owner, in progress)

The owner asked for two things:
- verify the platform end to end by running a real graph;
- have that graph build them a personal website with a blog of non-obvious data science × AI ×
  math × physics posts, of excellent quality, accuracy, and cleverness.

The spec is ready and valid: `examples/graphs/personal-site.yaml`.
- Nodes: brief → design-system → site-scaffold → post-1..4 (in parallel) → integrate →
  launch-review (an orchestrator gate), with a `launch-fixes` loop.
- Output goes to `showcase/personal-site/`: a static site, KaTeX from a CDN, Node lab scripts with a
  seeded PRNG, and a no-dependency `build.mjs`.

Where it stopped:
- The run was started on a local server whose database lived in the old session's scratch space,
  which is gone. Recreate the graph from the spec.
- The first `brief` attempt was released at about 5% at the checkpoint. No site files exist yet.

How to run it (the protocol that was in use):
1. Start the server. Run `graph create -f examples/graphs/personal-site.yaml --start`.
2. Run `orch attach personal-site lead --actor agent=lead,model=…`, then
   `export AGENT_GRAPHS_SESSION=<lead session>`.
3. Attach `reviewer` with a **different** session. Judges must be independent of workers;
   independence is checked per session.
4. For each ready node, run `agraph --json --actor agent=<name>,model=<model> claim personal-site
   <node> --dispatched-by lead --budget 6000`. Give the subagent:
   - the attempt id;
   - the briefing (the `briefing` field of the JSON);
   - a worker protocol (below).
5. Workers report with `agraph hb/note/metric/submit <attempt>`. They must `unset
   AGENT_GRAPHS_SESSION`, so their notes keep their own identity.
6. Judge qualitative aims:
   - `correct` (evaluator `agent`): an independent subagent runs
     `POST /attempts/{id}/evaluations`. In local mode a fresh actor gets a fresh session.
   - `clever`, `slate-quality`, `distinctive`, `excellent`: run under the reviewer session.
   - The launch gate is approved by resolving its request under the reviewer session.
7. When the graph completes:
   - check that `GET /graphs/personal-site/audit/verify` is ok and `audit/gaps` is clean;
   - screenshot the UI showing the completed run;
   - commit `showcase/personal-site/` and push;
   - publish the built site for the owner to view.
8. The owner's name stays a placeholder in `showcase/personal-site/site.config.json`. Ask the owner
   before using real details.

Model note: the owner asked for "GPT 6.1 Sol / GPT 6 Astra / GPT 6 Luna" subagents. Those models
were not available in the Claude Code environment; only Claude models (opus, sonnet, haiku, fable)
can be dispatched. If your environment offers them, use them and annotate each claim's actor
truthfully. Otherwise use the strongest available models, and say which ones ran.

Worker protocol (give it to every dispatched worker):
- Heartbeat at least every 5 minutes. The lease is 30 minutes. Follow and ack any directives in
  heartbeat replies.
- Write `deliverable`, `decision`, `finding`, and `proof` notes with evidence.
- Report metrics as soon as they are measured. Tick required checklist items with `hb --tick`.
- Finish with `submit --summary … --metric …`. Use `--eval aim=met:…` only for self-judged aims.
  Use `fail` if the work cannot be completed.
- Never stop with an open attempt.
- Write only under `showcase/personal-site/`. Use no npm packages, and use a seeded PRNG.
- Every number in a post must come from its lab script's JSON output. References must be real
  primary sources.

### 2. Verify the UI against `docs/ui.md`

The M4 agent's final report was lost in a container restart. Its work was recovered, finished, and
merged, and the E2E suite passes. Screenshots are in `apps/web/e2e/screenshots/`; compare them with
`docs/design/screenshots/`. Audit `docs/ui.md` §4–§10 for anything unimplemented and fill the gaps.

### 3. M5: depth and hardening (`docs/PLAN.md` §7)

- Templates
- Proposals (E2): engine core exists in `packages/core/src/evolution`; routes and UI do not
- Search
- Groups
- Graph revisions
- Attachments
- Token-mode rate limiting

### 4. Hygiene

- Agent worktrees, if you use them, live under `.claude/worktrees/`. That path is ignored by git
  and biome. Merge the worktree branches, then remove the worktrees.
- Keep `pnpm check` green before every push. CI runs the same checks.

## Gotchas

- `pnpm exec biome check --write .` reflows long lines, so exact-match edits made from memory can
  miss. Re-read the file before editing.
- `packages/core/dist-schema/graph-spec.schema.json` is committed and checked by a test. Regenerate
  it with `pnpm -F @agent-graphs/core schema:json`. It is excluded from biome.
- Playwright: use `/opt/pw-browsers/chromium`. Never run `playwright install`.
- Local auth mode treats token-less requests as admin, so capability checks only bite in
  `AUTH_MODE=token`. Independence checks are per session and always apply.
- Orchestrator leases last 30 minutes. Heartbeat with `agraph orch heartbeat <graph> <key>` while
  dispatching.
- The engine mutates the loaded state in place. If a command throws, the server rolls back the
  transaction and discards the state. Never reuse state after an `EngineError`.
- Never commit `data/`, `*.sqlite`, `.env*`, the user's name or email, or secrets.

## Copy-paste prompt for the next orchestrator

```text
You are the orchestrator continuing "Agent Graphs", a platform for constructing, running,
monitoring, and auditing execution graphs for agent-orchestrated software builds.

Repo: https://github.com/2batsloverandomartifactromps-dotcom/agent-graphs.git
Branch: claude/youthful-rubin-rfskjz. Develop and push only there; no PRs unless asked.

Start by reading CLAUDE.md, then docs/HANDOFF.md (state, open work, protocols, gotchas), then
docs/concepts.md (normative semantics). Run `pnpm install && pnpm check`; expect exit 0 with about
367 tests.

Your priorities, in order:
1. Run the personal-site dogfood graph end to end (docs/HANDOFF.md §1), using the platform itself.
   - Start `agraph serve` and create the graph from examples/graphs/personal-site.yaml.
   - Attach as `lead`, and attach `reviewer` under a separate session.
   - Dispatch the strongest available models as workers via `claim --dispatched-by lead`.
     Give each one the attempt id, the briefing, and the worker protocol.
   - Have independent subagents judge `correct`, and the reviewer session judge `clever` and the
     other qualitative aims and approve the launch gate.
   - Drive the graph to `completed`. The deliverable is the owner's personal website in
     showcase/personal-site/: a static site with four excellent, accurate, non-obvious blog posts
     bridging data science, AI, math, and physics. Every number comes from seeded Node lab scripts;
     references must be real.
   - Verify: audit/verify ok, audit/gaps clean, and a screenshot of the completed graph in the UI.
   - Commit, push, and show the owner the built site.
   - The owner asked for GPT 6.x Sol/Astra/Luna models. If they are unavailable, say so and use
     the best available, annotating actors truthfully.
2. Audit the web UI against docs/ui.md and the mockup, and close the gaps.
3. Continue with M5 (templates, E2 proposals, search, groups) per docs/PLAN.md.

Rules: keep `pnpm check` green before every push. Only permissively licensed dependencies. Never
commit the owner's name or email, data/, *.sqlite, .env*, or secrets. Report proof (commands, exit
codes, metrics) when you finish each item.
```
