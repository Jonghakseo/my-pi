# Subagent 개선 계획 (Phase 1 / 2 / 3)

> 기준 코드: `extensions/subagent/`
>
> 해결 대상:
> 1. 병렬 실행 사용성이 낮음
> 2. 체이닝 불가
> 3. 메인 에이전트가 서브에이전트 상태를 반복 polling함

---

## 0. 배경 및 현재 진단

### 현재 구조 요약
- 실제 서브에이전트 실행은 `runner.ts`의 `runSingleAgent()`가 별도 `pi` 프로세스를 `spawn()`해서 수행한다.
- 실행 상태는 `store.ts`의 `commandRuns`, `globalLiveRuns`에서 관리한다.
- `tool-execute.ts`가 `subagent` tool의 메인 실행 경로다.
- `cli.ts`는 현재 `command: string` 기반의 CLI 파서를 제공한다.
- `commands.ts`는 slash command 계열(`/sub:*`) 실행 경로를 담당한다.

### 현재 문제의 근본 원인

#### A. 병렬 실행
실행 인프라 자체는 병렬을 허용한다.
- `MAX_CONCURRENT_ASYNC_SUBAGENT_RUNS = 30`
- `invocation-queue.ts`는 시작만 페이싱하고, 시작된 작업은 독립적으로 병렬 실행된다.

문제는 **CLI 인터페이스가 단일 run 중심**이라는 점이다.
- 현재 tool 인터페이스는 사실상 한 번에 하나의 `run` / `continue`만 자연스럽게 다룬다.
- 여러 작업을 동시에 시작하는 명시적 CLI 문법이 없다.
- 완료 시점의 `triggerTurn` 정책이 batch 개념 없이 run 단위로 동작해, 병렬 작업을 한 묶음으로 처리하기 어렵다.

#### B. 체이닝
체이닝은 현재 코드에서 의도적으로 제거되어 있다.
- `tool-execute.ts`에서 `chain mode is no longer supported`를 반환한다.
- 즉, A의 출력이 B의 입력이 되는 파이프라인을 시스템이 직접 표현하지 못한다.

#### C. Polling
가장 큰 문제는 **polling 금지가 텍스트 힌트 수준**이라는 점이다.
- `types.ts` description에 polling 금지 안내가 있다.
- `constants.ts`에 `DO NOT POLL` 문구가 있다.
- 하지만 `status` / `detail` 호출을 코드 레벨에서 막지 않는다.

결과적으로 메인 에이전트는:
1. `subagent run ...` 호출
2. 즉시 `subagent status ...` 또는 `detail ...` 호출
3. follow-up을 기다리지 않고 반복 확인

패턴으로 빠지기 쉽다.

---

## 1. 설계 원칙

### 1.1 우선순위
1. **Polling 제거** — 가장 먼저 해결해야 한다.
2. **병렬 실행 모델 도입** — 독립 작업 여러 개를 동시에 시작할 수 있어야 한다.
3. **체이닝 복원** — 순차 의존 작업을 표현할 수 있어야 한다.

### 1.2 인터페이스 원칙
기존 `command: string` 기반 인터페이스를 유지한다.
- 단일 실행(`run`, `continue`, `status`, `detail`, `abort`, `remove`)은 기존 CLI 스타일 유지
- 새 기능인 **batch / chain도 동일한 CLI 스타일로 확장**
- 단, `|`, `>>` 같은 delimiter DSL은 도입하지 않는다.

핵심 방향:
- 외부 인터페이스는 계속 `{ command: "subagent ..." }`
- 내부 구현에서는 CLI 파싱 결과를 **구조화된 내부 IR(run list / step list)** 로 변환해 실행한다.

즉, 사용자/LLM은 CLI를 쓰되, 실행부는 안전한 구조화 데이터로 동작하게 만든다.

### 1.3 왜 delimiter DSL 대신 반복 플래그인가
`batch` / `chain`을 CLI로 유지하면서도 오해를 줄이려면, `|`, `>>`, `:` 같은 delimiter 기반 DSL보다 **반복 플래그 방식**이 안전하다.

문제 예시:
- `foo | bar`
- 쉘 파이프
- 마크다운/코드 블록
- 비교/설명 문장

따라서 아래처럼 명시적으로 반복되는 block 문법을 사용한다.

#### Batch 문법
```bash
subagent batch [--main|--isolated] \
  --agent <agent> --task <task> \
  --agent <agent> --task <task> \
  ...
```

