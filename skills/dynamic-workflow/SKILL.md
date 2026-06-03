---
name: dynamic-workflow
description: 사용자가 “워크플로우로 해줘”, “ultracode처럼”, “서브에이전트로 작업을 분해/실행/검증”, “현재 작업을 에이전트들에게 나눠서 처리”, “동적 workflow 설계”처럼 요청하거나, 장기·병렬·대규모·검증 중심 작업에서 단일 컨텍스트 진행의 agentic laziness/self-preferential bias/goal drift 위험이 클 때 사용한다. Pi의 subagent 시스템과 기존 design-first/pipeline-execute/stress-interview/self-healing 스킬을 조합해 작업별 맞춤 워크플로우를 설계하고 실행/검증한다.
disable-model-invocation: false
---

# dynamic-workflow

현재 요청에 맞는 **작업 분해 → 서브에이전트 실행 → 독립 검증 → 종합/반복** 워크플로우를 동적으로 설계하고 수행한다.

Claude Code의 dynamic workflows처럼 JS 런타임이 오케스트레이션을 들고 있지는 않으므로, Pi에서는 **메인 에이전트가 오케스트레이터**가 되고 `subagent` 실행, `todo_write`, 기존 스킬을 조합해 같은 품질 패턴을 재현한다.

## 핵심 목표

- 긴 작업을 한 컨텍스트에서 끝까지 밀어붙이다 생기는 **agentic laziness**를 막는다.
- 결과물을 만든 에이전트와 검증하는 에이전트를 분리해 **self-preferential bias**를 줄인다.
- 원래 목표, 금지사항, 성공 기준을 워크플로우 명세로 고정해 **goal drift**를 줄인다.
- 병렬화가 유리한 작업은 fan-out하고, 충돌 위험이 있는 구현은 순차 gate를 둔다.

## 언제 사용하나

사용자가 명시적으로 워크플로우/서브에이전트 분해를 요청하면 사용한다.

명시 요청이 없어도 아래 중 2개 이상이면 사용을 검토한다.

- 3개 이상의 독립 조사/수정/검증 단위가 있다.
- 구현자와 검증자를 분리해야 신뢰도가 오른다.
- 여러 관점의 판단이 필요하다: 보안, UX, 데이터, 아키텍처, 성능 등.
- 실패 조건이 불명확해서 `loop until done`이 필요하다.
- 많은 파일, 많은 항목, 긴 로그, 과거 세션/이슈/슬랙/문서 등 대량 컨텍스트가 있다.
- 단일 컨텍스트로 진행하면 중간 결과가 오염되거나 잊힐 가능성이 크다.

사용하지 않는 경우:

- 단순 1파일 수정, 짧은 질의응답, 즉시 검증 가능한 작은 작업.
- 사용자가 빠른 직접 처리를 원하고 추가 비용/시간을 원하지 않는 경우.
- 병렬 worker가 같은 파일을 동시에 고칠 가능성이 높고 격리 수단이 없는 경우.

## Workflow

### 1. Scope lock

먼저 다음을 5~10줄로 고정한다. 모호하면 `ask_user_question`으로 한 번에 묻는다.

```markdown
## Workflow Scope
- Objective:
- Non-goals / do-not-do:
- Source of truth:
- Success criteria:
- Constraints: 시간/토큰/권한/커밋/배포/외부 전송
- Stop condition:
```

복잡한 구현/아키텍처 변경이면 `design-first`를 먼저 사용한다. 이미 구조화된 계획이 있으면 `pipeline-execute`로 이어갈 수 있다.

### 2. Pattern 선택

작업 성격에 따라 아래 패턴을 하나 이상 조합한다.

| Pattern | 언제 쓰나 | Pi 실행 방식 |
|---|---|---|
| classify-and-act | 작업 종류/위험도/모델 선택이 먼저 필요 | `planner` 또는 `challenger`에게 분류 요청 |
| fan-out-and-synthesize | 많은 파일/항목/문서/소스를 독립 처리 | `subagent batch --isolated` 또는 `--main` 후 메인에서 종합 |
| worker→verifier→reviewer | 구현 태스크 품질 게이트 | `pipeline-execute` 또는 `subagent chain` |
| adversarial verification | 사실/코드/설계 검증 신뢰도 향상 | `verifier` + `reviewer` + `challenger` 병렬, `stress-interview` |
| generate-and-filter | 아이디어/해결책 다수 생성 후 선별 | 여러 `planner`/`worker` → `reviewer` 필터 |
| tournament | 설계/이름/접근법 비교 판단 | N개 후보 생성 → pairwise judge/reviewer |
| loop until done | 원인 불명 버그, flaky test, 반복 triage | stop condition + max cycles를 정하고 반복 |
| quarantine triage | Slack/리뷰/공개 입력 등 untrusted content 처리 | 읽기 전용 agent와 실행 agent를 분리 |

### 3. Workflow spec 작성

서브에이전트를 띄우기 전에 실행 계획을 명확히 작성하고 `todo_write`에 반영한다.

```markdown
## Adaptive Workflow Plan
- Pattern(s):
- Work units:
  1. [unit] owner agent / mode(main|isolated) / expected output / validation
- Parallel groups:
- Sequential gates:
- Conflict risks:
- Verification gates:
- Max cycles / budget:
- Human approval gates:
```

규칙:

