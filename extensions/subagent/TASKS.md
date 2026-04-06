# Claude Runtime Subagent Tasks

> 기준 문서: `extensions/subagent/CLAUDE_RUNTIME_PLAN.md`
>
> 목표: `runtime: claude` opt-in 서브에이전트를 기존 `pi` 런타임과 공존시키되, 기존 subagent UX(`runs/detail/replay/widget/continue`)를 깨지 않고 단계적으로 도입한다.

---

## 운영 원칙

### Hard Gates

아래 조건을 만족하지 못하면 **다음 태스크로 넘어가지 않는다**.

1. **Phase 0 관측 결과가 문서화되기 전에는 parser/runner 구현 금지**
2. **resume/reload acceptance가 통과하기 전에는 opt-in agent 활성화 금지**
3. **replay/detail compatibility가 통과하기 전에는 rollout 금지**
4. **interactive permission prompt가 남아 있으면 `runtime: claude` rollout 금지**

### Global Verification Baseline

모든 구현 태스크 완료 후 최소 실행:

```bash
cd extensions && pnpm run typecheck
cd extensions && pnpm run test
```

권장 추가 검증:

```bash
cd extensions && pnpm exec vitest run --config utils/vitest.config.ts <target-test-file>
```

### 피드백 루프 공통 규칙

각 태스크는 아래 루프를 따른다.

1. 구현/문서화
2. 태스크별 acceptance check 실행
3. 실패 시 즉시 원인 분류
   - **관측 불일치** → 선행 Phase/Spec 태스크로 되돌아감
   - **계약 불일치** → 바로 직전 의존 태스크로 되돌아감
   - **테스트 누락** → 현재 태스크에서 보완 후 재실행
4. acceptance 통과 전까지 다음 태스크 진행 금지

---

## 의존성 맵

```text
T00a CLI 환경/버전 확인 ─┬─> T00d 프로세스/종료 계약 문서화 ─┐
T00b stream-json fixture 수집 ─┼─────────────────────────────┤
T00c resume/approval/MCP/cwd 실험 ─┘                             │
                                                                  v
                                                           T01 Phase 0 결과를 계획에 반영
                                                                  |
                                                                  v
                                                  T02 runtime/type/prompt 정책 추가
                                                          /                     \
                                                         v                       v
                                     T03 runner 계약/분기/역방향 매핑        T04 approval/MCP/config 정책 코드화
                                                         \                       /
                                                          v                     v
                                                           T05 Claude stream parser + lifecycle
                                                          /            |             \
                                                         v             v              v
                                     T06 session metadata 전파/복원   T07 sidecar writer   T08 live preview/hang-detection
                                                          \            |             /
                                                           v           v            v
                                                          T09 commands/tool-execute 통합
                                                                  |
                                                                  v
                                                          T10 테스트/acceptance 통합
                                                                  |
                                                                  v
                                                     T11 feature flag + 초기 opt-in rollout
```

---

## 병렬 실행 웨이브

### Wave 0 — 관측/사실 수집
병렬 가능:
- `T00a`
- `T00b`
- `T00c`

순차:
- `T00d`
- `T01`

### Wave 1 — 타입/정책 기초
순차:
- `T02`

병렬 가능:
- `T03`
- `T04`

### Wave 2 — Claude 런타임 핵심
순차:
- `T05`

병렬 가능:
- `T06`
- `T07`
- `T08`

### Wave 3 — 통합/게이트
순차:
- `T09`
- `T10`
- `T11`

---

# Task 목록

## T00a — Claude CLI 환경/버전 확인

**성격:** 순차 시작점  
**의존성:** 없음  
**병렬 가능:** `T00b`, `T00c`

### 목표
실제 로컬 환경에서 `claude` CLI 사용 가능 여부와 버전을 고정한다.

### 파일
- 문서화: `extensions/subagent/CLAUDE_RUNTIME_PLAN.md`
- 필요 시 메모/fixture: `extensions/subagent/fixtures/` (신규)

### 작업
- `claude --version` 확인
- `claude auth status` 또는 동등 경로로 usable auth 상태 확인
- `claude -p`가 현재 환경에서 실행 가능한지 sanity check 수행

### 검증 명령
```bash
claude --version
claude auth status --text
claude -p "say ok" --output-format text
```

### 기대 결과
- CLI 버전이 기록됨
- auth usable 여부가 기록됨
- simplest print-mode 호출 성공

