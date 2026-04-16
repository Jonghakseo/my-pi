# Subagent

`extensions/subagent/`는 Pi의 **위임 실행 레이어**입니다.
메인 에이전트가 직접 처리하지 않을 일을 별도 `pi` 프로세스로 넘기고, 완료되면 다시 결과를 받습니다.

---

## 한 줄 요약

> 메인 에이전트는 지휘하고, subagent는 따로 실행된 뒤 follow-up으로 결과를 돌려준다.

---

## 핵심 원칙

- **별도 프로세스 실행**: subagent는 내부 함수 호출이 아니라 독립 `pi` 프로세스다.
- **비동기 우선**: launch 후 polling보다 자동 follow-up을 기본 경로로 둔다.
- **문맥 경계 유지**: 이전 출력은 참고 자료로 넘기고, 현재 요청만 실제 지시로 취급한다.
- **복구 범위 제한**: 완료된 요약과 세션 연결은 복구하지만, 진행 중이던 chain/batch는 자동 재개하지 않는다.

---

## 운영 인터페이스

### 1) LLM / 도구 인터페이스

```text
subagent run worker -- <task>
subagent batch --main --agent worker --task "A" --agent reviewer --task "B"
subagent chain --main --agent worker --task "구현" --agent reviewer --task "리뷰"
```

### 2) 사용자 명령

- `/sub:isolate` — 격리된 sub-session으로 실행
- `/sub:main` — 메인 세션 문맥을 넘겨 실행
- `/subagents` — 사용 가능한 subagent 목록 보기
- `/sub:open` — run replay 열기
- `/sub:trans` — subagent 세션으로 이동
- `/sub:history` — 전체 run 기록 보기
- `/sub:rm` — run 항목 제거
- `/sub:clear` — 완료된 항목 정리
- `/sub:abort` — 실행 중 작업 중단
- `/sub:back` — 부모 세션으로 복귀

### 3) 빠른 입력

- `>>`, `>` — 실행 / hidden 실행 (`>>>`는 legacy alias)
- `#<runId> <task>` — 기존 run 이어서 실행
- `<>` — subagent 세션으로 이동
- `><` — 부모 세션으로 복귀
- `<<`, `<<<` — 중단 / 정리
- 심볼 alias(`>>?`, `>/` 등)도 지원

---

## 상태 UI

현재 활성 상태 UI는 **below-editor run status widget**입니다.

- 활성 위젯: `widget.ts`
- above-editor pixel widget: `above-widget.ts`에서 비활성화됨

즉 현재 동작 기준으로는 "픽셀 위젯"보다 **에디터 아래 run 상태 박스**가 맞는 설명입니다.

---

## 실행 모델

### Single
하나의 subagent에 하나의 작업을 맡긴다.

### Batch
독립적인 여러 작업을 병렬 실행하고, 마지막에 그룹 요약을 보낸다.

### Chain
순차 의존 작업을 단계별로 실행하고, 이전 단계 결과는 다음 단계에 참고 문맥으로 넘긴다.

---

## 복구 철학

### 복구하는 것
- 세션 전환 후 run 상태 표시
- origin session으로 돌아왔을 때 deferred follow-up 전달
- batch/chain 완료 요약 재전달

### 복구하지 않는 것
- reload/restart 후 진행 중 chain 자동 재개
- 반쯤 실행되던 batch/chain orchestration 이어서 실행

---

## 먼저 볼 파일

- `cli.ts` — 명령 파싱
- `tool-execute.ts` — single / batch / chain 실행 흐름
- `session.ts` — main context / reference wrapping
- `commands.ts` — slash command, shortcut, 세션 전환/복구
- `runner.ts` — child `pi` process 실행
- `store.ts` — live state
- `group-pending.ts` — 완료된 group summary durable storage
- `widget.ts` — 현재 활성 상태 위젯

---

## 구조도

```text
Main Agent
   |
   v
Subagent Layer
   |
   +-> Single run
   +-> Batch runs
   +-> Chain steps
   |
   v
child `pi` process(es)
   |
   v
follow-up / grouped summary
```
