# Claude Runtime Subagent 구현 계획

> `extensions/subagent/`에 `runtime: claude` opt-in을 도입해, 선택된 서브에이전트를 기존 `pi` 대신 Claude Code `claude -p` 경로로 실행하기 위한 구현 문서.
>
> 범위는 **v1: 안정적인 런타임 분기 + 세션 호환 + 기존 UX 보존**까지로 제한한다.

---

## 확정/가정/OPEN 표기 규칙

이 문서에서는 각 정책/사실의 근거를 아래 태그로 구분한다.

- **[실측]** Phase 0 관측(T00a~T00d)에서 실제로 확인한 사실. fixture 또는 관측 문서로 근거 있음.
- **[확정]** 실측 결과를 바탕으로 v1 구현 정책으로 최종 결정한 항목.
- **[가정]** 직접 관측하지 못했으나 합리적으로 추정한 항목. 구현 시 별도 검증 필요.
- **[OPEN]** 아직 결정되지 않았거나 추가 관측/실험이 필요한 항목.

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

- **[실측]** `claude -p`는 공식적인 non-interactive/headless 실행 경로다.
- **[실측]** `--output-format stream-json`, `--include-partial-messages`, `--resume`, `--tools`, `--allowedTools`, `--mcp-config`, `--strict-mcp-config`, `--verbose`를 사용할 수 있다.
- **[실측]** Claude Code는 MCP를 공식 지원한다.
- **[가정]** OpenClaw 문서 기준으로 third-party harness usage 정책 리스크는 남아 있으므로 장기 안정성이 완전히 보장되진 않는다.

### Phase 0 관측 결과 요약

실제 로컬 환경에서 T00a~T00d를 통해 아래를 확인했다.

**T00a (CLI 환경 확인) [실측]:**

```bash
$ claude --version
2.1.91 (Claude Code)

$ claude auth status --text
# usable authentication confirmed (OAuth/keychain-backed)

$ claude -p "say ok" --output-format text
ok
```

**T00b (stream-json fixture) [실측]:**

- 5개 fixture를 `extensions/subagent/fixtures/claude-stream/`에 확보
- `basic-text.ndjson`, `tool-call.ndjson`, `long-running.ndjson`, `error.ndjson`, `bare-auth-error.ndjson`
- **[실측]** 성공적인 stream-json 캡처에 `--verbose` 플래그가 필요했다 (early lifecycle metadata 확보용)

**T00c (resume/approval/MCP/cwd) [실측]:**

- 관측 결과 전문: `extensions/subagent/fixtures/claude-observations.md`
- `--bare`는 현재 환경에서 auth blocker
- `--tools` + `--allowedTools` 조합으로 permission prompt 회피 가능
- `--mcp-config` + `--strict-mcp-config`로 MCP source 제한 가능
- resume는 same-cwd에서만 동작

**T00d (lifecycle spec) [실측]:**

- 프로세스 lifecycle 전문: `extensions/subagent/fixtures/claude-process-lifecycle.md`
- `type: "result"` event가 유일한 definitive completion signal
- abort/fallback/stall 정책 정의 완료

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

### 접근법 A -- 단순 교체

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

### 접근법 B -- Dual-session 호환 레이어

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

### 접근법 C -- 처음부터 Pi custom tools까지 Claude MCP shim으로 완전 이식

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

### Cycle 3: Phase 0 실측 반영 (T01)

문제점:

1. **[실측]** `--bare`가 현재 환경에서 auth blocker -- 기본 정책으로 사용 불가
2. **[실측]** `--verbose`가 early lifecycle metadata 확보에 필요
3. **[실측]** `--strict-mcp-config`는 MCP만 제한하고 hooks/plugins/skills는 여전히 실행됨
4. **[실측]** resume는 cwd-scoped -- cross-cwd resume 불가

반영:

- `--bare` 기본 사용 정책을 **폐기**하고 non-bare + 명시적 제한 조합으로 전환
- `--verbose` 플래그를 stream-json 실행 시 **필수 플래그**로 추가
- ambient config 격리 정책을 `--strict-mcp-config` + 가능한 범위 내 명시적 제한으로 재정의
- `claudeProjectDir` 저장/복원을 **필수** 로직으로 확정

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
- `claudeSessionId?: string` -- **[실측]** UUID 형식 (예: `f110cdeb-3b75-4dd8-a8f8-f09d762ef971`)
- `claudeProjectDir?: string` -- **[실측]** resume는 same-cwd에서만 동작하므로 원래 cwd를 반드시 저장
- `claudeSessionPath?: string`
- `claudeSessionSource?: "stream" | "details-restore" | "unknown"`

핵심 원칙:

- `sessionFile`은 **pi sidecar session**으로 유지
- Claude session은 **resume용 메타데이터**로만 별도 저장
- Claude resume metadata는 메모리에만 두지 않고, `subagent-command` / `subagent-tool` message `details`에도 직렬화해 세션 전환/리로드 후 복원 가능해야 한다