#### Chain 문법
```bash
subagent chain [--main|--isolated] \
  --agent <agent> --task <task> \
  --agent <agent> --task <task> \
  ...
```

이 방식이면:
- CLI 스타일 유지 가능
- `subagent help`로 설명하기 좋음
- tokenizer / parser가 결정적으로 동작함
- 내부적으로는 `runs[]`, `steps[]`로 안전하게 정규화 가능

### 1.4 파싱 규칙
batch / chain의 파싱 규칙은 엄격하게 둔다.
- 최소 2개 block 필요
- 각 block은 반드시 `--agent <value> --task <value>` 순서여야 함
- 자유 텍스트 허용 안 함
- 알 수 없는 옵션 즉시 에러
- block 중간에 `--task` 누락 / `--agent` 누락 시 즉시 에러
- 필요 시 task는 quoted string 사용을 적극 권장

예:
```bash
subagent batch --main \
  --agent worker --task "A 기능 구현" \
  --agent reviewer --task "B 코드 리뷰"
```

---

## 2. 목표 상태

### 2.1 최종 사용자/에이전트 경험

#### 단일 실행
```ts
{ command: "subagent run worker -- 로그인 버그 수정" }
```

#### 병렬 batch
```ts
{
  command:
    'subagent batch --main ' +
    '--agent worker --task "A 기능 구현" ' +
    '--agent reviewer --task "B 코드 리뷰" ' +
    '--agent verifier --task "C 테스트 실행"'
}
```

#### 순차 chain
```ts
{
  command:
    'subagent chain --main ' +
    '--agent worker --task "로그인 API 구현" ' +
    '--agent reviewer --task "위 결과 리뷰" ' +
    '--agent worker --task "리뷰 결과 반영"'
}
```

### 2.2 기대 동작
- 단일 run 시작 후 메인 에이전트는 polling하지 않고 자동 follow-up을 기다린다.
- batch는 여러 run을 동시에 시작하고, **그룹 완료 시 한 번에** 결과를 받는다.
- chain은 앞 step의 출력이 뒤 step의 입력으로 안전하게 전달된다.

---

## 3. Phase 1 — Anti-polling 하드 가드

### 목표
메인 에이전트가 `status` / `detail`을 반복 호출하는 문제를 **코드 레벨에서 차단**한다.

### 핵심 전략
1. 최근 시작된 run에 대한 `status` / `detail` 호출을 제한한다.
2. launch 응답 문구를 더 강하게 만들어, “지금은 기다려야 하는 상태”를 명시한다.
3. follow-up 기반 비동기 모델을 명시적으로 강화한다.

### 변경 범위

#### A. `store.ts`
추가 상태:
- `recentLaunchTimestamps: Map<number, number>`
- 필요 시 `lastPollingWarningAt: Map<number, number>` 같은 보조 상태도 고려 가능

역할:
- run이 시작/재개된 시각을 저장
- 일정 시간 이내의 polling 시도를 감지하는 기준으로 사용

#### B. `tool-execute.ts`
`status` / `detail` 처리 강화:
- run이 `running` 상태이고
- 최근 launch 후 polling 쿨다운 이내라면
- 실제 상태 출력 대신 다음과 같은 차단 응답 반환

예시 응답:
```text
Run #12 is still running.
Do not poll with status/detail.
Wait for the automatic follow-up result.
```

세부 정책:
- `status`: 최근 시작된 `running` run에 대해 차단 또는 최소 응답만 제공
- `detail`: `running` 상태에서는 현재도 제한되어 있지만, 메시지를 더 강하게 보강
- 필요 시 `isError: true`로 반환하여 LLM이 다음 polling을 멈추도록 유도

#### C. `commands.ts`
slash command 계열(`/sub:*`)에도 동일한 anti-polling 정책이 필요하면 같은 기준을 적용한다.
단, 1차 구현은 tool 경로(`tool-execute.ts`) 우선 적용으로 범위를 제한한다.

#### D. `types.ts`
`subagent` tool description 수정:
- 단순 권고가 아니라 **규칙 기반 문구**로 강화
- “run/continue/batch/chain 후 다음 행동은 status/detail이 아니라 기다림”을 명시

예시 방향:
- "After launch, stop making subagent calls and wait for automatic follow-up unless the user explicitly asks for manual inspection."

#### E. `constants.ts`
추가 후보 상수:
- `SUBAGENT_POLL_COOLDOWN_MS`
- `SUBAGENT_STRONG_WAIT_MESSAGE`