### 피드백 루프
- `claude` 자체가 없거나 auth가 unusable이면 **즉시 구현 중단**, plan/tasks에 blocker 반영
- print-mode가 실행 안 되면 `T00b~T11` 전부 보류

### 완료 기준
- plan 문서에 실제 CLI 버전과 환경 제약이 반영됨

---

## T00b — stream-json fixture 수집

**성격:** 관측 태스크  
**의존성:** `T00a`  
**병렬 가능:** `T00c`

### 목표
`claude -p --output-format stream-json`의 **실제 event schema**를 fixture로 확보한다.

### 파일
- 신규: `extensions/subagent/fixtures/claude-stream/`
  - `basic-text.ndjson`
  - `tool-call.ndjson`
  - `long-running.ndjson`
  - `error.ndjson`

### 작업
최소 4가지 시나리오 fixture 확보:
1. 텍스트만 응답
2. 파일/쉘 또는 허용 도구 호출 포함
3. 상대적으로 긴 실행
4. 실패/abort/permission 관련 케이스

### 검증 명령 예시
```bash
claude --bare -p "say hello" --output-format stream-json --include-partial-messages > /tmp/basic.ndjson
claude --bare -p "list files in current dir" --output-format stream-json --include-partial-messages --tools "Read,Bash" --allowedTools "Read,Bash(ls *)" > /tmp/tool.ndjson
```

### 기대 결과
- 실제 event 이름, delta 구조, result 구조 확인
- parser가 의존할 필드가 문서화됨

### 피드백 루프
- ai-platform 참고 코드와 실제 schema가 다르면 **참고 코드를 버리고 fixture를 source of truth로 사용**
- schema가 모델/버전에 따라 다르면 호환 범위를 문서화하고 tolerant parser 요구 추가

### 완료 기준
- fixture 파일 저장 완료
- plan/tasks 문서에 parser 근거로 명시됨

---

## T00c — resume/approval/MCP/cwd 실험

**성격:** 관측 태스크  
**의존성:** `T00a`  
**병렬 가능:** `T00b`

### 목표
아래 운영 계약을 실측으로 고정한다.

1. `--resume`에서 사용하는 session handle 형식
2. session handle이 언제 처음 관측되는지
3. `--bare`가 실제로 무엇을 끄는지
4. `--tools` + `--allowedTools` 조합이 permission prompt를 완전히 막는지
5. `--mcp-config`로 허용 MCP source만 주입 가능한지
6. resume 시 `cwd`/workspace가 어떻게 동작하는지

### 파일
- 신규: `extensions/subagent/fixtures/claude-observations.md`

### 작업
- 동일 session continue/reload 시나리오 실험
- permission prompt 없이 Bash/Edit/Write가 끝나는지 확인
- `--bare`와 non-bare의 동작 차이 기록
- `--mcp-config` 명시 주입과 ambient discovery 차이 기록
- resume 시 stored cwd 필요성 검증

### 검증 명령 예시
```bash
claude --bare -p "read one file and summarize" --output-format stream-json --tools "Read" --allowedTools "Read"
claude --bare -p "write a temp file" --output-format stream-json --tools "Write" --allowedTools "Write"
```

### 기대 결과
- approval policy와 ambient config policy가 사실 기반으로 고정됨
- `claudeProjectDir` 재사용 필요 여부가 문서화됨

### 피드백 루프
- permission prompt가 남으면 approval 정책 재설계 후 `T04` 입력으로 반영
- `--bare`로 필요한 기능이 과도하게 꺼지면 허용 source를 재정의

### 완료 기준
- plan 문서에 approval / MCP / ambient discovery / cwd 정책 반영 완료

---

## T00d — 프로세스 lifecycle spec 작성

**성격:** 순차  
**의존성:** `T00b`, `T00c`

### 목표
`runClaudeAgent()`가 따라야 할 프로세스 종료/abort/fallback 계약을 문서화한다.

### 파일
- `extensions/subagent/CLAUDE_RUNTIME_PLAN.md`
- 필요 시 신규: `extensions/subagent/fixtures/claude-process-lifecycle.md`

### 작업
문서화 대상:
- 정상 종료 판별 조건
- final result 이벤트 기준
- event가 멈췄는데 프로세스가 살아 있는 경우 fallback 정책
- abort signal 처리 (`SIGTERM`/`SIGKILL` 여부)
- stderr / process error 수집 방식