---

## 4. Claude runner: stream-json 기반

Claude 실행은 text 출력만 받는 방식이 아니라 event stream 파싱 방식으로 구현한다.

### 4.1 실행 플래그 [확정]

```bash
claude -p \
  --output-format stream-json \
  --verbose \
  --include-partial-messages \
  ...
```

**[확정]** `--bare`는 사용하지 않는다.
- **[실측]** `--bare`는 현재 환경에서 OAuth/keychain-backed login을 무시하고 즉시 `Not logged in` 에러를 발생시킨다 (T00c 관측).
- `--bare`는 API key 기반 auth에서만 동작하며, 현재 환경의 인증 방식과 호환되지 않는다.

**[확정]** `--verbose`는 필수 플래그다.
- **[실측]** `--verbose` 없이는 early lifecycle metadata(hook events, init event의 session_id 등)가 stream-json 출력에 포함되지 않았다 (T00b/T00c 관측).
- parser가 `session_id`를 최대한 일찍 캡처하려면 `--verbose`가 필요하다.

필요 시 추가:

- `--resume <session-uuid>` -- **[실측]** UUID 형식
- `--append-system-prompt-file <path>`
- `--allowedTools ...` -- **[실측]** Edit/Write에 필수
- `--tools ...` -- **[실측]** tool 노출 제어
- `--mcp-config <file>` + `--strict-mcp-config` -- **[실측]** MCP isolation에 필요

### 4.2 Ambient config 정책 [확정]

**[실측에 의한 정책 변경]** 기존 계획의 `--bare` 기본값 정책을 **폐기**한다.

v1의 `runtime: claude`는 **non-bare 모드**에서 아래 명시적 제한을 적용한다:

| 대상 | 격리 방법 | 근거 |
|---|---|---|
| MCP servers | `--mcp-config <file>` + `--strict-mcp-config` | **[실측]** `--strict-mcp-config` 없이는 ambient MCP가 merge됨 (T00c 5-a vs 5-b) |
| Tool exposure | `--tools` + `--allowedTools` | **[실측]** Edit/Write는 `--allowedTools` 없이 permission denial (T00c 4-b, 4-d) |
| Hooks | [OPEN] non-bare 모드에서 hooks가 실행됨 | **[실측]** pre-init `hook_started`/`hook_response`가 `init` 전에 발생 (T00c 관측). `--strict-mcp-config`는 hooks를 제한하지 않음 |
| Plugins/Skills | [OPEN] non-bare 모드에서 ambient 로드됨 | **[실측]** init event에서 plugins/skills 목록이 관측됨 (fixture 참조) |
| CLAUDE.md | [OPEN] non-bare 모드에서 auto-discovery 발생 가능 | **[가정]** 실제 영향은 prompt에 추가 context가 들어오는 것이므로 v1에서는 허용 범위로 봄 |

**[확정]** ambient config에 대한 v1 정책:
- MCP: `--strict-mcp-config`로 **완전히 제한** (실측으로 검증됨)
- Tools/Approval: `--tools` + `--allowedTools`로 **완전히 제한** (실측으로 검증됨)
- Hooks/Plugins/Skills/CLAUDE.md: **[OPEN]** v1에서는 non-bare 실행의 부수효과로 허용하되, 예기치 않은 동작 발생 시 대응 방안을 사전에 마련한다. `--bare` 사용을 위해서는 API key 기반 auth 전환이 선행되어야 한다.

### 4.3 확정된 stream event schema [실측]

fixture 기반으로 확정된 event type 및 구조. Parser source of truth: `extensions/subagent/fixtures/claude-stream/*.ndjson`

#### Top-level event types

| `type` | `subtype` (있을 경우) | 의미 | 확정 여부 |
|---|---|---|---|
| `system` | `hook_started` | hook 실행 시작 | **[실측]** |
| `system` | `hook_response` | hook 실행 완료 | **[실측]** |
| `system` | `init` | 세션 초기화 | **[실측]** |
| `stream_event` | -- | Anthropic API streaming event wrapper | **[실측]** |
| `assistant` | -- | finalized assistant message snapshot (per-turn) | **[실측]** |
| `user` | -- | tool_result를 담는 user event (inter-turn) | **[실측]** |
| `rate_limit_event` | -- | rate limit 상태 | **[실측]** |
| `result` | `success` | 최종 완료 event (유일한 definitive completion signal) | **[실측]** |

#### `system/init` event 필드 [실측]

