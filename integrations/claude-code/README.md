# Claude Code integration

Makes the [agent protocol](../../docs/agent-protocol.md) automatic in Claude Code: the MCP tools,
hooks that keep leases alive and restore context, and a skill that teaches the loops
(docs/agent-protocol.md §8).

| File | What it is |
|---|---|
| `mcp.json` | Example `.mcp.json`: the `agent-graphs` stdio MCP server (`agraph mcp`). |
| `settings.json` | Example `.claude/settings.json` hook entries (`agraph hook …`). |
| `skills/agent-graphs/SKILL.md` | The skill: worker, lead, and reviewer loops, note quality, resilience. |

## Set up a repository (about 5 minutes)

1. **Start a server** from this checkout (Node ≥ 22.12, after `pnpm install`):
   ```bash
   node packages/cli/bin/agraph.js serve          # http://127.0.0.1:4747, data in ./data
   ```
2. **Wire the target repository** (writes or merges `.mcp.json`, `.claude/settings.json`, and
   `.claude/skills/agent-graphs/SKILL.md`; safe to re-run, unrelated settings are kept):
   ```bash
   node packages/cli/bin/agraph.js claude install --dir /path/to/your/repo
   # options: --url http://host:4747 · --profile worker|orchestrator|evolver|all · --npx
   ```
   For a server in `AUTH_MODE=token`, create an agent token and export it before starting Claude
   Code: `agraph token create --name my-laptop --role agent` → `export AGENT_GRAPHS_TOKEN=…`.
3. **Create a graph** (or use an existing one):
   ```bash
   node packages/cli/bin/agraph.js graph create -f examples/graphs/minimal.yaml --start
   ```
4. **Start Claude Code** in the target repository, check `/mcp` lists `agent-graphs`, and ask:
   > Use the agent-graphs tools: claim the next ready node of graph `<slug>` and do it.

   Or use the MCP prompts: `/mcp__agent-graphs__work`, `…__orchestrate`, `…__review`, `…__plan`.

## What the hooks do

| Hook | Command | Behavior |
|---|---|---|
| `SessionStart` | `agraph hook session-start` | Records the Claude `session_id` (for the MCP server and, through `CLAUDE_ENV_FILE`, as `AGENT_GRAPHS_CLIENT_SESSION` for the CLI). After `compact` or `resume` it injects the briefing of each attempt you hold (the sitrep for orchestrator roles); on `startup` a one-line reminder; with no holdings and `AGENT_GRAPHS_GRAPH` set, a short sitrep. |
| `PostToolUse` | `agraph hook post-tool-use` | Throttled (≥ 60 s, decided in < 100 ms) session heartbeat by client session id: renews every lease of the session and its dispatched subagents, and surfaces new directives and pause/cancel requests as additional context. |
| `Stop` | `agraph hook stop` | Blocks stopping while the session tree holds a running attempt: "You hold attempt at_… on implement-api (graph …). Submit, fail, block, or release it (with a handoff) before stopping." Respects `stop_hook_active` and `AGENT_GRAPHS_STOP_POLICY` (`block`, `warn`, `off`). |
| `SubagentStop` | `agraph hook stop --subagent` | Warns (never blocks) about attempts dispatched from this session that are still open. |
| `PreCompact` | `agraph hook pre-compact` | Records `session.compacted`. |

Hooks fail open: if the server is unreachable or anything goes wrong they exit 0 silently, so
they never break a session.

### How sessions are matched
Claude Code passes `session_id` to hooks but not to MCP servers. The `SessionStart` hook stores
it per working directory (under `$AGENT_GRAPHS_STATE_DIR`, default `$TMPDIR/agent-graphs`), and
the MCP server attaches it to claims and attachments as `actor.clientSessionId`. Hook heartbeats
are keyed by the same id, so they renew exactly that session's leases (and its subagents').
Explicit values win: `AGENT_GRAPHS_CLIENT_SESSION`, or `clientSessionId` in a tool's `actor`. If
you run two Claude Code sessions in the same directory at once, pass the id explicitly.

## Environment
`AGENT_GRAPHS_URL` (server origin), `AGENT_GRAPHS_TOKEN`, `AGENT_GRAPHS_ACTOR`
(`model=claude-opus-5-5,thinking=high,mechanism=claude-code`), `AGENT_GRAPHS_GRAPH` (default
graph), `AGENT_GRAPHS_SESSION` (act as this Agent Graphs session, for orchestrator capabilities
in the CLI), `AGENT_GRAPHS_STOP_POLICY`, `AGENT_GRAPHS_HEARTBEAT_THROTTLE` (seconds),
`AGENT_GRAPHS_HOOK_TIMEOUT_MS`.

## Verify it
```bash
pnpm vitest run packages/cli/test/hooks.test.ts   # compaction re-injection, Stop blocking, throttling
pnpm vitest run apps/server/test/mcp.test.ts      # the MCP tools end to end, stdio and HTTP
```
