# Claude Runtime Subagent 구현 계획

> `extensions/subagent/`에 `runtime: claude` opt-in을 도입해, 선택된 서브에이전트를 기존 `pi` 대신 Claude Code `claude -p` 경로로 실행하기 위한 구현 문서.
>
> 범위는 **v1: 안정적인 런타임 분기 + 세션 호환 + 기존 UX 보존**까지로 제한한다.

---

## 목표

`agents/*.md` 중 일부 서브에이전트가 `runtime: claude`를 명시하면:

- 기존 `spawn("pi", ...)` 대신 `claude -p`로 실행한다.
- 기존 subagent UX를 최대한 유지한다.
  - `subagent runs`
  - `subagent detail`
  - replay overlay
  - widget 진행 상태
  - continue / resume
- 기존 `runtime: pi` 에이전트는 영향 없이 그대로 동작한다.

---

## 비목표 (v1 범위 밖)

다음은 이번 구현에서 제외한다.

1. Pi custom tool 전체를 Claude에서 직접 사용 가능하게 만드는 작업
2. `ask_master`를 Claude runtime에서도 지원하는 작업
3. memory-layer 도구(`remember/recall/forget`) 브릿지
4. `todo_write`, `until_report`, `show_widget` 같은 Pi 전용 도구 브릿지
5. Claude runtime 전용 batch/chain 최적화
6. Anthropic 모델이면 자동으로 전환하는 암묵적 정책

---

## 공식 문서 근거

- Claude Code CLI reference  
  https://docs.anthropic.com/en/docs/claude-code/cli-reference
- Run Claude Code programmatically (`claude -p`)  
  https://docs.anthropic.com/en/docs/claude-code/headless
- Claude Code MCP  
  https://docs.anthropic.com/en/docs/claude-code/mcp
- OpenClaw Anthropic provider note  
  https://docs.openclaw.ai/providers/anthropic

핵심 요약:

- `claude -p`는 공식적인 non-interactive/headless 실행 경로다.
- `--output-format stream-json`, `--include-partial-messages`, `--resume`, `--tools`, `--allowedTools`, `--mcp-config`를 사용할 수 있다.
- Claude Code는 MCP를 공식 지원한다.
- 단, OpenClaw 문서 기준으로 third-party harness usage 정책 리스크는 남아 있으므로 장기 안정성이 완전히 보장되진 않는다.

### T00a 관측 결과 (2026-04-06)

실제 로컬 환경에서 아래를 확인했다.

```bash
$ claude --version
2.1.91 (Claude Code)

$ claude auth status --text
# usable authentication confirmed in the local environment

$ claude -p "say ok" --output-format text
ok
```

현재 기준 확정 사항:

- `claude` CLI는 이 환경에 설치되어 있고 실행 가능하다.
- 인증 상태는 usable 하며 headless 호출 전제 조건을 만족한다.
- 최소 print-mode sanity check가 성공했으므로 `T00b`/`T00c` 관측 작업을 진행할 수 있다.

주의:

- 이 단계는 **설치/auth/basic text 호출 가능 여부만** 확인한 것이다.
- `stream-json` event schema, `--resume`, approval 정책, MCP config 주입, `cwd`/lifecycle 계약은 아직 미확정이며 `Phase 0` 후속 태스크에서 실측으로 고정해야 한다.

---

## 로컬 코드 근거

### 현재 pi subagent 실행 구조

- `extensions/subagent/runner.ts`
  - `runSingleAgent()`가 현재 `spawn("pi", ...)` 고정
- `extensions/subagent/session.ts`
  - main-context wrapping, subagent session file 생성
- `extensions/subagent/commands.ts`
- `extensions/subagent/tool-execute.ts`
  - run / continue / batch / chain 흐름 전반
- `extensions/subagent/replay.ts`
  - 세션 JSONL replay UI
- `extensions/subagent/store.ts`
  - run 상태 / widget 상태 저장

즉, 현재 subagent 시스템은 단순 실행기 교체만으로 끝나지 않고 **세션 파일 + 상태 표시 + detail/replay 파서까지 강결합**되어 있다.

### 참조한 Claude Code 세션 구조 (ai-platform)

