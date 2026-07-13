# Installation

This guide reproduces the **`Jonghakseo/my-pi`** environment on a fresh macOS machine.
After completing it, you should have the same `pi` TUI, the same 9 agents, all
remote-tracked skills, the local extension workspace, and the MCP bridge wired into
Claude Code.

> Linux works too if you skip macOS-specific items (Ghostty, AppleScript-based skills,
> Peekaboo). Windows is not supported.

---

## 1. Prerequisites

Install these **before** cloning. Versions below are what the repo is developed against.

### Runtimes

| Tool | Version | Install |
|---|---|---|
| **Node.js** | `>=22.19` (tested on `22.19.0`) | `brew install node@22` or `mise use -g node@22` |
| **pnpm** | `>=10.24` (pinned via `packageManager`) | `corepack enable && corepack prepare pnpm@10.24.0 --activate` |
| **Python** | `>=3.10` | for `skills/skill-creator/scripts/validate_skill.py` |
| **Git** | any recent | `brew install git` |

### Required CLIs

```bash
# pi itself (the TUI this repo configures)
npm i -g @earendil-works/pi-coding-agent

# GitHub CLI (used by many agents and the open-pr extension)
brew install gh && gh auth login

# Claude Code — the MCP bridge extension re-uses its MCP server config
# https://docs.claude.com/claude-code
```

### Recommended / skill-specific CLIs

Skip any you don't use; the matching skill will simply no-op.

| CLI | Used by | Install |
|---|---|---|
| `ctx7` (Context7) | `skills/context7-cli` | `npm i -g @upstash/context7-mcp` (see skill) |
| `gw` (git-worktree helper) | `skills/gw-worktree-cleanup` | https://github.com/jonghakseo/gw |
| `ffmpeg`, `yt-dlp` | `fetch_content` video frames | `brew install ffmpeg yt-dlp` |
| `peekaboo` | `skills/peekaboo` | `brew install steipete/tap/peekaboo` |
| Ghostty | `bookmark` extension panel | https://ghostty.org |

---

## 2. Clone into the canonical path

pi reads its configuration from **`~/.pi/agent`**. The repo must live there.

```bash
# Back up an existing setup first if you have one.
mv ~/.pi/agent ~/.pi/agent.bak.$(date +%s) 2>/dev/null || true

git clone https://github.com/Jonghakseo/my-pi.git ~/.pi/agent
cd ~/.pi/agent
```

---

## 3. Run the bootstrap script

The script checks required CLI availability, installs dependencies, syncs agents, and scaffolds `.env` files.

```bash
./scripts/bootstrap.sh
```

It will:

1. Check that Node, pnpm, Git, GitHub CLI, and pi are available.
2. `pnpm install` at the repo root **and** inside `extensions/`.
3. Run `scripts/sync-agents.mjs` to copy `agents/*.md` into `~/.pi/agent/agents/`.
4. Create `.env` / `extensions/.env` from the templates if missing.
5. Print a checklist of any missing optional CLIs from §1.

Re-run it anytime; it is idempotent.

---

## 4. Secrets and per-user files

These are git-ignored — fill them in manually after bootstrap.

### `auth.json`
Created the first time you launch `pi` and pick a provider (Anthropic / OpenAI / Ollama).
You normally don't edit it by hand.

### `.env` (repo root)
Currently empty by default; add only what your own extensions need.

### `extensions/.env`
Used by `upload-image-url` extension:
```env
PI_STORAGE_OWNER=<github-username>
PI_STORAGE_REPO=<public-image-host-repo>
```

### `agents/.env.browser` (optional)
Only needed if you use the `browser` agent with persistent cookies.

---

## 5. MCP bridge (Claude Code reuse)

`settings.json` enables `@ryan_nookpi/pi-extension-claude-mcp-bridge`, which
**reuses** the MCP server list configured in your local Claude Code. You don't
register MCPs in pi separately — instead:

1. In Claude Code, add the MCP servers you want (Jira, Slack, Notion, GA4,
   BigQuery, etc.).
2. Launch `pi` once; the bridge will discover them and write
   `claude-mcp-bridge-cache.json` and `claude-mcp-bridge-tools.json` here.
3. Restart `pi` so the cached tool list is picked up.

---

## 6. Launch

```bash
cd ~/.pi/agent
pi
```

First launch will prompt you to sign in to the default provider
(`openai-codex` per `settings.json`). After that the TUI should look identical to
the screenshot in the [README](./README.md#usage-example).

---

## 7. What is *not* shipped in the repo

These are intentionally git-ignored — recreate or substitute if you want parity:

| Path | Why ignored | What to do |
|---|---|---|
| `auth.json` | provider tokens | created on first launch |
| `.env`, `extensions/.env`, `agents/.env.browser` | secrets | use the `.example` files |
| `sessions/`, `.data/`, `state/`, `.context/`, `cron/` | per-machine runtime data | left empty; pi recreates |
| `bin/`, `local-scripts/` | personal scripts | not portable |
| `extensions/until-presets/`, `extensions/usage-reporter/` | personal extensions | optional |
| `extensions/picky-handoff` | symlink to a separate repo | not required |
| Daily/weekly retro logs and stamp files | local cron output | safe to skip |

**Skills**: `.gitignore` excludes `skills/*` but keeps the ones already tracked
in git. Cloning gives you exactly the public skill set — no extra steps.

---

## 8. Troubleshooting

- **`pi` not found** → re-run `npm i -g @earendil-works/pi-coding-agent` and
  check `npm bin -g` is on your `PATH`.
- **`pnpm install` fails on `peerDependencies`** → make sure the global `pi`
  package is installed first; the root `package.json` declares
  `@earendil-works/pi-coding-agent` as a peer.
- **Agents missing in TUI** → run `node scripts/sync-agents.mjs --force`.
- **MCP tools missing** → confirm Claude Code has them registered, delete
  `claude-mcp-bridge-cache.json`, restart `pi`.
- **`extensions/` typecheck errors** → `cd extensions && pnpm typecheck`.