### 성공 기준
- `run` / `continue` 직후 `status` / `detail` 연속 호출 빈도가 현저히 줄어든다.
- 자동 follow-up으로 완료 결과를 받는 흐름이 주 경로가 된다.
- polling 관련 안내가 텍스트뿐 아니라 실행 정책에도 반영된다.

### 리스크
- 사용자가 명시적으로 상태 조회를 원할 때도 막히는 UX가 생길 수 있음
- 따라서 “최근 시작된 running run”에만 제한하고, 완료/오류 run 조회는 정상 허용해야 함

---

## 4. Phase 2 — 병렬 Batch 실행 지원

### 목표
서로 독립적인 여러 작업을 한 번에 시작하고, **개별 run이 아니라 그룹(batch) 단위로 관리**한다.

### 핵심 전략
1. `batch`를 **CLI 반복 플래그 문법**으로 도입한다.
2. batch 내부 run들은 병렬 실행한다.
3. 개별 완료 시점에는 메인 턴을 불필요하게 깨우지 않는다.
4. **마지막 run까지 끝났을 때만** 통합 follow-up을 보낸다.
5. 외부는 CLI를 유지하되, 내부에서는 `runs[]` 형태의 IR로 정규화한다.

### 제안 인터페이스
```bash
subagent batch --main \
  --agent worker --task "A 기능 구현" \
  --agent reviewer --task "B 코드 리뷰" \
  --agent verifier --task "C 테스트 실행"
```

### 변경 범위

#### A. `cli.ts`
새 subcommand 파싱 추가:
- `batch`
- 반복되는 `--agent <agent> --task <task>` block 수집
- 선택 옵션 `--main`, `--isolated` 지원

파싱 결과는 내부적으로 다음과 같은 형태로 정규화한다.
```ts
type ParsedBatchParams = {
  asyncAction: "batch";
  contextMode?: "main" | "isolated";
  runs: Array<{
    agent: string;
    task: string;
  }>;
};
```

에러 정책:
- run block이 2개 미만이면 에러
- `--agent` 뒤 값 없으면 에러
- `--task` 뒤 값 없으면 에러
- `--task` 없이 다음 `--agent`가 오면 에러
- 정의되지 않은 옵션이 있으면 에러

#### B. `types.ts`
도구 입력 schema는 계속 `command: string`을 유지한다.
대신 다음을 수정한다.
- `SubagentParams` description에 `batch` / `chain` 문법 추가
- help text에 반복 플래그 기반 예시 추가
- 필요하면 내부 전용 타입(`ParsedBatchParams`, `ParsedChainParams`)을 추가

즉, **Typebox 공개 schema는 유지**, 내부 parse result 타입만 확장한다.

#### C. `store.ts`
batch 상태 추적용 구조 추가:
- `batchGroups: Map<string, BatchGroupState>`

예상 상태:
```ts
type BatchGroupState = {
  batchId: string;
  runIds: number[];
  completedRunIds: Set<number>;
  failedRunIds: Set<number>;
  originSessionFile: string;
  createdAt: number;
  pendingResults: Map<number, string>;
};
```

#### D. `tool-execute.ts`
새 실행 경로 추가:
- `asyncAction === "batch"` 처리
- `cli.ts`에서 받은 `runs[]`를 순회해 기존 `runSingleAgent()`를 재사용
- 각 run은 기존처럼 `commandRuns`, `globalLiveRuns`에 등록
- 다만 completion 시점의 follow-up 정책을 batch-aware하게 변경

핵심 로직:
1. batchId 생성
2. runs 배열을 순회하며 runState 생성
3. 각 run 시작
4. 개별 완료 시:
   - batch 그룹 상태에 결과 누적
   - 아직 남은 run이 있으면 `triggerTurn: false`
5. 마지막 run 완료 시:
   - 통합 결과를 하나의 follow-up으로 전송
   - `triggerTurn: true`

#### E. `commands.ts`
필수는 아니지만, 향후 `/sub:batch` 같은 slash command로 확장할 수 있다.
초기 범위에서는 tool 경로 우선이 적절하다.

#### F. `constants.ts`
추가 후보:
- `BATCH_COMPLETION_TIMEOUT_MS`
- `MAX_BATCH_RUNS`

