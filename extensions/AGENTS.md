# Pi Extensions Codebase

Custom extensions for the pi coding agent. All extensions are written in TypeScript using the `@mariozechner/pi-coding-agent` API.

## Directory Layout

```
├── subagent/              # Core — subagent delegation system (largest module)
│   ├── index.ts           #   Entry point & extension registration
│   ├── commands.ts        #   Slash commands & tool handlers
│   ├── tool-execute.ts    #   Tool execution logic
│   ├── tool-render.ts     #   Tool call/result rendering
│   ├── runner.ts          #   Process execution & result handling
│   ├── session.ts         #   Session file management & context
│   ├── replay.ts          #   Session replay TUI viewer
│   ├── agents.ts          #   Agent discovery & configuration
│   ├── widget.ts          #   Run status widget (below-editor)
│   ├── pixel-characters.ts #  Pixel art character definitions & half-block renderer
│   ├── pixel-widget.ts    #   Pixel art above-editor widget for subagent runs
│   ├── store.ts           #   Shared state store
│   ├── types.ts           #   Type definitions & Typebox schemas
│   ├── constants.ts       #   Constants
│   ├── format.ts          #   Formatting utilities
│   └── run-utils.ts       #   Run management utilities
├── claude-hooks-bridge.ts  # Bridge to run Claude Code hooks in pi
├── claude-mcp-bridge/     # Bridge to reuse Claude Code MCP config in pi
│   └── index.ts           #   Merge-load MCP settings & register servers
├── system-mode/           # System mode toggle (agent mode on/off)
│   ├── index.ts           #   Mode switching logic
│   └── state.ts           #   Global state management
├── utils/                 # Shared utility functions
│   ├── time-utils.ts      #   Time/duration formatting helpers
│   └── status-keys.ts     #   Shared footer status key constants
├── ask-user-question.ts   # AskUserQuestion tool with options & free-text input
├── context.ts             # /context — context window usage & session stats overlay
├── cross-agent.ts         # Load commands/skills from .claude/.gemini/.codex dirs
├── damage-control-rmrf.ts # Safety guard against rm -rf
├── delayed-action.ts      # Delayed action scheduling ("do this later" style)
├── diff-overlay.ts        # /diff — Git diff split-pane overlay (file list + diff viewer)
├── dynamic-agents-md.ts   # Dynamic AGENTS.md loading per directory scope
├── files.ts               # File picker / diff viewer UI
├── github-overlay.ts      # GitHub PR view overlay (gh CLI integration)
├── idle-screensaver.ts    # Idle screensaver — session context display after inactivity
├── minimal-mode.ts        # Compact tool output rendering (collapsed/expanded toggle)
├── pipi-footer.ts         # Custom footer UI (model, branch, context bar)
├── working-text.ts              # Spinner working message (funny text + elapsed time)
├── purpose.ts             # Session purpose top-overlay + purpose guard/tool/command
├── session-replay.ts      # Session replay overlay UI
├── status-overlay.ts      # /status — skills, tools & extensions list overlay
├── theme-cycler.ts        # Ctrl+X to cycle through themes
├── themeMap.ts            # Default theme mapping per extension
├── todos.ts               # Todo management UI & tool
├── upload-image-url.ts    # Upload images to GitHub storage and return URLs
└── voice-input.ts         # Option+V voice dictation + response TTS summary
```

## Key Patterns
- **Extension entry point**: Each `.ts` file or `directory/index.ts` is auto-loaded by pi.
- **Dependencies**: `@mariozechner/pi-coding-agent`, `@mariozechner/pi-ai`, `@mariozechner/pi-tui`.
- **Themes**: `themeMap.ts` maps default themes per extension; `theme-cycler.ts` for runtime switching.
- **Shared state**: `system-mode/state.ts` exposes an agent-mode flag referenced by multiple extensions.

## Tooling Standards
- **Package manager**: pnpm
- **Quality checks**: `pnpm run typecheck` / `pnpm run lint` / `pnpm run format`
- **Formatter**: Biome 2.x

## Type Contract Guide
- `registerTool.execute` must follow the latest callback signature (include all required parameters).
- `AgentToolResult` must always include the `details` field — never omit it.
- Keep `content.type` as the string literal `"text"` (no widened `string` type).
- Prefer discriminated-union narrowing for `SessionEntry` / `AgentMessage` over forced type casts (`as`).

## Known Issues
- **CJK width overflow in built-in footer**: Pi's built-in `FooterComponent` uses `pwd.length` instead of `visibleWidth()` to check terminal width, causing crashes when the session name contains CJK (Korean/Japanese/Chinese) characters. This surfaces during `/reload` when the custom footer is briefly removed. Workaround: avoid CJK characters in session names (`/name`). Root fix requires a pi core change.