```typescript
{
  type: "system",
  subtype: "init",
  cwd: string,              // 실행 working directory
  session_id: string,       // UUID
  tools: string[],          // 사용 가능한 tool 목록
  mcp_servers: Array<{name: string, status: string}>,
  model: string,            // e.g. "claude-opus-4-6[1m]"
  permissionMode: string,   // e.g. "dontAsk"
  plugins: Array<{name: string, path: string, source: string}>,
  skills: string[],
  slash_commands: string[],
  agents: string[],
  apiKeySource: string,
  claude_code_version: string,
  fast_mode_state: string,
  uuid: string
}
```

#### `stream_event` wrapper 내부의 Anthropic event types [실측]

| `event.type` | 주요 필드 | 용도 |
|---|---|---|
| `message_start` | `message.model`, `message.usage` | turn 시작 |
| `content_block_start` | `content_block.type` (`"text"` or `"tool_use"`), `content_block.id`, `content_block.name` (tool_use) | content block 시작 |
| `content_block_delta` | `delta.type` (`"text_delta"` or `"input_json_delta"`), `delta.text` or `delta.partial_json` | streaming delta |
| `content_block_stop` | `index` | content block 완료 |
| `message_delta` | `delta.stop_reason` (`"end_turn"` or `"tool_use"`), `usage` | turn 종료 |
| `message_stop` | -- | message 완료 |

#### `assistant` snapshot event 필드 [실측]

```typescript
{
  type: "assistant",
  message: {
    model: string,
    id: string,
    role: "assistant",
    content: Array<{type: "text", text: string} | {type: "tool_use", id: string, name: string, input: object}>,
    stop_reason: string | null,
    usage: object,
    context_management: object | null
  },
  session_id: string,
  parent_tool_use_id: string | null
}
```

#### `user` (tool_result) event 필드 [실측]

```typescript
{
  type: "user",
  message: {
    role: "user",
    content: [{
      tool_use_id: string,
      type: "tool_result",
      content: string,
      is_error: boolean
    }]
  },
  session_id: string,
  tool_use_result: {
    stdout: string,
    stderr: string,
    interrupted: boolean,
    isImage: boolean
  }
}
```

#### `result` event 필드 [실측]

```typescript
{
  type: "result",
  subtype: "success",
  is_error: boolean,          // false=정상, true=auth failure 등
  result: string,             // 최종 텍스트 출력
  stop_reason: string,        // "end_turn" (정상) | "stop_sequence" (auth failure)
  session_id: string,         // UUID
  duration_ms: number,
  duration_api_ms: number,
  num_turns: number,
  total_cost_usd: number,
  usage: object,              // aggregate token counts
  modelUsage: object,         // per-model breakdown
  permission_denials: Array<{tool_name: string, tool_use_id: string, tool_input: object}>,
  terminal_reason: string,    // "completed"
  fast_mode_state: string
}
```

#### [OPEN] 미관측 event types

- `type: "thinking"` content_block -- extended thinking이 활성화된 fixture는 아직 없음
- `rate_limit_event`에서 `status !== "allowed"` -- throttled case 미관측

### 4.4 Tolerant parser 요구사항 [확정]

- **[확정]** parser는 알 수 없는 `type`이나 `subtype`을 만나면 **무시(skip)**하되 로그에 기록한다
- **[확정]** `session_id`는 첫 번째 파싱된 event에서 캡처한다 (hook_started부터 사용 가능)
- **[확정]** `type: "result"` event만을 definitive completion signal로 취급한다
- **[확정]** `assistant` snapshot event는 per-turn finalized data이며, 최종 완료 신호가 아니다
- **[가정]** CLI 버전 업데이트로 event schema에 필드가 추가될 수 있으므로, 알 수 없는 필드는 무시한다
- **[OPEN]** `stream_event` wrapper 안에 `type: "thinking"` content_block이 올 경우의 파싱 로직은 fixture 확보 후 결정

### 4.5 SingleResult normalize 대상 [확정]

| 필드 | 소스 | 확정 여부 |
|---|---|---|
| `messages` | `assistant` snapshot events 수집 | **[확정]** |
| `usage` | `result.usage` (aggregate) | **[실측]** |
| `model` | `system/init.model` 또는 `assistant.message.model` | **[실측]** |
| `thoughtText` | [OPEN] thinking content_block | **[OPEN]** |
| `liveText` | `content_block_delta` with `text_delta` 누적 | **[실측]** |
| `liveToolCalls` | `content_block_start` with `type: "tool_use"` 카운트 | **[실측]** |
| `liveActivityPreview` | in-progress tool invocation `-> tool(args)` 형태 | **[확정]** |
| `stopReason` | `result.stop_reason` | **[실측]** |
| `claudeSessionId` | `session_id` from first event | **[실측]** |
| `claudeProjectDir` | `system/init.cwd` 또는 spawn 시 전달한 cwd | **[실측]** |
| `errorMessage` | `result.is_error === true`일 때 `result.result` | **[실측]** |
| `permissionDenials` | `result.permission_denials` | **[실측]** |
| `cost` | `result.total_cost_usd` | **[실측]** |