### 검증 기준
- `runPiAgent()`가 이미 가지고 있는 회복 로직과 비교해 parity checklist 작성
- lifecycle 미결정 항목이 남아 있으면 `T05` 진행 금지

### 피드백 루프
- fixture로 재현되지 않은 종료 케이스가 있으면 추가 fixture 확보 후 문서 보강

### 완료 기준
- `T05` 구현자가 그대로 옮길 수 있는 lifecycle spec이 문서에 존재

---

## T01 — Phase 0 결과를 계획 문서에 반영

**성격:** 순차  
**의존성:** `T00d`

### 목표
관측 결과를 바탕으로 `CLAUDE_RUNTIME_PLAN.md`를 실제 구현 가능한 spec으로 고정한다.

### 파일
- `extensions/subagent/CLAUDE_RUNTIME_PLAN.md`

### 작업
- 실측과 어긋나는 가정 제거
- parser/lifecycle/approval/MCP/cwd 정책 확정
- acceptance criteria 보강

### 검증 기준
- 문서에 “추측”이 아닌 “실측/확정/가정” 구분이 있어야 함
- 이후 구현 태스크가 문서만 보고 진행 가능해야 함

### 피드백 루프
- 문서만으로 구현자가 의사결정 못 하면 `T01` 재작업

### 완료 기준
- 이후 모든 구현 태스크의 기준 spec 완성

---

## T02 — runtime/type/prompt 정책 추가

**성격:** 순차 기반 태스크  
**의존성:** `T01`

### 파일
- `extensions/subagent/agents.ts`
- `extensions/subagent/types.ts`
- 필요 시 관련 테스트 파일

### 작업
- frontmatter `runtime` 읽기
- `AgentConfig`, `CommandRunState`, `SingleResult`에 runtime/Claude metadata 필드 추가
- 공통 prompt 주입을 runtime-aware 하게 분기
  - `runtime: pi` → 기존 `ask_master` guideline 유지
  - `runtime: claude` → `ask_master` 제거 또는 plain-text blocker 보고 가이드로 대체

### 검증 명령
```bash
cd extensions && pnpm exec vitest run --config utils/vitest.config.ts <new-runtime-config-test>
cd extensions && pnpm run typecheck
```

### 기대 결과
- runtime field가 안정적으로 로드됨
- Claude runtime agent prompt에 unsupported tool 유도가 남지 않음

### 피드백 루프
- prompt snapshot에서 `ask_master` 문구가 남아 있으면 즉시 수정
- 타입 추가로 기존 call-site가 깨지면 이 태스크 내에서 해결 후 다음으로 진행

### 완료 기준
- typecheck 통과
- runtime-aware prompt validation 테스트 통과

---

## T03 — runner 계약/분기/역방향 매핑 추가

**성격:** 병렬 가능  
**의존성:** `T02`  
**병렬 가능:** `T04`

### 파일
- `extensions/subagent/runner.ts`
- `extensions/utils/agent-utils.ts` 또는 신규 util

### 작업
- `runClaudeAgent()` skeleton 추가
- `runSingleAgent()`에서 runtime 분기
- `runClaudeAgent()`는 **기존 `runSingleAgent()`와 동일한 호출 계약**을 유지
  - 입력: `signal`, `onUpdate`, `makeDetails`, `sessionFile` 등
  - 출력: `SingleResult`
- `PI_TO_CLAUDE_TOOL_MAP` 또는 동등 역방향 매핑 정의
- non-Anthropic model guard 추가

### 검증 기준
- `launchRunInBackground()` / `finalizeRunState()` / `updateRunFromResult()`를 대규모 변경 없이 재사용 가능해야 함
- invalid model/tool 조합에서 명확한 에러

### 피드백 루프
- runner contract mismatch로 하위 integration이 복잡해지면 이 태스크로 되돌아와 시그니처 재설계

### 완료 기준
- runtime dispatch 관련 단위 테스트 통과
- typecheck 통과

---

## T04 — approval/MCP/ambient config 정책 코드화

**성격:** 병렬 가능  
**의존성:** `T02`  
**병렬 가능:** `T03`

### 파일
- `extensions/subagent/runner.ts`
- 필요 시 `extensions/subagent/session.ts`
- 필요 시 util/helper 파일

### 작업
- `runtime: claude`에서 `--bare` 기본 적용
- mapped tool set으로 `--tools`와 `--allowedTools`를 모두 생성
- 허용된 MCP config source만 탐색 후 `--mcp-config`로 명시 주입
- ambient discovery drift 차단

