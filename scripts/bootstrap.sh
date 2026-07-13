#!/usr/bin/env bash
# Bootstrap script for my-pi (~/.pi/agent).
# Idempotent: safe to re-run. See INSTALL.md for the full guide.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXPECTED_PATH="$HOME/.pi/agent"

bold()  { printf "\033[1m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
yellow(){ printf "\033[33m%s\033[0m\n" "$*"; }
red()   { printf "\033[31m%s\033[0m\n" "$*"; }

bold "==> my-pi bootstrap"
echo "    repo: $REPO_ROOT"

# 1. Path check ---------------------------------------------------------------
if [[ "$REPO_ROOT" != "$EXPECTED_PATH" ]]; then
  yellow "warning: repo is not at $EXPECTED_PATH"
  yellow "         pi reads ~/.pi/agent. Symlinking is fine, but clone there for simplicity."
fi

# 2. Required tool availability checks ---------------------------------------
bold "==> Checking required tools"

require() {
  local name="$1" version_cmd="$2" min="$3"
  if ! command -v "$name" >/dev/null 2>&1; then
    red "  ✗ $name not found (required: $min)"
    MISSING=1
    return
  fi
  local v
  v="$(eval "$version_cmd" 2>/dev/null || echo "?")"
  green "  ✓ $name $v"
}

MISSING=0
require node "node -v"  ">=22.19"
require pnpm "pnpm -v"  ">=10.24"
require git  "git --version | awk '{print \$3}'" "any"
require gh   "gh --version | head -n1 | awk '{print \$3}'" "any"

# Soft-check pi itself
if command -v pi >/dev/null 2>&1; then
  green "  ✓ pi $(pi --version 2>/dev/null || echo '(version unknown)')"
else
  red "  ✗ pi not found — install with: npm i -g @earendil-works/pi-coding-agent"
  MISSING=1
fi

# Optional CLIs (warn only)
bold "==> Optional CLIs (skill-specific, warnings only)"
for opt in ctx7 gw ffmpeg yt-dlp peekaboo; do
  if command -v "$opt" >/dev/null 2>&1; then
    green "  ✓ $opt"
  else
    yellow "  · $opt (missing — used by some skills)"
  fi
done

if [[ "$MISSING" == "1" ]]; then
  red "Resolve the missing required tools, then re-run this script."
  exit 1
fi

# 3. Install dependencies -----------------------------------------------------
bold "==> Installing root dependencies (pnpm install)"
(cd "$REPO_ROOT" && pnpm install)

if [[ -f "$REPO_ROOT/extensions/package.json" ]]; then
  bold "==> Installing extensions workspace"
  (cd "$REPO_ROOT/extensions" && pnpm install)
fi

# 4. Sync agents into ~/.pi/agent/agents -------------------------------------
bold "==> Syncing agent definitions"
node "$REPO_ROOT/scripts/sync-agents.mjs" --force

# 5. Scaffold environment files from templates -------------------------------
bold "==> Scaffolding environment files (if missing)"
scaffold() {
  local target="$1" template="$2"
  if [[ -e "$target" ]]; then
    green "  · $target (exists, left untouched)"
  elif [[ -f "$template" ]]; then
    cp "$template" "$target"
    green "  ✓ created $target from template — edit it before launching pi"
  fi
}
scaffold "$REPO_ROOT/.env"              "$REPO_ROOT/.env.example"
scaffold "$REPO_ROOT/extensions/.env"   "$REPO_ROOT/extensions/.env.example"

# 6. Final notes --------------------------------------------------------------
bold "==> Done"
cat <<EOF

Next steps:
  1. Fill in extensions/.env (PI_STORAGE_OWNER / PI_STORAGE_REPO) if you use upload-image-url.
  2. Make sure Claude Code has your MCP servers registered (the bridge reuses them).
  3. Launch:  cd ~/.pi/agent && pi
  4. On first launch, sign in to the default provider (openai-codex per settings.json).

See INSTALL.md for the full reference.
EOF