`liveActivityPreview`는 widget/hang-detection parity를 위해 필요하며, in-progress tool invocation 동안 `-> tool(args)` 형태의 상태를 유지할 수 있어야 한다.

### 4.6 Non-interactive approval policy [확정]

`runtime: claude`는 permission prompt가 뜨면 안 된다. v1에서는 아래 둘을 모두 명시한다.

1. `--tools`는 mapped tool set만 노출
2. `--allowedTools`는 같은 mapped tool set에서 자동 생성

**[실측]** 관측 결과:
- `Bash`는 `--tools Bash`만으로 `--allowedTools` 없이 동작함 (T00c 4-a)
- `Edit`와 `Write`는 `--tools`만으로는 `permission_denials`가 발생하며, `--allowedTools`를 추가해야 동작함 (T00c 4-b~4-e)
- `Read`는 별도의 allowlist 없이 동작 [가정 -- 직접 관측은 Edit/Write와 함께 사용된 경우만]

**[확정]** 안전을 위해 v1에서는 **모든 mapped tool에 대해 `--tools`와 `--allowedTools`를 동시에 지정**한다. tool별 permission 차이에 의존하지 않는다.

**[확정]** `result.permission_denials`가 비어 있지 않으면 runner는 이를 configuration error로 취급하고 에러를 보고한다.

### 4.7 Process lifecycle [확정]

전체 lifecycle spec: `extensions/subagent/fixtures/claude-process-lifecycle.md`

요약:

**정상 종료 [실측]:**
- `type: "result"` event가 유일한 definitive completion signal
- `result.is_error === false` + `result.permission_denials.length === 0` + `result.stop_reason === "end_turn"` → SUCCESS
- `result.is_error === true` → ERROR
- `result.permission_denials.length > 0` → configuration error

**Event sequence (basic text) [실측]:**
```
system/hook_started (x N)
system/hook_response (x N)
system/init
stream_event/message_start
stream_event/content_block_start (type: "text")
stream_event/content_block_delta (type: "text_delta") [x N]
assistant (finalized)
stream_event/content_block_stop
stream_event/message_delta (stop_reason: "end_turn")
stream_event/message_stop
rate_limit_event
result (subtype: "success")
```

**Event sequence (tool-use) [실측]:**
```
system/* (hooks, init)
stream_event/message_start
stream_event/content_block_start (type: "tool_use")
stream_event/content_block_delta (type: "input_json_delta") [x N]
assistant (finalized with tool_use content)
stream_event/content_block_stop
stream_event/message_delta (stop_reason: "tool_use")
stream_event/message_stop
rate_limit_event
user (tool_result)
stream_event/message_start (turn 2)
... text deltas ...
assistant (finalized)
result
```

**[실측]** tool 실행 중에는 stream event가 발생하지 않는다 (long-running.ndjson에서 ~5초 무출력 구간 관측).

**Abort handling [확정] (pi runner parity):**
```typescript
signal.addEventListener("abort", () => {
    wasAborted = true;
    proc.kill("SIGTERM");
    setTimeout(() => {
        if (!procExited && proc.exitCode === null)
            proc.kill("SIGKILL");
    }, 5000);
}, { once: true });
```

**Post-result linger [확정]:**
- `result` event 수신 후 process가 3000ms 내에 종료되지 않으면 SIGTERM
- SIGTERM 후 5000ms 내에 종료되지 않으면 SIGKILL
- promise는 `result` 수신 즉시 resolve (process exit를 기다리지 않음)

**Stall detection [확정 + OPEN]:**
- 마지막 event timestamp로부터 inactivity timer 운용
- **[OPEN]** inactivity timeout 값은 경험적 튜닝 필요 (tool 실행 중 정당한 무출력 구간이 길 수 있음)
- SIGTERM->SIGKILL grace: 5000ms (pi runner와 동일)

**[OPEN] items:**
- exit code 수집은 `proc.on("exit")`/`proc.on("close")`로 별도 처리 필요
- SIGTERM이 Claude의 하위 프로세스(MCP server, tool execution)까지 전파되는지 미검증
- `rate_limit_event`에서 `status !== "allowed"`일 때의 동작 미관측

---

## 5. 컨텍스트 전략

### 첫 run

기존 pi가 잘하는 main-context wrapping을 그대로 활용한다.

- `wrapTaskWithMainContext(...)`
- `[HISTORY -- REFERENCE ONLY]`
- `[REQUEST -- AUTHORITATIVE]`

즉 첫 run은 현재의 안전한 wrapping을 그대로 사용한다.

### continue run

continue 이후부터는:

