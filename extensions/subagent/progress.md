# Claude Runtime Subagent Progress

Last updated: 2026-04-06
Reference:
- Plan: `extensions/subagent/CLAUDE_RUNTIME_PLAN.md`
- Tasks: `extensions/subagent/TASKS.md`

## Current status

- **All tasks T00a~T11 COMPLETED**
- Typecheck: PASS
- Tests: 46 files, 1306 tests, 0 failures
- Feature flag: `PI_CLAUDE_RUNTIME_ENABLED` (기본 OFF)

## Task progress snapshot

### Wave 0 — 관측/사실 수집 (전부 완료)

- `T00a` Claude CLI environment/version check — PASS
- `T00b` stream-json fixture collection — PASS
- `T00c` resume/approval/MCP/cwd observations — PASS
- `T00d` process lifecycle spec — PASS
- `T01` Phase 0 결과를 계획 문서에 반영 — PASS

### Wave 1 — 타입/정책 기초 (전부 완료)

- `T02` runtime/type/prompt 정책 추가 — PASS
  - `types.ts`: AgentConfig/CommandRunState/SingleResult에 runtime/Claude metadata 추가
  - `agents.ts`: frontmatter `runtime` 읽기, runtime-aware prompt 분기 (ask_master 제거/대체)
  - 7 tests in `subagent-runtime-config.test.ts`

- `T03` runner 계약/분기/역방향 매핑 — PASS
  - `runner.ts`: runClaudeAgent skeleton + runSingleAgent runtime dispatch
  - `agent-utils.ts`: PI_TO_CLAUDE_TOOL_MAP, mapPiToolsToClaude, validateClaudeRuntimeModel
  - 18 tests in `subagent-runner-dispatch.test.ts`

- `T04` approval/MCP/ambient config 정책 코드화 — PASS
  - `claude-args.ts`: buildClaudeArgs (non-bare, --verbose, --strict-mcp-config, --tools/--allowedTools)
  - 19 tests in `claude-args.test.ts`

### Wave 2 — Claude 런타임 핵심 (전부 완료)

- `T05` Claude stream parser + lifecycle — PASS
  - `claude-stream-parser.ts`: processClaudeEvent, stateToSingleResult
  - `runner.ts`: runClaudeAgent 실제 구현 (spawn, NDJSON parse, lifecycle)
  - 35 tests in `claude-stream-parser.test.ts`

- `T06` session metadata 전파/복원 — PASS
  - `store.ts`: updateRunFromResult에 Claude metadata 전파
  - `tool-execute.ts` / `commands.ts`: details 직렬화/복원, continue validation, mid-run checkpoint
  - 17 tests in `subagent-session-metadata.test.ts`

- `T07` sidecar writer — PASS
  - `claude-sidecar-writer.ts`: pi-compatible JSONL writer (append discipline)
  - `runner.ts`: sidecar writer 연동
  - 12 tests in `claude-sidecar-writer.test.ts`

- `T08` live preview / hang-detection parity — PASS
  - `claude-stream-parser.ts`: liveActivityPreview 생성
  - `store.ts`: lastActivityAt 갱신 로직 보강
  - 10 tests in `subagent-live-preview.test.ts`

### Wave 3 — 통합/게이트 (전부 완료)

- `T09` commands/tool-execute 통합 — PASS
  - `commands.ts` / `tool-execute.ts`: error path metadata, analytics summary, detail output
  - 11 tests in `subagent-commands-tool-integration.test.ts`

- `T10` 테스트/acceptance 통합 — PASS (rollout gate)
  - Acceptance matrix 15/15 PASS
  - 35 tests in `subagent-acceptance-t10.test.ts`

- `T11` feature flag + 초기 opt-in rollout — PASS
  - Feature flag: `PI_CLAUDE_RUNTIME_ENABLED=true` (기본 OFF)
  - `agents/finder.md`, `agents/planner.md`, `agents/verifier.md`에 `runtime: claude` 추가
  - Rollback: flag OFF → 즉시 모든 agent pi로 복귀

## Acceptance Matrix (T10)

| # | Item | Status |
|---|------|--------|
| A01 | Runtime frontmatter parsing | PASS |
| A02 | Runtime-aware prompt policy | PASS |
| A03 | Runtime dispatch | PASS |
| A04 | Non-Anthropic model guard | PASS |
| A05 | Explicit approval policy | PASS |
| A06 | Explicit MCP source policy | PASS |
| A07 | Stream-json parser | PASS |
| A08 | Process lifecycle fallback | PASS |
| A09 | Session metadata propagation | PASS |
| A10 | Reload/continue/same session resume | PASS |
| A11 | Same sidecar append across continue | PASS |
| A12 | Replay compatibility | PASS |
| A13 | Detail compatibility | PASS |
| A14 | Live preview / hang detection parity | PASS |
| A15 | Existing runtime: pi regression | PASS |

## New files created

- `extensions/subagent/claude-args.ts` — CLI args builder
- `extensions/subagent/claude-stream-parser.ts` — stream-json event parser
- `extensions/subagent/claude-sidecar-writer.ts` — pi-compatible JSONL sidecar writer
- `extensions/subagent/fixtures/claude-process-lifecycle.md` — lifecycle spec

## New test files

- `extensions/utils/subagent-runtime-config.test.ts`
- `extensions/utils/subagent-runner-dispatch.test.ts`
- `extensions/utils/claude-args.test.ts`
- `extensions/utils/claude-stream-parser.test.ts`
- `extensions/utils/subagent-session-metadata.test.ts`
- `extensions/utils/claude-sidecar-writer.test.ts`
- `extensions/utils/subagent-live-preview.test.ts`
- `extensions/utils/subagent-commands-tool-integration.test.ts`
- `extensions/utils/subagent-acceptance-t10.test.ts`

## Known risks / follow-ups

- `--bare` 미사용 → ambient hooks/plugins/skills 노출 가능 (v1 허용, 모니터링 필요)
- `--verbose` 의존 (stream-json metadata 캡처용)
- abort/non-zero-exit fixture 미확보 (T00b known gap)
- `--strict-mcp-config`는 MCP만 제한 (hooks/plugins는 미제한)
- Context7 MCP package version pin 미결정 (P2)

## Recommended next steps

1. `PI_CLAUDE_RUNTIME_ENABLED=true` 설정 후 실제 subagent 실행 테스트 (finder, planner, verifier)
2. abort/non-zero-exit fixture 추가 확보
3. 실환경 모니터링 후 추가 agent 확대 여부 판단