- `/Users/creatrip/Documents/creatrip/ai-platform/lib/ai/claude-code-query.ts`
- `/Users/creatrip/Documents/creatrip/ai-platform/lib/utils/claude-code-session.ts`
- `/Users/creatrip/Documents/creatrip/ai-platform/lib/utils/core-message-to-claude-code.ts`
- `/Users/creatrip/Documents/creatrip/ai-platform/lib/ai/runClaudeCodeChat.ts`

여기서 확인한 핵심:

1. Claude Code는 **resume 가능한 session**으로 다룬다.
2. tool lifecycle은 **stream event**로 파싱한다.
3. host 앱 도구는 **MCP server**로 감싸 Claude에 주입할 수 있다.
4. Claude session 포맷과 host 앱 내부 포맷은 분리하는 편이 안전하다.

---

## 접근법 비교

### 접근법 A — 단순 교체

Anthropic 모델이면 그냥 `pi` 대신 `claude -p`를 spawn한다.

#### 장점
- 구현이 가장 빠름

#### 단점
- 기존 `sessionFile` 포맷과 충돌
- replay / detail 파서 깨질 가능성 큼
- continue / resume semantics 불안정
- tool call / thought / usage 추적 약화
- Pi 전용 도구와 escalation 경로 상실

#### 결론
비추천

---

### 접근법 B — Dual-session 호환 레이어

`runtime: claude`일 때 Claude runtime session과 pi UI session을 분리 관리한다.

#### 장점
- 기존 subagent UX 유지 가능
- continue / resume 설계 가능
- 점진적 확장 가능
- `runtime: pi`와 공존 쉬움

#### 단점
- 구현량 증가
- 이벤트 normalize 계층 필요

#### 결론
**추천**

---

### 접근법 C — 처음부터 Pi custom tools까지 Claude MCP shim으로 완전 이식

#### 장점
- 장기적으로 가장 강력

#### 단점
- 범위가 과도하게 커짐
- `ask_master`, memory, todo, widget까지 모두 재설계 필요
- 이번 요구사항 대비 과한 투자

#### 결론
v2 이후 과제

---

## Self-healing 설계 보완 결과

### Cycle 1: 초기 설계 비판

문제점:

1. `sessionFile`을 Claude session으로 재사용하려는 가정이 위험
2. stdout text만 받는 runner는 현재 widget/status UX를 못 살림
3. continue는 단순 문자열 이어붙이기가 아니라 Claude `resume` 기반이어야 함

반영:

- Claude runtime session과 pi UI session을 분리
- Claude runner는 `stream-json` 기반 파서로 설계
- continue는 `--resume` 기반으로 변경

### Cycle 2: 보강안 재비판

문제점:

1. unsupported tool을 조용히 fallback하면 예측 불가
2. `ask_master`는 현재 pi subagent session에만 동적 등록됨
3. `commands.ts` / `tool-execute.ts` 양쪽 경로가 동일 정책을 가져야 함
4. replay/detail 호환을 위해 Claude 결과를 pi 형식 sidecar로 남겨야 함
5. 처음부터 MCP shim까지 포함하면 범위 폭발

반영:

- `runtime: claude` + unsupported tool 선언 시 **fail fast**
- `ask_master`는 v1 미지원으로 명시
- `commands.ts`, `tool-execute.ts` 모두 같은 runtime 정책 적용
- Claude 결과를 pi 형식 sidecar session으로 기록
- MCP shim은 v2로 분리

---

## 최종 설계

## 1. Agent frontmatter 확장

`agents/*.md`에 선택적 필드 추가:

```md
runtime: claude
```

지원값:

- `pi` 기본값
- `claude` opt-in

초기 추천 적용 대상:

- `finder`
- `planner`
- `verifier`

보류:

- `searcher`
- `simplifier`

이유:

- 앞 3개가 Claude built-in 도구와 잘 맞고 Pi custom tool 의존이 낮음

---

## 2. 런타임 분기

`extensions/subagent/runner.ts`에서 실행 경로를 둘로 분리한다.

- `runPiAgent(...)`
- `runClaudeAgent(...)`
- `runSingleAgent(...)`는 agent runtime을 보고 분기

원칙:

- `runtime: pi`는 기존 로직 그대로 유지
- `runtime: claude`만 새 경로 적용