- **[실측]** `claudeSessionId`가 있으면 `--resume <uuid>` 사용 (UUID 형식 확인됨)
- **[실측]** resume는 **반드시 동일 cwd에서** 실행해야 한다 (cross-cwd resume 시 `No conversation found` 에러)
- 새 authoritative task만 새 user prompt로 전달
- `claudeSessionId`가 없으면 조용히 새 세션으로 진행하지 않고 명시적 오류로 중단하거나, 사용자/호출자에게 resume 불가 상태를 분명히 알린다

이는 `claude-code-query.ts`가 이전 대화를 저장하고 마지막 user prompt만 보내는 패턴과 방향이 같다.

### Claude resume metadata lifecycle [확정]

1. **[실측]** session_id는 첫 번째 stream event에서 읽을 수 있다 (hook_started부터 session_id 포함)
2. **[실측]** `system/init`의 `cwd` 필드 또는 spawn 시 전달한 cwd를 `claudeProjectDir`로 저장
3. 그 값을 `SingleResult` -> `CommandRunState`로 전파
4. 같은 값을 start/completion `details` payload에도 기록
5. 세션 복원 로직(`commands.ts`, `tool-execute.ts` 경로)에서 다시 읽어 `continue`에 재사용
6. **[실측]** resumed Claude run은 **저장된 `claudeProjectDir`**로 spawn 하며, metadata가 없거나 mismatch면 hard-fail 한다
7. 리로드 후 `subagent continue <runId>`가 동일 Claude session을 resume하는 acceptance check 추가

추가 정책:

- `claudeSessionId`가 mid-run에 처음 관측되면 completion까지 기다리지 말고 **중간 체크포인트**로도 persistence 해야 한다
- 최소한 hidden status/custom message 또는 동등한 durable checkpoint 경로를 하나 정의해, start 후 crash가 나도 resume handle을 잃지 않도록 한다

**[실측]** Claude session persistence 경로:
- print-mode 세션은 `~/.claude/projects/<cwd-encoded>/<session-uuid>.jsonl`로 저장됨
- 이 경로는 cwd에 의존하므로 `claudeProjectDir` 보존이 필수

---

## 6. 도구 정책 (v1) [확정]

### 허용

`runtime: claude`에서 우선 지원하는 도구:

- `Read` -- **[실측]** 동작 확인 (tool-call fixture)
- `Bash` -- **[실측]** `--tools Bash`로 permission 없이 동작 (T00c 4-a)
- `Edit` -- **[실측]** `--tools Edit --allowedTools Edit`로 동작 (T00c 4-c)
- `Write` -- **[실측]** `--tools Write --allowedTools Write`로 동작 (T00c 4-e)
- `Grep` -- **[가정]** Read-only tool이므로 Read와 동일하게 동작할 것으로 추정
- `Glob` -- **[가정]** Read-only tool이므로 Read와 동일하게 동작할 것으로 추정
- `LS` -- **[가정]** Read-only tool이므로 Read와 동일하게 동작할 것으로 추정

**[확정]** 모든 mapped tool에 `--tools`와 `--allowedTools`를 동시 지정한다.

MCP 정책:

- **[실측]** `--mcp-config`만으로는 ambient MCP server가 merge된다 (T00c 5-a)
- **[실측]** `--mcp-config` + `--strict-mcp-config`로 MCP source를 명시적으로 제한할 수 있다 (T00c 5-b)
- **[확정]** v1에서는 `--strict-mcp-config`를 필수로 사용하고, 허용할 MCP config만 명시 전달한다
- **[OPEN]** 어떤 MCP source를 기본 허용할지는 agent별로 결정 필요

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

### 정책 [확정]

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

## Task 2 -- Agent 선언 확장

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

### Acceptance Criteria (T02)

1. `AgentConfig` type에 `runtime` 필드가 존재하고 typecheck 통과
2. `runtime: claude`로 선언된 agent에서 `ask_master` 관련 문구가 system prompt에 없음
3. `runtime` 미지정 agent의 기존 동작에 변화 없음 (regression test)

---

## Task 3 -- Claude 런타임 분기 추가

### 수정 파일

- `extensions/subagent/runner.ts`

### 작업

- `runClaudeAgent()` 추가
- `runClaudeAgent()`는 `runSingleAgent()`와 동일한 호출 계약(`signal`, `onUpdate`, `makeDetails`, `SingleResult` 반환)을 유지해 `launchRunInBackground()` / `finalizeRunState()` / `updateRunFromResult()`를 수정 최소화로 재사용할 수 있게 한다
- `runSingleAgent()`에서 runtime 분기
- model / thinking / tool 매핑 함수 추가
- 기존 `extensions/utils/agent-utils.ts`의 `CLAUDE_TOOL_MAP`, `normalizeTools(..., "claude")`는 **Claude->pi 방향**임을 명시하고, `runtime: claude`에는 필요 시 별도 `PI_TO_CLAUDE_TOOL_MAP` 또는 동등한 역방향 매핑을 둔다
- `runtime: claude`에서는 non-Anthropic model을 명시적으로 거부하거나 허용 규칙을 문서화한다 (v1 권장: 거부)
- **[확정]** cwd 전달: spawn 시 `cwd` option에 agent 실행 경로를 전달하고, 이를 `claudeProjectDir`로 저장
- **[확정]** `--verbose` 플래그 필수 포함
- **[확정]** `--bare` 사용하지 않음