### 통합 완료 메시지 예시
```text
[subagent-batch#b_20260309_001] completed
Runs: #21 done, #22 done, #23 error

#21 worker
- A 기능 구현 완료 요약

#22 reviewer
- B 코드 리뷰 요약

#23 verifier
- 테스트 실패 원인 요약
```

### 성공 기준
- 독립 작업 여러 개를 한 번의 CLI-style tool 호출로 시작할 수 있다.
- 완료 신호는 run 단위가 아니라 batch 단위로 수집된다.
- 메인 에이전트가 첫 완료 결과를 받고 조급하게 후속 행동을 시작하는 문제가 줄어든다.
- `subagent help`에 batch 문법이 명확하게 노출된다.

### 리스크
- batch 중 일부만 실패했을 때 결과 표현 방식을 명확히 해야 함
- `triggerTurn` 타이밍이 group 단위로 바뀌므로, 기존 단일 run 흐름과 섞일 때 혼선이 없도록 분리 설계 필요
- quoted task 처리 규칙이 tokenizer와 정확히 맞아야 함

---

## 5. Phase 3 — Chain / Pipeline 실행 지원

### 목표
앞 단계의 결과를 다음 단계의 입력으로 전달하는 **순차 파이프라인**을 복원한다.

### 핵심 전략
1. chain은 batch와 다르게 **동시 실행이 아니라 순차 실행**이다.
2. 각 step의 최종 출력이 다음 step task에 참조 문맥으로 주입된다.
3. 중간 실패 시 chain을 중단하고, 지금까지의 결과와 실패 사유를 보고한다.
4. 외부는 CLI 반복 플래그 문법을 유지하고, 내부에서는 `steps[]` IR로 변환한다.

### 제안 인터페이스
```bash
subagent chain --main \
  --agent worker --task "로그인 API 구현" \
  --agent reviewer --task "위 결과 리뷰" \
  --agent worker --task "리뷰 결과 반영"
```

### 변경 범위

#### A. `cli.ts`
새 subcommand 파싱 추가:
- `chain`
- 반복되는 `--agent <agent> --task <task>` block 수집
- 선택 옵션 `--main`, `--isolated` 지원

파싱 결과 예시:
```ts
type ParsedChainParams = {
  asyncAction: "chain";
  contextMode?: "main" | "isolated";
  steps: Array<{
    agent: string;
    task: string;
  }>;
};
```

에러 정책:
- step block 2개 미만이면 에러
- 각 block은 반드시 `--agent`와 `--task`를 모두 가져야 함
- 자유 텍스트 허용 안 함

#### B. `types.ts`
- `SubagentParams` description에 `chain` 문법 추가
- help text에 반복 플래그 기반 `chain` 예시 추가
- 필요 시 내부 전용 타입(`ParsedChainParams`, `PipelineState`) 추가

#### C. `store.ts`
파이프라인 상태 추가:
- `pipelines: Map<string, PipelineState>`

예상 상태:
```ts
type PipelineState = {
  pipelineId: string;
  currentIndex: number;
  stepRunIds: number[];
  stepResults: Array<{
    runId: number;
    agent: string;
    task: string;
    output: string;
    status: "done" | "error";
  }>;
  originSessionFile: string;
  createdAt: number;
};
```

#### D. `session.ts`
새 helper 추가:
- `wrapTaskWithPipelineContext(task, previousStepOutput, metadata)`

의도:
- 이전 step 결과를 `[PIPELINE PREVIOUS STEP — REFERENCE]` 같은 명시적 블록으로 넣음
- 현재 요청이 authoritative instruction임을 유지
- 이전 결과를 참고하되 역할/권한 혼동을 막음

예시 구조:
```text
[PIPELINE PREVIOUS STEP — REFERENCE]
Agent: reviewer
Task: 위 결과 리뷰
Output:
...

[REQUEST — AUTHORITATIVE]
리뷰 결과를 반영해 수정하라.
```

#### E. `tool-execute.ts`
`asyncAction === "chain"` 처리 추가:
1. pipelineId 생성
2. step 0 실행
3. 완료 후 output 수집
4. output을 다음 step의 wrapped task에 주입
5. 마지막 step 완료 시 통합 결과를 `triggerTurn: true`로 전달

에러 정책:
- step 실패 시 즉시 chain 중단
- 실패 step까지의 중간 결과를 포함해 follow-up 전송

