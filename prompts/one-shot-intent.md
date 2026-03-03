---
description: Intent 모드 전용 문제 해결 템플릿. Blueprint 기반 오케스트레이션, 탐색 우선, 대안 분석, 검증, HTML 보고서 3종 산출물.
---
다음 절차와 원칙에 따라 문제를 해결한다.

템플릿 인자로 받은 주요 요구사항 (`/one-shot-intent ...`):
$@

위 요구사항을 작업 목표로 삼고 아래 워크플로를 실행한다.

---

## 1. 탐색 우선 (Research First)

실행 방향을 결정하기 전에 **충분한 사전 탐색**을 완료한다.

- 코드베이스 내부 탐색 → `intent({ mode: "run", purpose: "explore", ... })`
- 외부 문서/웹 정보 검색 → `intent({ mode: "run", purpose: "search", ... })`
- 탐색 없이 구현부터 시작하지 않는다.

---

## 2. 단일 작업 vs Blueprint 판단

요구사항을 받으면 **가장 먼저** 판단한다.

- **단계 1~2개**: `intent({ mode: "run", purpose: "...", difficulty: "...", task: "..." })` 즉시 실행
- **단계 3개 이상 + 의존성**: 아래 Blueprint 워크플로로 진행
- **판단 불가**: `AskUserQuestion`으로 "간단히 바로 할까요, 계획을 세울까요?" 확인

---

## 3. Blueprint 워크플로 (복잡한 작업)

### 3-1. 인터뷰 (최대 3회)
`AskUserQuestion`으로 Blueprint 설계에 직접 영향을 주는 내용만 확인한다.
- 범위: 어디까지 구현할지
- 제약: 건드리면 안 되는 파일/로직
- 우선순위: 무엇이 가장 중요한지

이미 충분한 정보가 있으면 생략하거나 줄일 수 있다.

### 3-2. Blueprint 설계
DAG로 작업을 분해한다.

```
탐색/계획 노드 → 구현 노드 → 검증 노드
```

- `dependsOn`: 실행 순서 제어
- `chainFrom`: 이전 노드 결과를 다음 노드에 자동 주입
- 독립적인 노드는 병렬 실행 (dependsOn 없이)
- challenge 게이트는 **자동 삽입** — plan/explore → implement 패턴이 있으면 Gate 1 (implement 앞), implement → review 패턴이 있으면 Gate 2 (review 앞) 자동 추가. 이미 challenge 노드가 2개 이상이면 스킵. 수동 추가 불필요 (단, 노드 3개 미만이거나 커스텀 challenge가 필요하면 직접 포함)
- verify 노드는 자동 삽입 없음 — 명시적으로 포함해야 함
- 노드 수 3~7개로 유지. 더 크면 순차 Blueprint로 분할

### 3-3. 실행
```
create_blueprint → 사용자 confirm → run_next (한 번) → 완료 대기
```

`run_next`는 한 번만 호출하면 executor가 자동으로 후속 노드를 처리한다.  
`[Intent Blueprint 완료]` 알림이 올 때까지 기다린다.

### 3-4. 실패 복구
- 노드 실패 시 → `intent({ mode: "retry_node", blueprintId, nodeId })` 로 개별 재실행
- 같은 실패가 반복되면 Blueprint를 수정해 새로 설계한다
- 2회 이상 동일 실패 → 사용자에게 에스컬레이션

---

## 4. 대안 탐색 (Alternatives)

단일 해법에 수렴하지 않는다. 설계 단계에서 옵션을 비교한다.

- `intent({ mode: "run", purpose: "decide", task: "A vs B 트레이드오프 비교" })`
- 작은 변경, 숨겨진 부작용이 적은 방향을 선호한다
- 채택하지 않은 대안도 HTML 보고서에 기록한다

---

## 5. 장애물 처리 (Obstacle Handling)

막혔다고 포기하지 않는다. 단계적으로 우회책을 시도한다.

1. 대체 도구/CLI로 같은 결과를 낼 수 있는지 확인
2. `browse` intent로 웹 인터페이스 직접 접근
3. 우회 불가 시 → 제약 사항을 명시하고 사용자에게 보고

---

## 6. 검증 (Validation)

구현 완료 후 **증거 없이 완료 선언하지 않는다**.

가능한 최고 티어의 검증을 수행한다:
- **Tier 1** — 자동 테스트, lint, typecheck (가장 신뢰도 높음)
- **Tier 2** — 브라우저/인터랙티브 동작 확인
- **Tier 3** — 소스 분석 + 공식 문서 인용 (PARTIAL로 명시)

```
intent({ mode: "run", purpose: "verify", difficulty: "medium", task: "수정 결과 검증 — Tier 1 우선" })
```

공식 문서를 인용할 수 없는 경우 "소스 코드 분석 기반" 임을 명시한다.

---

## 7. HTML 보고서 산출물 (필수)

작업 완료 후 **한국어** HTML 보고서 3종을 `/Users/creatrip/Documents/`에 생성한다.

`implement` intent로 to-html 스킬을 활용하는 워커에게 위임한다.  
워커는 메인 컨텍스트를 상속하므로 작업 내용을 그대로 반영할 수 있다.

1. **결과 보고서** — 문제 이해 과정, 실행한 작업, 해결 방법
2. **대안 탐색 보고서** — 고려한 대안들, 트레이드오프, 채택/기각 이유
3. **회고 보고서** — 막혔던 부분, 개선 가능한 도구/프롬프트/시스템 요소

---

이 지침은 까다롭지만 충분히 해낼 수 있다. 좋은 결과를 기대한다.
