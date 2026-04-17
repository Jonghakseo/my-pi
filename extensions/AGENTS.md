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
│   ├── above-widget.ts    #   Above-editor run status widget (tool-invoked runs)
│   ├── store.ts           #   Shared state store
│   ├── types.ts           #   Type definitions & Typebox schemas
│   ├── constants.ts       #   Constants
│   ├── format.ts          #   Formatting utilities
│   └── run-utils.ts       #   Run management utilities
├── utils/                 # Shared utility functions
│   ├── time-utils.ts      #   Time/duration formatting helpers
│   └── status-keys.ts     #   Shared footer status key constants
├── archive-to-html.ts     # Auto-archive to-html skill output HTML to ~/Documents
├── command-typo-assist.ts # Slash command typo detection → suggest + editor prefill
├── context.ts             # /context — context window usage & session stats overlay
├── diff-overlay.ts        # /diff — Git diff split-pane overlay (file list + diff viewer)
├── dynamic-agents-md.ts   # Dynamic AGENTS.md loading per directory scope
├── files.ts               # File picker / diff viewer UI
├── interactive-shell/     # Interactive shell overlay (interactive/hands-free/dispatch)
├── notify/                # /notify session-toggle: OSC 777/99 alert + macOS say TTS on agent_end
├── footer.ts              # Custom footer UI (model, branch, context bar)
├── working-text.ts              # Spinner working message (tip text + elapsed time)
├── theme-cycler.ts        # Ctrl+X to cycle through themes
└── upload-image-url.ts    # Upload images to GitHub storage and return URLs
```

## Key Patterns
- **Extension entry point**: Each `.ts` file or `directory/index.ts` is auto-loaded by pi.
- **Dependencies**: `@mariozechner/pi-coding-agent`, `@mariozechner/pi-ai`, `@mariozechner/pi-tui`.
- **Themes**: `theme-cycler.ts` provides runtime theme switching.

## Tooling Standards
- **Package manager**: pnpm
- **Quality checks**:
  - `pnpm run typecheck` — TypeScript 타입 검사 (오류만 출력, 파일 변경 없음)
  - `pnpm run lint` — Biome lint + **자동 수정** (`biome check --write .`). 파일을 직접 고침.
  - `pnpm run format` — Biome 포맷 검사만 (파일 변경 없음)
  - `pnpm run format:write` — Biome 포맷 자동 적용 (파일 변경 있음)
  > **주의:** `pnpm run lint`는 `--write` 옵션으로 실행되므로 파일이 즉시 수정된다. 검사만 원하면 `biome check .`를 직접 실행할 것.
- **Formatter**: Biome 2.x

## Type Contract Guide
- `registerTool.execute` must follow the latest callback signature (include all required parameters).
- `AgentToolResult` must always include the `details` field — never omit it.
- Keep `content.type` as the string literal `"text"` (no widened `string` type).
- Prefer discriminated-union narrowing for `SessionEntry` / `AgentMessage` over forced type casts (`as`).

## New Extension Code Quality Rules

### Priority
When adding new features or refactoring, use this priority order:

- **Accuracy > Consistency > Visibility > Stability > Modifiability > Verifiability**

### Practical checklist (verify each time)
- [ ] **Requirement correctness:** confirm the implementation satisfies user intent and existing contracts first.
- [ ] **Output contract parity:** verify user-facing text, order, format, sorting, and newlines are not unintentionally changed.
- [ ] **Output/error/log policy:** follow existing message formatting rules; changes to user-facing contracts require prior agreement.
- [ ] **Separate pure logic:** extract business rules into pure functions where possible; keep I/O (`fs`/`network`/`spawn`) in boundary layers.
- [ ] **Module-scoped changes:** modify only one module (or a small unit) and avoid touching out-of-scope files.
- [ ] **Respect single-writer boundaries:** in out-of-scope files/owned areas of other modules (for example, `subagent` core paths), allow only strictly minimal edits.
- [ ] **Gate execution:** after changes run `test` → `typecheck` (and `coverage` when feasible) and then complete review before commit.
- [ ] **Baseline control:** even if known baseline failures exist, do not introduce new failures. (fix only deltas)

### Execution principles
- Keep user-facing output contracts from breaking unless the change is explicitly intended.
- Break risky work into small increments, and if any unexpected output change is found, immediately apply rollback criteria.
- Fix regressions in the smallest verifiable unit and avoid bundling unrelated format and logic changes in the same patch.
- Integrate and strengthen new rules only when they do not conflict with existing ones.

## Known Issues
- **CJK width overflow in built-in footer**: Pi's built-in `FooterComponent` uses `pwd.length` instead of `visibleWidth()` to check terminal width, causing crashes when the session name contains CJK (Korean/Japanese/Chinese) characters. This surfaces during `/reload` when the custom footer is briefly removed. Workaround: avoid CJK characters in session names (`/name`). Root fix requires a pi core change.
