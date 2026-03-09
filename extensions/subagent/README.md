# Subagent

`extensions/subagent/`는 Pi의 **위임 실행 레이어**입니다.

메인 에이전트가 직접 모든 일을 처리하지 않고,
필요할 때 별도 에이전트를 실행해서 일을 나눠 맡기기 위한 모듈입니다.

---

## 한 줄 요약

> 메인 에이전트는 지휘하고, subagent는 별도 `pi` 프로세스로 실행되어 결과를 나중에 다시 보고한다.

---

## 구현 철학

### 1. 같은 뇌가 아니라, 따로 실행한다

subagent는 메인 에이전트 내부 함수 호출이 아닙니다.
각 subagent는 **별도 `pi` 프로세스**로 실행됩니다.

왜 이렇게 했나?
- 컨텍스트를 분리하기 위해
- 역할별 에이전트를 독립적으로 쓰기 위해
- 긴 작업을 비동기로 돌리기 위해
- 메인 에이전트의 사고 흐름을 덜 오염시키기 위해

```text
Main Agent
    |
    v
Subagent Extension
    |
    v
separate `pi` process
```

---

### 2. 바깥은 CLI처럼, 안쪽은 구조화된 상태로

겉으로는 이렇게 씁니다.

```text
subagent run worker -- <task>
subagent batch --main --agent worker --task "A" --agent reviewer --task "B"
subagent chain --main --agent worker --task "구현" --agent reviewer --task "리뷰"
```

하지만 내부에서는 문자열을 그대로 실행하지 않고,
파싱해서 **single / batch / chain** 구조로 바꾼 뒤 실행합니다.

즉:

```text
문자열 인터페이스  ->  파싱  ->  구조화된 실행 상태
```

이 철학 덕분에:
- 사용법은 단순하고
- 실행은 더 예측 가능해집니다.

---

### 3. polling보다 follow-up이 우선이다

subagent는 기본적으로 **비동기 작업**입니다.

좋은 흐름:

```text
launch
  -> 기다림
  -> 자동 follow-up 수신
```

나쁜 흐름:

```text
launch
  -> status
  -> status
  -> detail
  -> status
```

그래서 이 모듈은:
- `status/detail` polling을 강하게 억제하고
- launch 후 자동 follow-up을 기다리는 흐름을 기본 경로로 둡니다.

---

### 4. 참고 문맥과 실제 지시를 구분한다

subagent에 메인 세션 문맥이나 이전 단계 결과를 넘길 때,
가장 중요한 원칙은 이것입니다.

- **참고 자료는 참고 자료다**
- **실제 지시는 현재 요청이다**

그래서 프롬프트 안에 이런 경계를 둡니다.

```text
[HISTORY — REFERENCE ONLY]
[PIPELINE PREVIOUS STEP — REFERENCE ONLY]
[REQUEST — AUTHORITATIVE]
```

이걸 지키는 이유는,
이전 단계의 출력이나 과거 대화가 다음 에이전트에게
"지금 당장 따라야 하는 명령"처럼 오해되지 않게 하기 위해서입니다.

---

## 실행 모델

### Single
하나의 subagent에 하나의 작업을 맡깁니다.

```text
main
  -> run
  -> subagent 1개 실행
  -> 완료/실패 follow-up
```

### Batch
서로 독립적인 여러 작업을 **병렬**로 실행합니다.

```text
          +-> run A
main -> batch
          +-> run B
          +-> run C

모두 끝나면
  -> batch summary 1회
```

핵심:
- 내부적으로는 여러 run이 있지만
- 사용자에게는 **그룹 단위 결과**가 더 중요합니다.

### Chain
순차 의존 작업을 **단계별**로 실행합니다.

```text
step 1 -> output
            |
            v
step 2 -> sees step 1 output as reference
            |
            v
step 3
```

핵심:
- 다음 단계는 이전 단계 결과를 **참고 문맥**으로 받음
- 이전 단계 결과가 곧바로 다음 단계의 명령이 되지는 않음

---

## 알림 철학

batch/chain은 **그룹 중심 알림**을 사용합니다.

핵심은 사용자에게 중요한 신호만 보여주는 것입니다.

```text
launch
...
group summary
```

즉:
- single은 개별 run 중심
- batch/chain은 그룹 중심

---

## 복구 철학

복구도 범위를 명확히 제한합니다.

### 복구하려는 것
- 세션 전환 후 run 상태 표시
- origin session으로 돌아왔을 때 deferred follow-up 전달
- batch/chain의 **완료된 summary** 재전달

### 복구하지 않는 것
- reload/restart 후 **진행 중이던 chain 자동 재개**
- 반쯤 실행되던 batch/chain orchestration 이어서 실행

즉 현재 철학은 이렇습니다.

```text
finished summary recovery   -> 한다
in-flight chain resume      -> 하지 않는다
```

이건 의도적인 결정입니다.
자동 재개까지 가면 중복 실행, 상태 불일치, 잘못된 후속 단계 실행 위험이 커지기 때문입니다.

---

## 디렉토리 보는 법

세부 구현이 궁금하면 아래 순서로 보면 됩니다.

### 먼저 읽을 파일
- `cli.ts`
  - 어떤 명령을 어떻게 파싱하는지
- `tool-execute.ts`
  - single / batch / chain 실행이 실제로 어떻게 돌아가는지
- `session.ts`
  - main context, previous-step reference를 어떤 형태로 감싸는지
- `commands.ts`
  - 세션 전환, 복구, pending delivery가 어떻게 연결되는지

### 상태/복구가 궁금하면
- `store.ts`
  - 메모리상의 live state
- `group-pending.ts`
  - 완료된 batch/chain summary의 durable pending storage
- `types.ts`
  - 전체 상태 구조

### 실제 프로세스 실행이 궁금하면
- `runner.ts`
  - child `pi` process spawn
- `agents.ts`
  - agent discovery
- `invocation-queue.ts`
  - 시작 타이밍 제어

---

## 아주 짧은 구조도

```text
                +------------------+
                | Main Agent       |
                | decide / delegate|
                +--------+---------+
                         |
                         v
                +------------------+
                | Subagent Layer   |
                | parse / launch   |
                | track / recover  |
                +--------+---------+
                         |
          +--------------+---------------+
          |                              |
          v                              v
   +-------------+                +-------------+
   | Single Run  |                | Batch/Chain |
   +-------------+                +-------------+
          |                              |
          v                              v
    child `pi`                    child `pi` process(es)
          |                              |
          v                              v
   final follow-up                grouped summary
```

---

## 이 README의 의도

이 문서는 **세부 구현 설명서**가 아니라,
"이 모듈을 어떤 생각으로 만들었는가"를 빠르게 이해하기 위한 안내서입니다.

구현 세부를 보려면:
- 실행 흐름: `tool-execute.ts`
- 문맥 구성: `session.ts`
- 복구/세션 처리: `commands.ts`, `group-pending.ts`
- 상태 구조: `store.ts`, `types.ts`