### 매핑 예시

#### model

- `anthropic/claude-opus-4-6` -> `claude-opus-4-6`
- `anthropic/claude-sonnet-4-6` -> `claude-sonnet-4-6`
- 그 외 `runtime: claude` + non-Anthropic model은 v1에서 오류 처리

#### thinking

pi의 `off|minimal|low|medium|high|xhigh`를 Claude effort에 보수적으로 매핑한다.

예시:

- `off|minimal|low` -> `low`
- `medium` -> `medium`
- `high|xhigh` -> `high`

#### tools

frontmatter tool 목록을 Claude built-in tool 이름으로 변환하고 unsupported tool이 있으면 에러 처리한다.
**[확정]** 변환된 tool 목록으로 `--tools`와 `--allowedTools`를 **동시에** 생성한다.

### Acceptance Criteria (T03)

1. `runClaudeAgent()` skeleton이 `SingleResult`를 반환하는 호출 계약 유지
2. `launchRunInBackground()`/`finalizeRunState()`/`updateRunFromResult()` 재사용에 대규모 변경 불필요
3. non-Anthropic model에서 명확한 에러
4. unsupported tool에서 명확한 에러
5. 생성된 CLI 인수에 `--verbose` 포함, `--bare` 미포함

### 검증

- 실제 `claude -p --output-format stream-json` 샘플을 fixtures로 저장했는지
- Claude stream event를 `SingleResult`로 normalize하는 단위 테스트
- non-Anthropic model이 명확한 에러를 내는지

---

## Task 4 -- approval/MCP/ambient config 정책 코드화

### 수정 파일

- `extensions/subagent/runner.ts`
- 필요 시 `extensions/subagent/session.ts`
- 필요 시 util/helper 파일

### 작업

- **[확정]** `--bare` 사용하지 않음 (auth blocker)
- **[확정]** mapped tool set으로 `--tools`와 `--allowedTools`를 모두 생성
- **[확정]** `--mcp-config` + `--strict-mcp-config`로 허용된 MCP config source만 주입
- **[OPEN]** hooks/plugins/skills ambient 로드에 대한 방어 (v1에서는 허용하되 모니터링)

### Acceptance Criteria (T04)

1. Bash/Edit/Write 사용하는 에이전트가 `permission_denials` 없이 완료
2. `result.permission_denials` 체크가 runner에 구현됨
3. `--strict-mcp-config`가 CLI 인수에 포함됨
4. ambient MCP server가 `init.mcp_servers`에 나타나지 않음 (strict mode)

### 검증

- Bash/Edit/Write 사용하는 에이전트가 permission prompt 없이 완료 가능해야 함
- disallowed ambient source가 자동 로드되지 않아야 함

---

## Task 5 -- Claude stream parser + lifecycle 구현

### 수정 파일

- `extensions/subagent/runner.ts`
- 신규 test files
- fixture files 사용

### 작업

- `claude -p --output-format stream-json --verbose` parser 구현
- **[실측]** fixture 기반으로 아래 파싱 구현:
  - `system/init` -> session_id, cwd, model 캡처
  - `stream_event/content_block_start` (text/tool_use) -> content block 추적
  - `stream_event/content_block_delta` (text_delta/input_json_delta) -> live text/tool input 누적
  - `assistant` snapshot -> finalized message 수집
  - `user` tool_result -> tool result 수집
  - `result` -> completion, usage, cost, permission_denials
  - `system/hook_*` -> 로그만 (skip해도 기능에 영향 없음)
  - `rate_limit_event` -> 로그만
- **[확정]** lifecycle spec 반영 (section 4.7 참조)
  - 정상 종료: `result` event 기반
  - abort: SIGTERM -> SIGKILL (5s grace)
  - post-result linger: 3s -> SIGTERM -> 5s -> SIGKILL
  - stall detection: [OPEN] timeout 값
  - stderr 수집: `proc.stderr.on("data")`

### Acceptance Criteria (T05)

1. `basic-text.ndjson` fixture에서 text 응답을 정확히 파싱
2. `tool-call.ndjson` fixture에서 tool_use -> tool_result -> text 응답 파싱
3. `long-running.ndjson` fixture에서 silent gap 동안 hang detector 미작동
4. `error.ndjson` fixture에서 permission_denials 검출
5. `bare-auth-error.ndjson` fixture에서 `is_error: true` 검출
6. 알 수 없는 event type을 만나면 skip + 로그
7. session_id가 첫 event에서 캡처됨