### 검증 기준
- Bash/Edit/Write 사용하는 에이전트가 permission prompt 없이 완료 가능해야 함
- disallowed ambient source가 자동 로드되지 않아야 함

### 피드백 루프
- permission prompt가 남으면 mapping 또는 allowedTools 정책 수정
- ambient config가 새어 들어오면 source discovery/helper 정책 수정

### 완료 기준
- approval/MCP 정책 테스트 또는 재현 스크립트 통과

---

## T05 — Claude stream parser + lifecycle 구현

**성격:** 순차 핵심 태스크  
**의존성:** `T03`, `T04`, `T00d`

### 파일
- `extensions/subagent/runner.ts`
- 신규 test files
- fixture files 사용

### 작업
- `claude -p --output-format stream-json` parser 구현
- fixture 기반으로 text/thinking/tool/result/session handle 파싱
- lifecycle spec 반영
  - 정상 종료
  - abort
  - timeout/fallback
  - stderr/process error

### 검증 명령
```bash
cd extensions && pnpm exec vitest run --config utils/vitest.config.ts <claude-runner-parser-test>
cd extensions && pnpm run typecheck
```

### 기대 결과
- parser가 fixture를 안정적으로 읽고 `SingleResult`를 만든다
- lifecycle fallback이 문서 spec과 일치한다

### 피드백 루프
- fixture와 구현 mismatch 시 **문서 수정이 아니라 구현 수정 우선**
- fixture 자체가 불충분하면 `T00b`로 돌아가 추가 수집

### 완료 기준
- parser/lifecycle 테스트 통과

---

## T06 — session metadata 전파/복원

**성격:** 병렬 가능  
**의존성:** `T05`

### 파일
- `extensions/subagent/types.ts`
- `extensions/subagent/store.ts`
- `extensions/subagent/commands.ts`
- `extensions/subagent/tool-execute.ts`
- `extensions/subagent/runner.ts`

### 작업
- parser가 얻은 `claudeSessionId`, `claudeProjectDir` 등을 `SingleResult`에 실음
- `updateRunFromResult()` 경로를 통해 live state에 반영
- start/completion/custom status `details` payload에 metadata 직렬화
- restore path에서 metadata 복원
- continue는 저장된 `claudeProjectDir`로만 실행
- session handle이 mid-run에 처음 관측되면 durable checkpoint 저장

### 검증 기준
- reload 전후 동일 runId가 동일 Claude session을 resume
- metadata 없거나 mismatch면 hard-fail

### 피드백 루프
- continue가 새 Claude session을 열면 이 태스크로 즉시 rollback
- completion 전에 crash 시 handle 유실되면 checkpoint 전략 보강

### 완료 기준
- reload-then-continue acceptance 테스트 통과

---

## T07 — sidecar writer 구현

**성격:** 병렬 가능  
**의존성:** `T05`

### 파일
- `extensions/subagent/runner.ts`
- 필요 시 `extensions/subagent/session.ts`
- 신규 테스트 파일

### 작업
- Claude run 결과를 pi-compatible sidecar JSONL로 기록
- `run.sessionFile`은 그대로 sidecar file 사용
- **append discipline 명시 구현**
  - continue 시 same file append
  - live delta는 메모리 only
  - preview용 assistant message 반복 append 금지
  - finalized assistant/toolResult만 append
  - synthetic toolCall part는 completed assistant turn당 1회

### 검증 기준
- `readSessionReplayItems()` 수정 없이 동작
- `parseSessionDetailSummary()` 수정 없이 동작
- turn 수 / final output / tool call 집계가 왜곡되지 않음

### 피드백 루프
- replay/detail이 extra turn을 보이면 append discipline 수정
- parser 변경으로 schema가 흔들리면 `T05`와 함께 재조정

### 완료 기준
- parser compatibility 테스트 통과

---

## T08 — live preview / hang-detection parity

**성격:** 병렬 가능  
**의존성:** `T05`

### 파일
- `extensions/subagent/store.ts`
- `extensions/subagent/runner.ts`
- 필요 시 `extensions/subagent/index.ts`
- 테스트 파일

### 작업
- in-memory `liveActivityPreview` 업데이트 경로 추가
- 긴 tool 실행 중 `lastActivityAt`가 갱신되도록 설계
- false auto-abort 방지
- widget에 `→ tool(args)` preview 유지

### 검증 기준
- long-running fixture에서 hang detector 오작동 없음
- in-progress tool preview가 widget에 노출

