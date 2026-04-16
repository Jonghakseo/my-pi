**English** | [한국어](./README.ko.md)

# my-pi

A [pi](https://github.com/mariozechner/pi-coding-agent) setup used for daily development.

This repository contains the agent definitions, extensions, skills, prompts, and themes used together in one working environment.

> [!NOTE]
> This is a personal setup. The documentation may lag behind the current state, and some parts can change without notice.

## Architecture

<p align="center">
  <img src="./tmp/architecture.en.svg" alt="System Architecture" width="800"/>
</p>

The system is organized in **four layers**:

| Layer | Purpose |
|---|---|
| **User / pi TUI** | Interactive terminal interface |
| **Extensions** | 30+ TypeScript plugins — subagent management, MCP bridge, remote access, UI overlays, safety guards |
| **Agents** | 11 specialized agent definitions with distinct roles and models |
| **Infrastructure** | MCP tool integrations via `@ryan_nookpi/pi-extension-claude-mcp-bridge` — reuses your existing Claude Code MCP setup (Jira, Slack, Gmail, Calendar, GA4, Figma, DB, etc.) |

---

## Agents

<p align="center">
  <img src="./tmp/agents.en.svg" alt="Agents" width="800"/>
</p>

The current setup has 11 agent definitions, three models, and one main agent:

| Agent | Model | Role | When to Use |
|---|---|---|---|
| **finder** | `anthropic/claude-sonnet-4-6` | Fast file & code locator | Quick lookups, grep-like tasks |
| **worker** | `openai-codex/gpt-5.4` | General-purpose executor | Implementation, writing, fixes (complex multi-file) |
| **planner** | `anthropic/claude-opus-4-6` | Implementation architect | Breaking down complex tasks |
| **simplifier** | `anthropic/claude-sonnet-4-6` | Code simplification specialist | Clean up recently modified code, improve readability, preserve behavior |
| **code-cleaner** | `openai-codex/gpt-5.4` | Code cleanup analyst | Find cleanup opportunities and quality issues |
| **reviewer** | `openai-codex/gpt-5.4` | Code review (P0–P3 severity) | PR reviews, quality checks |
| **challenger** | `openai-codex/gpt-5.4` | Pressure tester | Stress-test plans before execution |
| **verifier** | `anthropic/claude-opus-4-6` | 3-tier evidence validation | Verify claims, check correctness |
| **security-auditor** | `openai-codex/gpt-5.4` | Security reviewer | Focused vulnerability reviews |
| **searcher** | `anthropic/claude-sonnet-4-6` | Research & web search | Documentation lookup, exploration |
| **browser** | `openai-codex/gpt-5.4` | Browser automation & UI testing | E2E testing, visual verification |

<details>
<summary><strong>Model Selection</strong></summary>

- **openai-codex/gpt-5.4** — General-purpose execution & review (implementation, testing, reviewing, security review, browser automation)
- **anthropic/claude-sonnet-4-6** — Fast exploration & research (file search, web research, code simplification)
- **anthropic/claude-opus-4-6** — Deep reasoning tasks (strategic planning, verification)

The main agent runs on `anthropic/claude-opus-4-6` and handles delegation decisions.

</details>

---

## Extensions

Here are representative items from the 30+ custom TypeScript extensions, grouped by domain:

### Core System

| Extension | Description |
|---|---|
| **subagent/** | Multi-agent delegation engine — spawns sub-`pi` processes, manages runs with a below-editor status widget, handles follow-up/cleanup, and includes sub-session-only `ask_master` escalation |
| **@ryan_nookpi/pi-extension-claude-mcp-bridge** | Reuses Claude Code's MCP server configurations — zero-duplication setup |
| **@ryan_nookpi/pi-extension-cross-agent** | Load agent definitions from `.claude/`, `.gemini/`, `.codex/` directories |
| **dynamic-agents-md.ts** | Dynamically loads AGENTS.md at runtime to enforce edit/write scope restrictions |
| **@ryan_nookpi/pi-extension-claude-hooks-bridge** | Bridge connecting Claude Code hook events to Pi sessions |
| **@ryan_nookpi/pi-extension-memory-layer** | Persistent memory system across sessions |
| **remote/** | `/remote`, `/remote:lan`, `/remote:funnel` — local/LAN/public-URL remote access |

### UI / UX

| Extension | Description |
|---|---|
| **footer.ts** | Custom footer showing model, git branch, context usage |
| **working-text.ts** | Tip-focused spinner text with elapsed time during processing |
| **theme-cycler.ts** | `Ctrl+X` to cycle through all themes on-the-fly |
| **diff-overlay.ts** | `/diff` — split-pane git diff viewer overlay |
| **@ryan_nookpi/pi-extension-open-pr** | Open the current branch PR directly in the browser |
| **files.ts** | `/files` — git tree file browser with open/edit/diff quick actions |
| **fork-panel.ts** | `/fork-panel` — fork the current session into a new Ghostty split panel |
| **@ryan_nookpi/pi-extension-generative-ui** | `visualize_read_me`, `show_widget` — native visual widgets and renderers |
| **override-builtin-tools.ts** | Collapse/expand verbose tool output for cleaner sessions |

### Developer Tools

| Extension | Description |
|---|---|
| **upload-image-url.ts** | Upload images to GitHub CDN for embedding |
| **until.ts** | `/until`, `until_report` — repeat work until a condition is met |
| **usage-analytics.ts** | `/analytics` — subagent and skill usage analytics overlay |
| **archive-to-html.ts** | Auto-archive HTML files generated by the to-html skill to `~/Documents` |

### Safety

| Extension | Description |
|---|---|
| **command-typo-assist.ts** | Detects command typos and offers auto-correction |

### Installed npm extension packages

The following extension packages are currently listed in `settings.json`.

| Package | Role |
|---|---|
| `@ryan_nookpi/pi-extension-codex-fast-mode` | Codex Fast Mode toggle |
| `@ryan_nookpi/pi-extension-clipboard` | Clipboard copy tool |
| `@ryan_nookpi/pi-extension-ask-user-question` | Interactive question tool |
| `@ryan_nookpi/pi-extension-auto-name` | Session auto-naming |
| `@ryan_nookpi/pi-extension-delayed-action` | Delayed follow-up actions |
| `@ryan_nookpi/pi-extension-idle-screensaver` | Idle screensaver |
| `@ryan_nookpi/pi-extension-todo-write` | `todo_write` tool |
| `@ryan_nookpi/pi-extension-cc-system-prompt` | Claude Code style system prompt |
| `@ryan_nookpi/pi-extension-open-pr` | Open the current branch PR |
| `@ryan_nookpi/pi-extension-generative-ui` | `visualize_read_me`, `show_widget` |
| `@ryan_nookpi/pi-extension-cross-agent` | Load commands from `.claude`, `.gemini`, `.codex` |
| `@ryan_nookpi/pi-extension-claude-hooks-bridge` | Claude Code hooks bridge |
| `@ryan_nookpi/pi-extension-claude-mcp-bridge` | Claude Code MCP bridge |
| `@ryan_nookpi/pi-extension-memory-layer` | Persistent memory tools |

---

## Session Name

`/name` is a built-in command, not a prompt template.

```
/name <session name>   # set name
/name                  # show current name
```

---

## Themes

The setup currently ships with 7 themes, hot-swappable with `Ctrl+X`:

| Theme | Style |
|---|---|
| **nord** *(default)* | Arctic, clean blues and frost tones |
| **catppuccin-mocha** | Warm pastels on dark chocolate |
| **darcula** | Deep JetBrains-style dark tones |
| **dracula** | Higher-contrast purple-toned dark theme |
| **gruvbox** | Retro warm tones, easy on the eyes |
| **midnight-ocean** | Deep sea blues and teals |
| **rose-pine** | Muted, elegant rose tones |

---

## Keybindings

| Key | Action |
|---|---|
| `Ctrl+T` | Toggle thinking visibility |
| `Ctrl+X` | Cycle themes |
| `Ctrl+Q` | Cycle themes backward |
| `Ctrl+Shift+O` | Open file browser |
| `Ctrl+Shift+F` | Reveal the latest file reference in Finder |
| `Ctrl+Shift+R` | Quick Look the latest file reference |
| `Ctrl+O` | Toggle tool output collapse/expand (pi built-in, customized here via `override-builtin-tools.ts`) |


## Web Research Extension

This setup vendors **pi-web-access** locally in `extensions/web-access/` for the `web_search`, `fetch_content`, and `get_search_content` tools.

- Upstream repository: https://github.com/nicobailon/pi-web-access
- Local extension path: `extensions/web-access/`
- Bundled `librarian` skill path: `skills/librarian/`

---

## Notes

A few practical choices shape this setup:

**1. Roles are separated by task.**
Each agent has a narrow responsibility so delegation stays predictable.

**2. Extensions are added for recurring friction.**
Most custom tools exist because they remove a repeated manual step.

**3. Safety features stay enabled.**
Typo checks, confirmations, and visibility controls are part of the default workflow.

**4. Most workflows stay in the terminal.**
File browsing, diffs, PR work, and automation are handled from the same environment.