---

## 3. 세션 모델 이원화

### A. pi UI session

용도:

- `subagent detail`
- replay overlay
- widget preview
- 운영용 JSONL session file

이것이 기존 `CommandRunState.sessionFile`의 역할을 계속 담당한다.

### B. Claude runtime session

용도:

- `claude -p --resume`
- Claude 내부 문맥 연속성

추가 상태 필드 예시:

- `runtime?: "pi" | "claude"`
- `claudeSessionId?: string`
- `claudeProjectDir?: string`
- `claudeSessionPath?: string`
- `claudeSessionSource?: "stream" | "details-restore" | "unknown"`

핵심 원칙:

- `sessionFile`은 **pi sidecar session**으로 유지
- Claude session은 **resume용 메타데이터**로만 별도 저장
- Claude resume metadata는 메모리에만 두지 않고, `subagent-command` / `subagent-tool` message `details`에도 직렬화해 세션 전환/리로드 후 복원 가능해야 한다

---

## 4. Claude runner는 stream-json 기반

Claude 실행은 text 출력만 받는 방식이 아니라 event stream 파싱 방식으로 구현한다.

예상 플래그:

```bash
claude --bare -p \
  --output-format stream-json \
  --include-partial-messages \
  ...
```

필요 시 추가:

- `--resume <session>`
- `--append-system-prompt-file <path>`
- `--allowedTools ...`
- `--tools ...`
- `--mcp-config <file-or-json>`

### Ambient Claude config policy

v1의 `runtime: claude`는 **`--bare`를 기본값**으로 사용한다. 즉 자동 discovery 되는 다음 항목은 기본적으로 끈다.

- hooks
- skills
- plugins
- auto memory
- `CLAUDE.md`
- working directory / `~/.claude`의 기타 ambient 설정

대신 필요한 항목만 명시적으로 다시 넣는다.

- system prompt: `--append-system-prompt-file`
- tool exposure / approval: `--tools`, `--allowedTools`
- MCP: 우리가 허용한 config 파일만 `--mcp-config`로 명시 주입

이 정책으로 machine-dependent drift와 unsupported-tool drift를 줄인다.
**중요:** 구현 전에 실제 `claude -p --output-format stream-json` 출력 샘플을 수집해 event schema를 문서화한다. `ai-platform` 참고 코드는 힌트로만 쓰고, event 이름/필드 구조는 실제 CLI 출력으로 검증한 뒤 parser를 작성한다.

파싱 대상(실측 후 확정):

- text delta
- thinking delta
- tool_use start / input_json_delta / stop
- result
- usage
- session identifier / resume handle

이를 `SingleResult`로 normalize:

- `messages`
- `usage`
- `model`
- `thoughtText`
- `liveText`
- `liveToolCalls`
- `liveActivityPreview`
- `stopReason`
- `claudeSessionId`(획득 가능할 경우)
- `claudeProjectDir`(resume 시 사용할 cwd)

`liveActivityPreview`는 widget/hang-detection parity를 위해 필요하며, in-progress tool invocation 동안 `→ tool(args)` 형태의 상태를 유지할 수 있어야 한다.

### Non-interactive approval policy

`runtime: claude`는 permission prompt가 뜨면 안 된다. v1에서는 아래 둘을 모두 명시한다.

1. `--tools`는 mapped tool set만 노출
2. `--allowedTools`는 같은 mapped tool set에서 자동 생성

즉 허용된 도구는 **노출과 승인**을 모두 만족해야 하며, Bash/Edit/Write를 쓰는 agent도 interactive approval 없이 완료되어야 한다.

---

## 5. 컨텍스트 전략

### 첫 run

기존 pi가 잘하는 main-context wrapping을 그대로 활용한다.

- `wrapTaskWithMainContext(...)`
- `[HISTORY — REFERENCE ONLY]`
- `[REQUEST — AUTHORITATIVE]`

즉 첫 run은 현재의 안전한 wrapping을 그대로 사용한다.

### continue run

continue 이후부터는:

- `claudeSessionId`가 있으면 `--resume`
- 새 authoritative task만 새 user prompt로 전달
- `claudeSessionId`가 없으면 조용히 새 세션으로 진행하지 않고 명시적 오류로 중단하거나, 사용자/호출자에게 resume 불가 상태를 분명히 알린다