### 피드백 루프
- live preview 때문에 persisted JSONL semantics가 깨지면 **`T07`은 건드리지 말고 메모리 경로만 수정**
- hang detector false positive 발생 시 이 태스크로 회귀

### 완료 기준
- live preview / no false abort acceptance 통과

---

## T09 — commands/tool-execute 통합

**성격:** 순차 통합 태스크  
**의존성:** `T06`, `T07`, `T08`

### 파일
- `extensions/subagent/commands.ts`
- `extensions/subagent/tool-execute.ts`
- 필요 시 `extensions/subagent/store.ts`

### 작업
- 단일 run / continue / batch / chain 경로에서 runtime metadata 전달
- `runSingleAgent()` 분기와 세션/상태/세부정보 경로 연결
- `subagent runs`, `detail`, follow-up completion이 Claude runtime에서도 자연스럽게 동작하도록 조정

### 검증 기준
- command 경로와 tool 경로 모두 동일 정책 적용
- continue / completion / pending delivery가 Claude run에서도 정상

### 피드백 루프
- command/tool 경로 중 하나만 metadata를 잃으면 이 태스크에서 통합 재정렬

### 완료 기준
- 통합 테스트 통과

---

## T10 — 테스트/acceptance 통합

**성격:** rollout gate  
**의존성:** `T09`

### 파일
- 신규/수정 테스트 파일
- fixture files

### 필수 acceptance matrix

1. runtime frontmatter 파싱
2. runtime-aware prompt policy (`ask_master` 제거/대체)
3. runtime dispatch
4. non-Anthropic model guard
5. `--bare` + explicit approval policy
6. explicit MCP source policy
7. stream-json parser
8. process lifecycle fallback
9. session metadata propagation
10. reload → continue → same Claude session resume
11. same sidecar append across continue
12. replay compatibility
13. detail compatibility
14. live preview / hang detection parity
15. 기존 `runtime: pi` regression 없음

### 검증 명령
```bash
cd extensions && pnpm run typecheck
cd extensions && pnpm run test
cd extensions && pnpm run test:coverage
```

### 피드백 루프
- 실패한 acceptance는 가장 가까운 의존 태스크로 즉시 되돌아감
- rollout 전에 flaky test가 하나라도 있으면 안정화 우선

### 완료 기준
- acceptance matrix 전부 통과

---

## T11 — feature flag + 초기 opt-in rollout

**성격:** 최종 노출 태스크  
**의존성:** `T10`

### 파일
- `agents/finder.md`
- `agents/planner.md`
- `agents/verifier.md`
- 필요 시 feature flag/config 파일

### 작업
- `runtime: claude`를 feature flag 뒤에 연결
- 초기 대상 3개 agent에만 opt-in 적용
- rollout note / known risk 기록

### 검증 기준
- feature flag off: 기존 동작 동일
- feature flag on: 지정 3개만 Claude runtime 사용
- 나머지 agent는 기존 `pi` 유지

### 피드백 루프
- rollout 후 regression 발견 시 feature flag로 즉시 차단 가능해야 함
- 한 agent라도 acceptance 외 현상 보이면 opt-in 대상 축소

### 완료 기준
- 안전한 rollback 경로 확보
- 초기 opt-in 3개 동작 확인

---

# 순차/병렬 실행 요약

## 반드시 순차
- `T00a → T00d → T01 → T02 → T05 → T09 → T10 → T11`

## 병렬 가능
- `T00b || T00c`
- `T03 || T04`
- `T06 || T07 || T08`

---

# 태스크 완료 정의

각 태스크는 아래 4가지를 모두 만족해야 완료로 본다.

1. 코드/문서 산출물 존재
2. 태스크별 acceptance check 통과
3. 피드백 루프에서 열린 이슈 없음
4. 다음 의존 태스크가 추가 가정 없이 시작 가능

---

# 최종 권고

이 작업은 **구현보다 관측과 계약 고정이 먼저**다.
특히 `Phase 0` 결과가 부실하면 뒤 태스크가 모두 흔들린다.

따라서 실제 실행 순서는 다음을 권장한다.

1. `T00a~T00d`를 빠르게 끝내서 사실을 고정
2. `T02~T05`로 런타임 계약을 완성
3. `T06~T09`로 세션/UX 호환을 닫음
4. `T10` acceptance가 끝나기 전에는 절대 opt-in 활성화 금지
5. `T11`은 feature flag 뒤에서만 진행