### 검증

```bash
cd extensions && pnpm exec vitest run --config utils/vitest.config.ts <claude-runner-parser-test>
cd extensions && pnpm run typecheck
```

---

## Task 6 -- Claude 세션 메타데이터 저장

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
- **[실측]** resumed run은 저장된 `claudeProjectDir`로 실행하며, 누락 시 즉시 오류 처리 (cross-cwd resume 불가)

### Acceptance Criteria (T06)

1. `subagent continue <runId>`가 동일 `claudeSessionId`로 `--resume` 호출
2. 세션 전환/리로드 후에도 동일 runId로 resume 가능
3. `claudeProjectDir` 누락/mismatch 시 hard-fail
4. mid-run crash 후에도 session_id가 durable checkpoint에서 복원 가능

### 검증

- `subagent continue <runId>`가 Claude run에서도 resume 동작하는지
- 세션 전환/리로드 후에도 동일 runId로 resume 가능한지

---

## Task 7 -- pi sidecar session writer

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

### Acceptance Criteria (T07)

1. `readSessionReplayItems()` 수정 없이 sidecar를 읽을 수 있음
2. `parseSessionDetailSummary()` 수정 없이 올바른 요약 생성
3. turn 수 / final output / tool call 집계가 왜곡되지 않음
4. continue 후에도 같은 sidecar file에 append됨

### 검증

- `subagent detail <runId>`에서 결과가 보이는지
- replay overlay가 깨지지 않는지
- widget preview가 유지되는지
- in-progress tool invocation 동안 `-> tool(args)` preview가 보이는지
- unchanged parser compatibility test가 통과하는지

---

## Task 8 -- live preview / hang-detection parity

### 수정 파일

- `extensions/subagent/store.ts`
- `extensions/subagent/runner.ts`
- 필요 시 `extensions/subagent/index.ts`
- 테스트 파일

### 작업

- in-memory `liveActivityPreview` 업데이트 경로 추가
- **[실측]** 긴 tool 실행 중 stream event가 발생하지 않으므로 (long-running.ndjson 관측), tool_use content_block_start 시점에 `lastActivityAt` 갱신
- false auto-abort 방지
- widget에 `-> tool(args)` preview 유지

### Acceptance Criteria (T08)

1. long-running fixture replay 시 hang detector 미작동
2. in-progress tool preview가 widget에 노출
3. tool 실행 중 `lastActivityAt`가 tool_use 시작 시점 이후로 유지됨

### 검증

- long-running fixture에서 hang detector 오작동 없음
- in-progress tool preview가 widget에 노출

---

## Task 9 -- unsupported tool / escalation 정책 적용

### 수정 파일

- `extensions/subagent/runner.ts`
- `extensions/subagent/tool-execute.ts`
- `extensions/subagent/commands.ts`

### 작업

- `runtime: claude` + unsupported tool 조합이면 fail fast
- `ask_master` 미지원 메시지 명확화
- 에러 메시지에 대응 가이드 포함
- frontmatter tool 검증 외에 runtime-specific system prompt 유도도 함께 점검한다

### Acceptance Criteria (T09)

1. unsupported tool 선언 시 실행 전 에러와 해당 tool 이름 노출
2. `ask_master` 관련 문구가 Claude runtime prompt에서 제거/대체됨
3. 조용한 fallback 없음

### 검증

- 의도된 unsupported case에서 명확한 오류 노출
- `ask_master` 관련 문구가 Claude runtime prompt/runtime path에서 제거 또는 안전한 plain-text blocker 보고로 대체되었는지

---

## Task 10 -- commands/tool-execute 통합

### 수정 파일

- `extensions/subagent/commands.ts`
- `extensions/subagent/tool-execute.ts`
- 필요 시 `extensions/subagent/store.ts`

### 작업

- 단일 run / continue / batch / chain 경로에서 runtime metadata 전달
- `runSingleAgent()` 분기와 세션/상태/세부정보 경로 연결
- `subagent runs`, `detail`, follow-up completion이 Claude runtime에서도 자연스럽게 동작하도록 조정

### Acceptance Criteria (T10)

1. command 경로와 tool 경로 모두 동일 runtime 정책 적용
2. Claude run의 continue/completion/pending delivery 정상 동작
3. `subagent runs` 목록에 Claude run이 올바르게 표시

### 검증

- command/tool 경로 중 하나만 metadata를 잃으면 이 태스크에서 통합 재정렬

---

## Task 11 -- 초기 opt-in 적용

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

### Acceptance Criteria (T11)

1. feature flag off: 기존 동작 동일
2. feature flag on: 지정 3개만 Claude runtime 사용
3. 나머지 agent는 기존 `pi` 유지
4. rollback이 feature flag toggle만으로 가능

