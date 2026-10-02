#!/bin/bash
# SessionStart hook for Claude Code cloud sessions: installs workspace dependencies so lint,
# typecheck, tests and the license gate work immediately. Synchronous on purpose (no race with
# the first command). Idempotent; does nothing outside cloud sessions.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable >/dev/null 2>&1 || npm install -g pnpm@10.28.0 >/dev/null 2>&1
fi

# `install` (not `--frozen-lockfile`) so a slightly stale lockfile on a branch doesn't block the
# session; the cached container keeps the store warm across sessions.
pnpm install --prefer-offline --reporter=silent

echo "agent-graphs: dependencies installed. Run \`pnpm check\` (lint, typecheck, licenses, tests)."