이는 `claude-code-query.ts`가 이전 대화를 저장하고 마지막 user prompt만 보내는 패턴과 방향이 같다.

### Claude resume metadata lifecycle

구현 전 반드시 아래를 계획에 포함한다.

1. 첫 Claude run에서 session identifier를 어느 event/결과에서 읽는지 명시
2. 그 값을 `SingleResult` → `CommandRunState`로 전파
3. 같은 값을 start/completion `details` payload에도 기록
4. 세션 복원 로직(`commands.ts`, `tool-execute.ts` 경로)에서 다시 읽어 `continue`에 재사용
5. resumed Claude run은 **현재 `ctx.cwd`가 아니라 저장된 `claudeProjectDir`** 로 spawn 하며, metadata가 없거나 mismatch면 hard-fail 한다
6. 리로드 후 `subagent continue <runId>`가 동일 Claude session을 resume하는 acceptance check 추가

추가 정책:

- `claudeSessionId`가 mid-run에 처음 관측되면 completion까지 기다리지 말고 **중간 체크포인트**로도 persistence 해야 한다
- 최소한 hidden status/custom message 또는 동등한 durable checkpoint 경로를 하나 정의해, start 후 crash가 나도 resume handle을 잃지 않도록 한다

---

## 6. 도구 정책 (v1)

### 허용

`runtime: claude`에서 우선 지원하는 도구:

- `read`
- `find`
- `grep`
- `ls`
- `bash`
- `edit`
- `write`

또한 Claude Code의 MCP는 **ambient auto-discovery가 아니라 우리가 허용한 config source만** 사용 가능하다.

예:

- project `.mcp.json`
- user `~/.claude.json` 또는 `~/.mcp.json`

단, v1에서는 `--bare`를 쓰므로 위 파일들도 자동 발견에 맡기지 않고, 사전에 탐색한 허용 목록만 `--mcp-config`로 명시 전달한다.

### 미지원

아래 Pi 전용 도구는 v1에서 미지원:

- `ask_master`
- `remember`
- `recall`
- `forget`
- `todo_write`
- `until_report`
- `show_widget`
- 기타 Pi in-process custom tool

### 정책

`runtime: claude` agent가 unsupported tool을 선언하면:

- 실행 시작 전에 실패
- 어떤 tool이 unsupported인지 명확히 노출
- 조용한 fallback 금지

여기서 검증 대상은 단순 frontmatter `tools`뿐 아니라, runtime별로 주입되는 공통 system prompt 규칙까지 포함한다. 특히 현재 `agents.ts`는 모든 agent prompt에 `ask_master` 가이드를 주입하므로, `runtime: claude`에서는 이 가이드를 제거하거나 Claude용 대체 문구로 바꿔야 한다.

이유:

- opt-in 정책에서 침묵 fallback은 디버깅을 어렵게 만든다.
- 선언된 도구 목록은 통과했더라도, system prompt가 존재하지 않는 tool 사용을 유도하면 런타임 실패로 이어진다.

---

## 7. replay/detail 호환 전략

Claude session 파일을 기존 replay 대상으로 직접 쓰지 않는다.

대신:

- Claude stream event를 읽으면서
- pi replay가 읽을 수 있는 **sidecar JSONL**을 기록하고
- 기존 `run.sessionFile`은 이 sidecar를 가리키게 유지한다.

그러면 다음 기존 코드 재사용 가능성이 커진다.

- `extensions/subagent/replay.ts`
- `parseSessionDetailSummary()`
- `updateRunFromResult()`

즉:

- Claude session = resume용
- pi sidecar session = UI/운영용

---

## 8. `ask_master` 정책

현재 `ask_master`는:

- `extensions/escalate-tool.ts`
- subagent session에서만 동적 등록

즉 Claude runtime에선 그대로 사용할 수 없다.

v1 정책:

- `runtime: claude` agent는 `ask_master` 미지원
- 이 제한을 문서와 에러 메시지에 명확히 표시
- `extensions/subagent/agents.ts`의 공통 prompt 주입에서도 `ask_master` 관련 가이드를 runtime별로 분기한다
  - `runtime: pi`: 기존 guideline 유지
  - `runtime: claude`: `ask_master` 안내 제거 또는 "blocker는 plain text로 보고하고 tool 호출을 시도하지 말 것"으로 대체

