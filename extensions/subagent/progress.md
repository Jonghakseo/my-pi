# Claude Runtime Subagent Progress

Last updated: 2026-04-06
Reference:
- Plan: `extensions/subagent/CLAUDE_RUNTIME_PLAN.md`
- Tasks: `extensions/subagent/TASKS.md`

## Current status

- Pipeline mode: `worker → verifier → reviewer`
- Current stop point: **after `T00c`, before `T00d`**
- User request: **finish T00b/T00c completeness work, update progress, then pause**

## Task progress snapshot

### Completed
- `T00a` Claude CLI environment/version check
  - Confirmed `claude` CLI is installed and runnable
  - Confirmed local auth is usable
  - Confirmed `claude -p "say ok" --output-format text` succeeds
  - Reflected in `extensions/subagent/CLAUDE_RUNTIME_PLAN.md`
  - Reviewer follow-up redaction applied for account-specific auth output

### Completed
- `T00b` stream-json fixture collection
  - Artifacts:
    - `extensions/subagent/fixtures/claude-stream/basic-text.ndjson`
    - `extensions/subagent/fixtures/claude-stream/tool-call.ndjson`
    - `extensions/subagent/fixtures/claude-stream/long-running.ndjson`
    - `extensions/subagent/fixtures/claude-stream/error.ndjson`
    - `extensions/subagent/fixtures/claude-stream/bare-auth-error.ndjson`
    - `extensions/subagent/fixtures/claude-stream/README.md`
  - Final verifier: PASS
  - Final reviewer: PASS
  - Completeness updates applied:
    - `long-running.ndjson` 설명을 incremental stdout 스트리밍으로 과장하지 않도록 수정
    - 현재 fixture 범위에 **abort / non-zero-exit / fallback semantics는 포함되지 않음**을 README에 명시

- `T00c` resume/approval/MCP/cwd observations
  - Artifacts:
    - `extensions/subagent/fixtures/claude-observations.md`
    - `extensions/subagent/fixtures/claude-mcp-context7-only.json`
  - Final verifier: PASS
  - Final reviewer: PASS with one non-blocking follow-up candidate
  - Completeness updates applied:
    - `--strict-mcp-config`는 **MCP exposure 제한**에 대한 관측일 뿐, 전체 runtime isolation 증거가 아님을 명시
    - pre-init `hook_*` events가 `init`보다 먼저 나오고 같은 `session_id`를 담는다는 관측 추가
    - same-cwd resume의 대화 연속성을 nonce recall 예시로 보강
  - Non-blocking follow-up candidate:
    - `extensions/subagent/fixtures/claude-mcp-context7-only.json`의 `@upstash/context7-mcp@latest`를 고정 버전으로 pin 하면 재현성이 더 좋아짐 (reviewer P2 ASK)

### Not started
- `T00d` process lifecycle spec
- `T01` reflect Phase 0 findings into plan
- `T02`~`T11` implementation/acceptance/rollout tasks

## Important observed facts so far

### CLI / auth
- `claude --version` observed: `2.1.91 (Claude Code)`
- Local non-bare auth is usable
- `--bare` is currently an auth blocker in this environment

### stream-json
- Real fixtures were captured for parser source-of-truth use
- Successful stream-json capture required `--verbose` in this environment
- Bare-mode auth failure was preserved separately as `bare-auth-error.ndjson`

### runtime policy observations
- `--resume` uses UUID-like session ids
- Session id is observable early from `system/init` in stream-json
- `--mcp-config` alone is additive; strict isolation requires `--strict-mcp-config`
- Same-cwd resume succeeded; cross-cwd resume failed in observed tests
- `Edit`/`Write` required `--allowedTools` in observed non-interactive runs

## Active subagent work at pause time

- 없음
- T00b / T00c의 worker → verifier → reviewer 파이프라인은 현재 시점에 모두 종료됨

## Known blockers / cautions

- 사용자 요청으로 **`T00d`는 아직 시작하지 않음**
- `--bare` default strategy is currently unsafe in this environment until plan/spec is updated accordingly
- `--verbose` requirement must be reflected downstream in parser-related tasks/spec
- T00b fixture set은 parser source-of-truth이지만 **abort / non-zero-exit / fallback** 근거는 아직 별도 확보가 필요함
- `--strict-mcp-config`는 MCP만 제한한다는 점을 downstream policy에서 과대해석하면 안 됨

## Recommended next step after resume

1. 필요하면 `claude-mcp-context7-only.json`의 Context7 MCP package version pin 여부를 결정
2. `T00d` process lifecycle spec 파이프라인 시작
3. 이후 `T01`에서 Phase 0 결과를 plan 문서에 통합 반영

## Pause note

Work intentionally paused here per user request **after completing T00b/T00c completeness work and updating this progress log**.
