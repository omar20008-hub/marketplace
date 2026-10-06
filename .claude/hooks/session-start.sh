#!/bin/bash
# Cloud sessions only: install gstack (required by CLAUDE.md / check-gstack.sh)
# and the project's npm dependencies so lint, typecheck and tests can run.
set -euo pipefail

# Run in the background so the session starts at once; Skills and npm scripts
# are usable once this finishes (a minute or two on a fresh container).
echo '{"async": true, "asyncTimeout": 300000}'

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

GSTACK_DIR="$HOME/.claude/skills/gstack"

# gstack: clone once, fast-forward on later runs, then register its skills.
if [ ! -d "$GSTACK_DIR/.git" ]; then
  mkdir -p "$HOME/.claude/skills"
  git clone --depth 1 https://github.com/garrytan/gstack.git "$GSTACK_DIR"
else
  git -C "$GSTACK_DIR" pull --ff-only --quiet || echo "gstack: update skipped"
fi
(cd "$GSTACK_DIR" && ./setup --team) || echo "gstack: setup failed; skills may be unavailable" >&2

# Project dependencies (postinstall runs `prisma generate`).
cd "${CLAUDE_PROJECT_DIR:-.}"
npm install --no-audit --no-fund