v2 후보:

- 로컬 MCP shim tool로 재구현
- 또는 sentinel 출력 기반 escalation 프로토콜

---

## 구현 파일별 계획

## Task 1 — Agent 선언 확장

### 수정 파일

- `extensions/subagent/agents.ts`
- `extensions/subagent/types.ts`
- 대상 `agents/*.md`

### 작업

- frontmatter에서 `runtime` 읽기
- `AgentConfig`에 `runtime?: "pi" | "claude"` 추가
- 미지정 시 `pi`
- 공통 system prompt 주입을 runtime-aware 하게 변경
  - `attachCommonSubagentRule()`가 `runtime: claude`에서는 `ask_master` guideline을 제거/대체하도록 설계

### 검증

- 기존 agent 정의가 그대로 로드되는지
- `runtime` 없는 agent는 동작 변화가 없는지
- `runtime: claude` agent의 system prompt에 `ask_master` 사용 지시가 남지 않는지

---

## Task 2 — Claude 런타임 분기 추가

### 수정 파일

- `extensions/subagent/runner.ts`

### 작업

- `runClaudeAgent()` 추가
- `runClaudeAgent()`는 `runSingleAgent()`와 동일한 호출 계약(`signal`, `onUpdate`, `makeDetails`, `SingleResult` 반환)을 유지해 `launchRunInBackground()` / `finalizeRunState()` / `updateRunFromResult()`를 수정 최소화로 재사용할 수 있게 한다
- `runSingleAgent()`에서 runtime 분기
- model / thinking / tool 매핑 함수 추가
- 기존 `extensions/utils/agent-utils.ts`의 `CLAUDE_TOOL_MAP`, `normalizeTools(..., "claude")`는 **Claude→pi 방향**임을 명시하고, `runtime: claude`에는 필요 시 별도 `PI_TO_CLAUDE_TOOL_MAP` 또는 동등한 역방향 매핑을 둔다
- `runtime: claude`에서는 non-Anthropic model을 명시적으로 거부하거나 허용 규칙을 문서화한다 (v1 권장: 거부)
- `cwd` 전달 방식을 실제 Claude CLI 동작 기준으로 확인하고 문서화한다
- Claude CLI process lifecycle(정상 종료 판별, abort, timeout, force-kill fallback) spec을 Phase 0 결과에 따라 runner 설계에 포함한다

### 매핑 예시

#### model

- `anthropic/claude-opus-4-6` → `claude-opus-4-6`
- `anthropic/claude-sonnet-4-6` → `claude-sonnet-4-6`
- 그 외 `runtime: claude` + non-Anthropic model은 v1에서 오류 처리

#### thinking

pi의 `off|minimal|low|medium|high|xhigh`를 Claude effort에 보수적으로 매핑한다.

예시:

- `off|minimal|low` → `low`
- `medium` → `medium`
- `high|xhigh` → `high`

#### tools

frontmatter tool 목록을 Claude built-in tool 이름으로 변환하고 unsupported tool이 있으면 에러 처리한다.

### 검증

- 실제 `claude -p --output-format stream-json` 샘플을 fixtures로 저장했는지
- Claude stream event를 `SingleResult`로 normalize하는 단위 테스트
- non-Anthropic model이 명확한 에러를 내는지

---

## Task 3 — Claude 세션 메타데이터 저장

### 수정 파일

- `extensions/subagent/types.ts`
- `extensions/subagent/store.ts`
- `extensions/subagent/tool-execute.ts`
- `extensions/subagent/commands.ts`

### 작업