### 성공 기준
- 복수 step workflow를 한 번의 CLI-style tool 호출로 선언할 수 있다.
- step 간 output 전달 규칙이 명시적이고 추적 가능하다.
- chain 중간 실패 시 시스템이 조용히 멈추지 않고 확실하게 보고한다.
- `subagent help`에 chain 문법이 명확하게 노출된다.

### 리스크
- step 출력이 너무 길 경우 다음 step 컨텍스트가 과도해질 수 있음
- 따라서 요약/절단 정책이 필요함
- raw output 전체보다 `getFinalOutput()` 기반 핵심 결과를 우선 전달하는 편이 안정적임
- quoted task 처리와 tokenizer 동작이 정확히 일치해야 함

---

## 6. 권장 구현 순서

### Step 1 — Phase 1 먼저 구현
이유:
- 현재 가장 방해가 큰 문제는 polling이다.
- 이 문제를 해결하지 않으면 batch / chain을 추가해도 메인 에이전트가 또 polling 루프로 빠질 가능성이 높다.

### Step 2 — Phase 2로 병렬 모델 도입
이유:
- batch는 독립 작업을 묶는 구조라 chain보다 단순하다.
- group-level completion 집계, follow-up 정책, 상태 관리 패턴을 먼저 검증할 수 있다.
- 반복 플래그 기반 CLI parser를 먼저 정착시키기 좋다.

### Step 3 — Phase 3로 chain 복원
이유:
- chain은 batch보다 상태 전이와 문맥 전달이 복잡하다.
- batch에서 확립한 group-state 및 completion 수집 패턴, CLI block parser 패턴을 재사용할 수 있다.

---

## 7. 검증 계획

### Phase 1 검증
- `run` 직후 `status` 호출 시 차단 메시지 반환 확인
- `running` 상태가 아닌 run의 `status/detail`은 정상 동작 확인
- 완료 follow-up은 여전히 정상 수신되는지 확인

### Phase 2 검증
- 3개 run batch 시작 시 모두 병렬로 시작되는지 확인
- 첫 번째 완료 시 turn이 열리지 않고, 마지막 완료 시에만 열리는지 확인
- 일부 실패 batch에서도 통합 결과가 잘 모이는지 확인
- `subagent help`에 batch 예시가 정확히 보이는지 확인
- `--agent/--task` block 파싱 에러가 기대대로 동작하는지 확인

### Phase 3 검증
- step 1 output이 step 2 입력에 들어가는지 확인
- 중간 step 실패 시 이후 step이 실행되지 않는지 확인
- 최종 follow-up에 step별 결과가 모두 들어가는지 확인
- `subagent help`에 chain 예시가 정확히 보이는지 확인

---

## 8. 예상 파일 영향도

### Phase 1
- `extensions/subagent/store.ts`
- `extensions/subagent/tool-execute.ts`
- `extensions/subagent/types.ts`
- `extensions/subagent/constants.ts`
- (선택) `extensions/subagent/commands.ts`

### Phase 2
- `extensions/subagent/cli.ts`
- `extensions/subagent/tool-execute.ts`
- `extensions/subagent/store.ts`
- `extensions/subagent/types.ts`
- `extensions/subagent/constants.ts`
- (선택) `extensions/subagent/tool-render.ts`

### Phase 3
- `extensions/subagent/cli.ts`
- `extensions/subagent/tool-execute.ts`
- `extensions/subagent/store.ts`
- `extensions/subagent/types.ts`
- `extensions/subagent/session.ts`
- `extensions/subagent/constants.ts`
- (선택) `extensions/subagent/tool-render.ts`

---

## 9. 요약

- **Phase 1**: polling을 텍스트 안내가 아니라 실행 정책으로 막는다.
- **Phase 2**: 독립 작업 여러 개를 CLI 반복 플래그 기반 `batch`로 병렬 실행하고, 그룹 완료 시 한 번에 결과를 전달한다.
- **Phase 3**: 순차 의존 작업을 CLI 반복 플래그 기반 `chain`으로 표현하고, step 간 결과를 안전하게 전달한다.

핵심 방향은 다음과 같다.
- 기존 `command: string` 기반 인터페이스는 유지
- 새 기능(batch / chain)도 **CLI 스타일로 추가**
- delimiter DSL 대신 `--agent <agent> --task <task>` 반복 block 사용
- 내부 구현은 parse result를 구조화된 IR로 정규화
- follow-up / `triggerTurn` 정책을 **run 단위에서 group/pipeline 단위로 승격**
- polling 금지는 문구가 아니라 **실행 가드**로 강제
