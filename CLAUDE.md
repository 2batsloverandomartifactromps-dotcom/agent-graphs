# CLAUDE.md: working on Agent Graphs

Agent Graphs is a platform for constructing, running, monitoring, and auditing execution graphs
for agent-orchestrated software builds. The MVP (milestones M1–M4, plus learn mode E1) is built.
Remaining work follows [docs/build-graph.yaml](docs/build-graph.yaml), [docs/PLAN.md](docs/PLAN.md) (M5+), and
[docs/HANDOFF.md](docs/HANDOFF.md).

## Read first
1. [docs/PLAN.md](docs/PLAN.md): goals, decisions, roadmap.
2. [docs/concepts.md](docs/concepts.md): **normative semantics**. When code and docs disagree,
   the docs win. Change the docs in the same PR only when the change is intentional.
3. The doc for your area: [spec-format](docs/spec-format.md), [data-model](docs/data-model.md),
   [api](docs/api.md), [agent-protocol](docs/agent-protocol.md), [ui](docs/ui.md) (plus
   [the mockup](docs/design/ui-mockup.html)), [architecture](docs/architecture.md),
   [self-evolution](docs/self-evolution.md), [licensing](docs/licensing.md).

## Working from the build graph
- Find your node in `docs/build-graph.yaml`. Its `prompt`, `aims` (acceptance criteria),
  `deliverables`, and graph `constraints` are your instructions. Inputs come from the nodes in its
  `needs`.
- Before the server exists (M2), report proof in your PR description: the exact commands, their
  exit codes, and the metric values the node's aims ask for (for example `test_pass_rate`,
  `coverage`). After M2, report through the platform itself.
- Deviating from the docs requires updating them and explaining why (a "decision" section in the
  PR).

## Commands
```bash
pnpm install          # workspace install (the cloud session hook runs this automatically)
pnpm dev              # server :4747 (tsx watch) + web :5173 (Vite, proxies /api, /health, /mcp)
pnpm check            # lint + typecheck + licenses + tests: run before every commit
pnpm test             # vitest (all projects)    · pnpm vitest run <path> for one file
pnpm typecheck        # tsc per package (TypeScript 7 native compiler)
pnpm lint             # biome check              · pnpm lint:fix to apply safe fixes
pnpm check:licenses   # dependency license gate (docs/licensing.md)
pnpm build            # builds the web app (other packages run from TS sources)
node packages/cli/bin/agraph.js --help   # CLI from source
```

## Conventions
- **TypeScript 7** (native `tsc`): don't add tools that need the legacy compiler JS API.
  `module: preserve` + `moduleResolution: bundler`. Workspace packages export their `src/*.ts`
  directly; there is no build step between packages.
- **Package boundaries**: `packages/core` is **pure**. No I/O, and no `node:` imports in `src/`
  (tests may use them). `core` depends only on zod and yaml. `sdk` → core; `mcp` → sdk;
  `server` → core and mcp; `web` → core and sdk.
- **One schema source**: zod 4 schemas in `@agent-graphs/core` drive types, validation, OpenAPI,
  JSON Schema, and MCP tool inputs. Closed vocabularies live in
  `packages/core/src/vocabulary.ts` and must match `docs/concepts.md`.
- **Engine shape**: pure functions `(state, input, ctx) → { effects, events, result }`, with an
  injected clock and id generator. Every transition is table-tested, and the concepts §15
  invariants are property-tested.
- **Server**: thin Hono routes → commands (one transaction each) → engine → repositories. Every
  state change writes events (hash-chained) in the same transaction. The server never calls LLMs.
- **Style**: Biome formatting (2 spaces, single quotes, semicolons, trailing commas, 100
  columns). Tests sit next to the source as `*.test.ts`, or in a package's `test/` folder.
- **UI**: match the mockup's look and the tokens in `docs/ui.md` §6. Write shadcn-style
  components by hand on `radix-ui` (the shadcn registry isn't reachable from cloud sessions).
  Status is never shown by color alone.
- **Self-evolution** is optional and off by default. Never let automatic edits touch protected
  fields: aims, guards, policy, validation suites, the evolution gate's configuration, or the
  evolution settings.

## Dependencies and licensing
- The project is proprietary (Copyright A2A Adventures, all rights reserved; packages are
  `UNLICENSED` and private). **Only permissively licensed dependencies are allowed**, so any
  future license stays possible.
  Check before adding (`npm view <pkg> license`), then run `pnpm check:licenses`.
- Never add GPL, AGPL, LGPL, SSPL, BUSL, EPL-only, or non-commercial packages. `elkjs` was
  rejected for this reason; use `@dagrejs/dagre` for layout.
- MPL-2.0 and CC-BY-4.0 are tolerated only as unmodified, never-distributed build tooling
  (`lightningcss` via Vite and Tailwind; `caniuse-lite`).

## Environment notes (cloud sessions)
- `better-sqlite3` is a native module. pnpm is allowed to build it (`onlyBuiltDependencies` in
  `pnpm-workspace.yaml`).
- Playwright: use the pre-installed Chromium (`executablePath: '/opt/pw-browsers/chromium'`).
  Never run `playwright install`.
- Never commit `data/`, `*.sqlite`, `.env*`, or secrets.