- `CommandRunState`에 runtime metadata 추가
- 새 run 시 Claude session metadata 생성/초기화
- continue 시 `claudeSessionId` 재사용
- `sessionFile`은 pi sidecar 유지
- Claude resume metadata(`runtime`, `claudeSessionId`, `claudeProjectDir`, 필요 시 locator`)를 start/completion `details` payload에도 저장
- parser가 관측한 runtime/session metadata를 `SingleResult`에도 실어 `updateRunFromResult()` 경로를 통해 live state에 반영한다
- `commands.ts` / `tool-execute.ts`의 세션 복원 경로에서 같은 metadata를 다시 읽어 run state를 재구성
- resumed run은 저장된 `claudeProjectDir`로 실행하며, 누락 시 즉시 오류 처리

### 검증

- `subagent continue <runId>`가 Claude run에서도 resume 동작하는지
- 세션 전환/리로드 후에도 동일 runId로 resume 가능한지

---

## Task 4 — pi sidecar session writer

### 수정 파일

- `extensions/subagent/runner.ts`
- 필요 시 `extensions/subagent/session.ts`

### 작업

Claude stream event를 받아 **기존 parser가 그대로 읽을 수 있는 pi sidecar JSONL schema**로 기록한다.

필수 envelope:

- `type: "message"`
- `timestamp`
- `message.role`
  - `user`: 현재 authoritative task와 continue prompt를 mirror
  - `assistant`: finalized text / thinking preview / finalized `toolCall` parts 포함
  - `toolResult`: tool name + 결과 preview 포함

append discipline:

- sidecar는 continue 시에도 **같은 `run.sessionFile`에 append** 하여 하나의 연속 대화처럼 보이게 한다
- live delta / preview는 **메모리에서만 유지**하고 JSONL에는 append하지 않는다
- synthetic `toolCall` part는 completed assistant turn당 1회만 기록한다
- preview용 assistant message를 여러 번 append하지 않는다

assistant content 규칙:

- live tool invocation이 시작되면 JSONL append 대신 in-memory `liveActivityPreview`를 갱신한다
- final text가 확정되면 assistant text part를 기록한다
- thinking은 전체 dump가 아니라 preview/summary 수준으로 제한한다

추가 요구:

- `readSessionReplayItems()`와 `parseSessionDetailSummary()`를 수정 없이 통과해야 한다
- widget/hang-detection parity를 위해 `liveActivityPreview`가 필요하다
- 긴 무출력 tool 실행 중에도 `lastActivityAt`가 갱신되어 false auto-abort가 나지 않아야 한다

### 검증

- `subagent detail <runId>`에서 결과가 보이는지
- replay overlay가 깨지지 않는지
- widget preview가 유지되는지
- in-progress tool invocation 동안 `→ tool(args)` preview가 보이는지
- unchanged parser compatibility test가 통과하는지

---

## Task 5 — unsupported tool / escalation 정책 적용

### 수정 파일

- `extensions/subagent/runner.ts`
- `extensions/subagent/tool-execute.ts`
- `extensions/subagent/commands.ts`

### 작업

- `runtime: claude` + unsupported tool 조합이면 fail fast
- `ask_master` 미지원 메시지 명확화
- 에러 메시지에 대응 가이드 포함
- frontmatter tool 검증 외에 runtime-specific system prompt 유도도 함께 점검한다

### 검증

- 의도된 unsupported case에서 명확한 오류 노출
- `ask_master` 관련 문구가 Claude runtime prompt/runtime path에서 제거 또는 안전한 plain-text blocker 보고로 대체되었는지

---

## Task 6 — 초기 opt-in 적용

### 수정 파일

- `agents/finder.md`
- `agents/planner.md`
- `agents/verifier.md`

### 작업

- `runtime: claude` 추가
- 단, 기본 활성화 전에 feature flag 또는 동등한 rollout gate 뒤에 둔다
- 나머지 agent는 그대로 유지

선정 이유:

- `finder`, `verifier`는 read/search/validation 중심이라 새 runtime의 관찰/검증에 적합하다
- `planner`의 write는 계획 파일 저장처럼 비교적 low-risk 출력이다
- `simplifier`는 built-in-safe tools만 쓰지만, behavior-preserving edit 품질과 retry ergonomics를 먼저 검증한 뒤 2차로 확대한다

활성화 조건:

- replay/detail compatibility acceptance check 통과
- unsupported-tool fail-fast 통과
- resume/reload acceptance check 통과
- non-interactive approval policy 검증 완료

### 검증

- 위 3개만 Claude 경로를 타는지
- 나머지는 기존 pi 경로를 타는지

---

## Task 7 — 테스트

### 테스트 범위

1. runtime frontmatter 파싱
2. `runSingleAgent()` runtime 분기
3. unsupported tool validation
4. Claude stream-json parsing (실측 fixture 기반)
5. continue 시 Claude resume metadata 사용
6. 세션 전환/리로드 후 metadata restore + resume 동작
7. replay/detail이 Claude run에서도 동작
8. widget preview / hang-detection parity
9. non-Anthropic model guard

---

## Must Have / Must Not Have

### Must Have

- `runtime: claude` opt-in
- dual-session 구조
- continue / resume 유지
- replay/detail 최소 호환
- unsupported tool fail-fast
- non-interactive approval policy
- explicit ambient config / MCP source policy
- 기존 `runtime: pi` 무영향

### Must Not Have

- Anthropics라고 자동 전환
- Claude session 파일로 기존 `sessionFile` 직접 대체
- Pi custom tool 전면 브릿지까지 한 번에 구현
- 조용한 fallback
- unsupported tool을 무시하고 진행

---

## 리스크

1. **Anthropic/OpenClaw 정책 리스크**  
   `claude -p` 경로가 장기적으로 안정적이라고 완전히 보장되지는 않는다.

2. **Claude session 포맷/저장 위치 변경 가능성**  
   session metadata 추적은 방어적으로 설계해야 한다.

3. **stream-json 포맷 변화 가능성**  
   parser는 tolerant 하게 구현해야 하며, 구현 전 실제 CLI 출력 fixture를 확보해야 한다.

4. **MCP 환경 편차**  
   Claude 쪽 MCP 설정 유무에 따라 agent 체감 능력이 달라질 수 있다.

5. **resume metadata 유실 위험**  
   `details` payload와 복원 로직까지 연결하지 않으면 `continue`가 겉으로만 이어지고 실제 Claude session continuity는 끊길 수 있다.

6. **runtime-specific prompt drift**  
   `ask_master` 같은 pi 전용 guideline이 Claude runtime prompt에 남으면 unsupported tool 정책과 충돌한다.

7. **permission prompt abort 위험**  
   `--tools`만 제한하고 `--allowedTools`/approval 정책을 고정하지 않으면 headless run이 interactive permission prompt에서 실패할 수 있다.

8. **ambient discovery drift**  
   `--bare` 없이 hooks/skills/plugins/CLAUDE.md가 암묵 로드되면 머신마다 다른 동작을 보일 수 있다.

---

## 단계별 권장 진행

### Phase 0

- 실제 `claude -p --output-format stream-json` 샘플 수집
- session identifier / resume handle 획득 지점 확인
- `cwd` 및 relevant CLI flag 동작 확인
- tool approval / permission prompt 회피 방식 확인
- process lifecycle spec 작성 (정상 종료, abort, timeout, fallback)
- fixture 저장 후 parser 설계 확정

### Phase 1

- `runtime` 필드 추가
- runtime-aware prompt policy 추가 (`ask_master` 분기 포함)
- Claude runner 추가
- explicit tool exposure / approval policy 추가
- explicit MCP config source policy 추가 (`--bare` + `--mcp-config`)
- dual-session 기본 틀 추가

### Phase 2

- replay/detail 호환 안정화
- continue/resume 검증 강화
- unsupported tool 정책 정교화
- live preview / hang-detection parity 확보
- mid-run checkpoint로 Claude session metadata 내구화

### Phase 3

- feature flag 또는 hidden opt-in 상태에서 `finder`, `planner`, `verifier` 적용
- acceptance check 통과 후 기본 opt-in 승격 여부 판단

### Phase 4

- 필요 시 Pi custom tool MCP shim 검토
- `searcher`, `simplifier` 확대 여부 판단

---

## 최종 권고

이번 구현은 다음 원칙으로 진행한다.

- **명시적 opt-in만 허용**
- **Dual-session 구조로 기존 UX를 보호**
- **v1은 Claude built-in + 명시 허용한 MCP source까지만 지원**
- **Pi 전용 도구는 fail fast**
- **`--bare` + explicit tool approval 정책으로 ambient drift를 차단**
- **초기 적용은 feature flag와 acceptance check 통과 후에만 노출**

이 문서를 기준으로 이후 구현 태스크를 세분화해 진행한다.