- 한 번에 정확히 하나의 `todo_write` 항목만 `in_progress`로 둔다.
- 독립 fan-out 결과는 반드시 synthesis barrier에서 합친다.
- 구현 결과는 구현자가 아닌 `verifier`/`reviewer`가 검증한다.
- 같은 파일을 고치는 worker를 병렬 실행하지 않는다.
- 긴 프롬프트/컨텍스트는 임시 markdown 파일로 쓰고 subagent에게 경로를 전달한다.

### 4. Subagent 실행 지침

먼저 현재 세션에서 `subagent help`를 확인하지 않았거나 인터페이스가 불명확하면 확인한다.

- 독립 작업: `subagent batch [--main|--isolated] --agent <agent> --task "..." ...`
- 의존 작업: `subagent chain [--main|--isolated] --agent <agent> --task "..." --agent <agent> --task "..."`
- 단일 위임: `subagent run <agent> [--main|--isolated] -- <task>`

모드 선택:

- `--main`: 같은 repo의 최신 변경/컨텍스트를 공유해야 하는 구현·검증.
- `--isolated`: 독립 조사, 아이디어 생성, 반론, 오염 방지 검증.

주의:

- 실행 직후 바로 `status/detail`로 폴링하지 않는다. 자동 완료/실패 follow-up을 기다린다.
- `continue`는 최신 메인 컨텍스트를 자동 동기화하지 않으므로, 이어서 필요한 변경사항/결론을 프롬프트에 명시한다.
- 외부 전송, 삭제, 배포, 대량 변경, 비용 큰 작업은 사용자 승인 gate를 둔다.

### 5. Role routing

현재 사용 가능한 에이전트를 확인해야 하면 `list-agents`를 호출한다.

- `planner`: 목표 분해, 설계, 실행 가능한 계획 작성.
- `finder`/`searcher`: 파일 탐색, 코드베이스/문서/웹 리서치.
- `worker`: 구현, 다중 파일 수정.
- `verifier`: 테스트/타입체크/빌드/재현 증거.
- `reviewer`: correctness, regression, maintainability 리뷰.
- `challenger`: 숨은 가정, 실패 시나리오, 반론.
- `security-auditor`: auth, secret, injection, data boundary 등 보안 이슈.
- `browser`: UI/브라우저 검증.
- `code-cleaner`/`simplifier`: 재사용성, 품질, 단순화.

### 6. Verification gate

각 work unit은 아래 중 적어도 하나의 검증 증거가 있어야 완료 처리한다.

- 실행 증거: 테스트, lint, typecheck, build, curl, browser flow.
- 명세 적합성: 요구사항 대비 누락/초과 없음.
- 독립 리뷰: reviewer/challenger/security-auditor 중 적절한 역할의 검토.
- 데이터/문서 작업: source citation, claim check, 샘플 재검산.

P0/P1 또는 blocker가 있으면 다음 단계로 넘어가지 않는다. 판단이 필요한 이슈는 사용자에게 에스컬레이션한다.

### 7. Loop policy

반복형 워크플로우는 시작 전에 종료 조건을 둔다.

```markdown
Loop stop when:
- no new findings, or
- all tests pass twice, or
- reviewer reports no P0/P1, or
- max N cycles reached, or
- budget exhausted
```

무한 루프 금지. 기본 최대 2~3 cycles. 더 필요하면 사용자에게 중간 결과를 보고하고 승인받는다.

### 8. Synthesis and final report

최종 응답은 짧게 다음을 포함한다.

```markdown
## Workflow Result
- Pattern used:
- Agents used:
- Completed work units:
- Validation evidence:
- Remaining risks:
- Next step:
```

코드 변경이 있었다면 파일 경로와 검증 명령을 명시한다. 실행하지 못한 검증은 이유와 사용자가 실행할 명령을 적는다.

## 기존 스킬과의 연결

- 큰 기능/아키텍처 전환: `design-first` → `adaptive-workflow` → `pipeline-execute` → `stress-interview`.
- 구조화된 구현 계획: 바로 `pipeline-execute`.
- 완성본 압박 검토: `stress-interview`.
- 결함 수집 후 짧은 자동 수정 루프: `self-healing`.
- 단순 작업: 이 스킬을 쓰지 말고 직접 처리.

## Safety

- untrusted public content를 읽은 agent에게 고권한 액션을 맡기지 않는다. 읽기/분류 agent와 실행 agent를 분리한다.
- secret, token, 개인정보를 subagent 프롬프트에 불필요하게 넣지 않는다.
- destructive action, push, deploy, 외부 메시지 전송은 사용자 명시 승인 없이는 수행하지 않는다.
- token/time budget을 명시할 수 있으면 명시한다. 작은 slice로 먼저 검증하는 것을 선호한다.

## Self-check prompts

스킬 동작을 점검할 때 사용할 수 있는 프롬프트:

1. “이 flaky test를 재현하고 원인 가설을 워크플로우로 검증해줘. 멈추는 조건도 정해.”
2. “최근 변경사항을 서브에이전트로 분해해서 구현 검증 리뷰까지 해줘.”
3. “이 설계안을 여러 관점에서 토너먼트/챌린지 방식으로 비교해줘.”
4. “문서의 기술적 claim을 코드베이스와 공식 문서로 cross-check하는 워크플로우를 만들어줘.”

## References

- Pi Skills docs: `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/docs/skills.md`
- Agent Skills standard: https://agentskills.io/specification
- Claude Code dynamic workflows docs: https://code.claude.com/docs/en/workflows
- Claude Code subagents docs: https://code.claude.com/docs/en/sub-agents.md