### 검증

- 위 3개만 Claude 경로를 타는지
- 나머지는 기존 pi 경로를 타는지

---

## Must Have / Must Not Have

### Must Have

- `runtime: claude` opt-in
- dual-session 구조
- continue / resume 유지 -- **[실측]** same-cwd resume 동작 확인
- replay/detail 최소 호환
- unsupported tool fail-fast
- non-interactive approval policy -- **[실측]** `--tools` + `--allowedTools` 조합으로 가능
- **[확정]** `--strict-mcp-config` 기반 MCP source 격리
- 기존 `runtime: pi` 무영향
- **[확정]** `--verbose` 필수 플래그
- **[확정]** `--bare` 미사용

### Must Not Have

- Anthropics라고 자동 전환
- Claude session 파일로 기존 `sessionFile` 직접 대체
- Pi custom tool 전면 브릿지까지 한 번에 구현
- 조용한 fallback
- unsupported tool을 무시하고 진행
- **[확정]** `--bare` 사용 (auth blocker)

---

## 리스크

1. **Anthropic/OpenClaw 정책 리스크**
   `claude -p` 경로가 장기적으로 안정적이라고 완전히 보장되지는 않는다.

2. **Claude session 포맷/저장 위치 변경 가능성**
   **[실측]** 현재 `~/.claude/projects/<cwd-encoded>/<uuid>.jsonl`로 저장됨. 이 경로가 바뀌면 resume이 깨질 수 있다.

3. **stream-json 포맷 변화 가능성**
   **[확정]** parser는 tolerant 하게 구현하며, **[실측]** fixture를 source of truth로 사용한다. 알 수 없는 event/field는 무시한다.

4. **MCP 환경 편차**
   **[실측]** `--strict-mcp-config`로 MCP source는 제한 가능하나, hooks/plugins/skills는 여전히 실행됨.

5. **resume metadata 유실 위험**
   `details` payload와 복원 로직까지 연결하지 않으면 `continue`가 겉으로만 이어지고 실제 Claude session continuity는 끊길 수 있다. **[실측]** session_id는 첫 event에서 캡처 가능하므로 mid-run checkpoint가 가능하다.

6. **runtime-specific prompt drift**
   `ask_master` 같은 pi 전용 guideline이 Claude runtime prompt에 남으면 unsupported tool 정책과 충돌한다.

7. **permission prompt abort 위험**
   **[실측]** `--tools`만 제한하고 `--allowedTools`를 고정하지 않으면 `permission_denials`가 발생한다. v1에서는 둘 다 필수로 지정한다.

8. **Hooks/Plugins ambient 실행**
   **[실측]** non-bare 모드에서 hooks가 `init` 전에 실행되고, plugins/skills가 로드된다. `--bare` 없이는 이를 완전히 차단할 수 없다. v1에서는 이를 허용 범위로 보되 모니터링한다.

9. **[OPEN] Inactivity timeout 튜닝**
   **[실측]** tool 실행 중 stream event가 없으므로 (`long-running.ndjson`에서 ~5초 무출력), 과도하게 짧은 timeout은 false abort를 유발한다.

---

## 단계별 권장 진행

### Phase 0 [완료]

- **[실측]** `claude -p --output-format stream-json --verbose` 샘플 수집 완료
- **[실측]** session identifier / resume handle 획득 지점 확인 완료 (첫 event의 session_id)
- **[실측]** `cwd` 및 relevant CLI flag 동작 확인 완료
- **[실측]** tool approval / permission prompt 회피 방식 확인 완료
- **[실측]** process lifecycle spec 작성 완료
- **[실측]** fixture 저장 완료, parser 설계 확정

### Phase 1

- `runtime` 필드 추가
- runtime-aware prompt policy 추가 (`ask_master` 분기 포함)
- Claude runner 추가
- **[확정]** `--tools` + `--allowedTools` explicit approval policy
- **[확정]** `--mcp-config` + `--strict-mcp-config` MCP source policy
- **[확정]** `--verbose` 필수
- **[확정]** `--bare` 미사용
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
- **[OPEN]** hooks/plugins/skills 격리 방안 (API key auth 전환 또는 `--bare` 재검토)

---

## 최종 권고

이번 구현은 다음 원칙으로 진행한다.

- **명시적 opt-in만 허용**
- **Dual-session 구조로 기존 UX를 보호**
- **v1은 Claude built-in + 명시 허용한 MCP source까지만 지원**
- **Pi 전용 도구는 fail fast**
- **[확정] non-bare + `--strict-mcp-config` + `--tools`/`--allowedTools` + `--verbose` 조합으로 ambient drift를 최소화** (`--bare` 폐기)
- **초기 적용은 feature flag와 acceptance check 통과 후에만 노출**

이 문서를 기준으로 이후 구현 태스크를 세분화해 진행한다.
