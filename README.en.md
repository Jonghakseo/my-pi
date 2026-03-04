<div align="center">

**English** | [한국어](./README.md)

# 🧠 my-pi

**A personal AI operating system built on [pi](https://github.com/mariozechner/pi-coding-agent)**

*10 specialized agents · 20+ extensions · one developer's opinionated setup*

<br/>

`🤖 10 Agents` &nbsp; `🧩 20+ Extensions` &nbsp; `🎨 5 Themes`

<br/>

> What if you treated your AI coding agent configuration as a **first-class engineering project**?
>
> This repo is the answer — a living, daily-driven configuration that transforms pi from a CLI tool into a multi-agent orchestration platform with specialized roles, safety guards, and deep customization.

</div>

---

## 🏗️ Architecture

<p align="center">
  <img src="./tmp/architecture.en.svg" alt="System Architecture" width="800"/>
</p>

The system is organized in **four layers**:

| Layer | Purpose |
|---|---|
| **User / pi TUI** | Interactive terminal interface |
| **Extensions** | 20+ TypeScript plugins — subagent management, voice I/O, MCP bridge, UI overlays, safety guards |
| **Agent Orchestra** | 10 purpose-built agents with distinct models and roles |
| **Infrastructure** | MCP tool integrations via [claude-mcp-bridge](./extensions/claude-mcp-bridge/) — reuses your existing Claude Code MCP setup (Jira, Slack, Gmail, Calendar, GA4, Figma, DB, etc.) |

---

## 🤖 Agent Orchestra

<p align="center">
  <img src="./tmp/agents.en.svg" alt="Agent Orchestra" width="800"/>
</p>

Ten agents, three models, one orchestrator. Each agent has a specific mandate, its own system prompt, and a model chosen for its strengths:

| Agent | Model | Role | When to Use |
|---|---|---|---|
| 🔍 **finder** | `gpt-5.3-codex-spark` | Fast file & code locator | Quick lookups, grep-like tasks |
| ⚡ **worker** | `gpt-5.3-codex` | General-purpose executor | Implementation, writing, fixes (complex multi-file) |
| 🏃 **worker-fast** | `gpt-5.3-codex-spark` | Lightweight simple executor | Single-file edits, quick changes |
| 📐 **planner** | `gpt-5.3-codex` | Implementation architect | Breaking down complex tasks |
| 🔎 **reviewer** | `gpt-5.3-codex` | Code review (P0–P3 severity) | PR reviews, quality checks |
| 🥊 **challenger** | `gpt-5.3-codex` | Pressure tester | Stress-test plans before execution |
| ✅ **verifier** | `gpt-5.3-codex` | 3-tier evidence validation | Verify claims, check correctness |
| ⚖️ **decider** | `gpt-5.3-codex` | Technical decision maker | Architecture choices, trade-offs |
| 🌐 **searcher** | `anthropic/claude-sonnet-4-6` | Research & web search | Documentation lookup, exploration |
| 🖥️ **browser** | `gpt-5.3-codex` | Browser automation & UI testing | E2E testing, visual verification |

<details>
<summary><strong>Model Selection Philosophy</strong></summary>

- **gpt-5.3-codex-spark** — Ultra-fast lightweight tasks (simple single-file changes, quick exploration)
- **gpt-5.3-codex** — Structured reasoning tasks (planning, reviewing, decision-making, implementation)
- **anthropic/claude-sonnet-4-6** — Research and documentation-heavy tasks

The orchestrator (main agent) runs on `gpt-5.3-codex`, ensuring strong reasoning depth for delegation decisions.

</details>

---

## 🧩 Extensions

Over 20 custom TypeScript extensions organized by domain:

### Core System

| Extension | Description |
|---|---|
| **subagent/** | Multi-agent delegation engine — spawns sub-pi processes, manages concurrent runs with pixel-art status widget, hang detection, and automatic cleanup |
| **system-mode/** | Toggle "Master mode" (delegation-only orchestrator) vs normal hands-on mode |
| **claude-mcp-bridge/** | Reuses Claude Code's MCP server configurations — zero-duplication setup |
| **cross-agent.ts** | Load agent definitions from `.claude/`, `.gemini/`, `.codex/` directories |
| **memory-layer/** | Persistent memory system across sessions |

### UI / UX

| Extension | Description |
|---|---|
| **voice-input.ts** | `Option+V` voice dictation with TTS response — talk to your agent |
| **pipi-footer.ts** | Custom footer showing model, git branch, context usage |
| **working-text.ts** | Humorous spinner text with elapsed time during processing |
| **idle-screensaver.ts** | Terminal screensaver when idle |
| **theme-cycler.ts** | `Ctrl+X` to cycle through all themes on-the-fly |
| **diff-overlay.ts** | `/diff` — split-pane git diff viewer overlay |
| **github-overlay.ts** | GitHub PR view directly in the terminal |
| **status-overlay.ts** | `/status` — extension and skill status dashboard |
| **override-builtin-tools.ts** | Collapse/expand verbose tool output for cleaner sessions |

### Developer Tools

| Extension | Description |
|---|---|
| **todos.ts** | Task management with persistent storage and TUI |
| **session-replay.ts** | `/replay` — browse and replay past sessions |
| **context.ts** | `/context` — context window usage statistics |
| **purpose.ts** | Pin a session purpose that persists across compactions |
| **upload-image-url.ts** | Upload images to GitHub CDN for embedding |
| **ask-user-question.ts** | Interactive question tool with predefined options |
| **delayed-action.ts** | Schedule deferred actions |
| **archive-to-html.ts** | Auto-archive HTML files generated by the to-html skill to `~/Documents` |

### Safety

| Extension | Description |
|---|---|
| **damage-control-rmrf.ts** | 🛡️ Blocks destructive `rm -rf` commands before they execute |
| **command-typo-assist.ts** | Detects command typos and offers auto-correction |

---

## 📋 Prompt Templates

Reusable workflow templates invoked with `/template-name`:

### `/one-shot` — Full Research & Solve Pipeline

A heavyweight problem-solving template that enforces:

1. **Research first** — understand context before acting
2. **Explore alternatives** — consider trade-offs broadly
3. **Unlimited subagent use** — delegate freely across agents
4. **Mandatory challenger gates** — pressure-test before and after execution
5. **3-tier validation** — automated tests → browser verification → source analysis
6. **HTML deliverables** — final report, alternatives explored, retrospective

```
/one-shot Fix the race condition in the payment processing pipeline
```

### `/qa-chain` — QA Pipeline

Chains multiple agents for end-to-end quality assurance:

```
worker → browser → verifier → reviewer
```

```pseudo
scenarios = worker("analyze changes, derive test scenarios")
results   = browser(scenarios, "test each in real browser")
fixes     = worker(failures, "fix issues")  →  verifier(fixes)
retest    = browser("verify fixes with screenshots")
final     = reviewer("review all changes")
```

### `/purpose` — Session Purpose

Set or inspect the session purpose manually. It persists across compactions.

```
/purpose <session purpose text>   # set purpose
/purpose                          # show current purpose
/purpose clear                    # clear purpose
```

---

## 🎨 Themes

Five hand-picked themes, hot-swappable with `Ctrl+X`:

| Theme | Style |
|---|---|
| **nord** *(active)* | Arctic, clean blues and frost tones |
| **catppuccin-mocha** | Warm pastels on dark chocolate |
| **gruvbox** | Retro warm tones, easy on the eyes |
| **midnight-ocean** | Deep sea blues and teals |
| **rose-pine** | Muted, elegant rose tones |

---

## ⌨️ Keybindings

| Key | Action |
|---|---|
| `Ctrl+T` | Toggle thinking visibility |
| `Ctrl+X` | Cycle themes |
| `Option+V` | Voice input (dictation + TTS) |

---

## 📦 Install as pi Package

> **Prerequisite:** [pi coding agent](https://github.com/mariozechner/pi-coding-agent) installed globally.

### Option A: pi package (recommended)

```bash
# Global install
pi install git:https://github.com/Jonghakseo/my-pi.git

# Project-local install
pi install -l git:https://github.com/Jonghakseo/my-pi.git
```

### Option B: Clone manually

```bash
git clone https://github.com/Jonghakseo/my-pi.git ~/.pi/agent
cd ~/.pi/agent/extensions && pnpm install
```

### Post-install

```bash
# Set up API keys (choose one):
pi /login                        # Interactive — configure keys via CLI prompt
# or set environment variables:
export ANTHROPIC_API_KEY=sk-...  # for Claude models
export OPENAI_API_KEY=sk-...     # for GPT models

pi                               # Launch — extensions load automatically
```

### Agent Definitions

> **Note:** Agent `.md` files in `agents/` are **not** a pi standard package resource — `pi install` does not auto-register them.

This package includes a `postinstall` script that copies missing agent definitions from the repo's `agents/` directory into `~/.pi/agent/agents/`. It will **never overwrite** existing files, so your local customizations are always safe.

To manually re-sync agents at any time:

```bash
npm run sync-agents           # copy only missing agents
node scripts/sync-agents.mjs --force   # overwrite all (use with caution)
```

---

## 💡 Philosophy

This project is built on a few core beliefs:

**1. Agent configuration is engineering, not just config files.**
Every agent prompt is crafted like a job description. Every extension solves a real friction point. Every automation earns its complexity.

**2. Specialization beats generalization.**
A reviewer that only reviews catches more bugs than a generalist asked to "also review." The challenger agent exists solely to poke holes — and it's one of the most valuable agents in the system.

**3. Safety is a feature, not a constraint.**
`damage-control-rmrf.ts` exists because one accidental `rm -rf /` is one too many. Typo detection, confirmation prompts, and thinking visibility are all first-class concerns.

**4. The terminal is the IDE.**
Voice input, git diffs, GitHub PRs, screensavers — all inside the terminal. No context-switching required.

---

## 📈 Stats

This is not a demo project. It's a **living configuration** used daily for production engineering work.

| Metric | Value |
|---|---|
| Active extensions | 20+ |
| Agent definitions | 10 |
| Themes | 5 |

---

<div align="center">

*Built and used daily by [@Jonghakseo](https://github.com/Jonghakseo)*

*Powered by [pi coding agent](https://github.com/mariozechner/pi-coding-agent)*

</div>
