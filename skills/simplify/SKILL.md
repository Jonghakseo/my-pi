---
name: simplify
description: code-cleaner → worker-fast → simplifier 체인으로 코드를 구조적으로 정리한 뒤 표현까지 다듬는 스킬.
argument-hint: "방금 수정한 코드 다듬어줘 | 이 변경사항 polish 해줘 | 가독성만 개선해줘 | 코드 정리해줘"
disable-model-invocation: false
---

# simplify

`$ARGUMENTS`를 대상으로 **code-cleaner → worker-fast → simplifier** 3단계 체인을 실행한다.

## 목적
- 코드의 구조적 문제(중복, dead code, 비효율)를 먼저 진단한다.
- 진단 결과를 바탕으로 빠르게 수정한다.
- 마지막으로 표현과 가독성을 다듬는다.
- 기능 변경 없이 코드 품질만 높인다.

## 3단계 체인

### Step 1: `code-cleaner` — 진단 (읽기 전용)
대상 코드를 3-phase(reuse, quality, efficiency)로 스캔하여 정리 항목을 수집한다.

**호출 프롬프트:**
> `$ARGUMENTS` 를 code cleanup 리뷰해줘. 중복 코드, 품질 이슈, 비효율성을 3-phase로 스캔해서 findings를 보고해줘.

**마스터 판단 단계:**
- code-cleaner 결과에서 **P0/P1 findings만** 추린다.
- P2 이하는 Step 3(simplifier)에서 자연스럽게 처리되므로 무시한다.
- P0/P1이 없으면 Step 2를 건너뛰고 바로 Step 3으로 간다.
- findings 중 "exceeds cleanup scope"로 표시된 항목은 제외하고 사용자에게 보고만 한다.

### Step 2: `worker-fast` — 수정 (조건부)
Step 1에서 추린 P0/P1 항목만 빠르게 수정한다.

**호출 프롬프트:**
> 아래 cleanup findings를 수정해줘. 동작 변경 없이 구조만 개선해. 각 수정 후 타입체크/테스트 확인해줘.
> {P0/P1 findings 목록}

**안전장치:**
- worker-fast가 3+ 파일 또는 아키텍처 변경이 필요하다고 판단하면 escalation한다. 이 경우 사용자에게 보고하고 중단한다.
- 수정 후 타입체크/테스트 실패 시 revert하고 해당 항목을 skip 처리한다.

### Step 3: `simplifier` — 표현 다듬기
Step 2에서 수정된 파일(또는 원본 대상)의 가독성과 일관성을 다듬는다.

**호출 프롬프트:**
> `$ARGUMENTS` 를 code polishing 해줘. 동작은 바꾸지 말고, 최근 수정되었거나 명시된 범위만 가독성과 유지보수성 관점에서 다듬어줘. 결과는 수정한 파일과 라인만 반환해줘.

**규칙:**
- simplifier 결과가 no-op에 가까우면 억지로 추가 변경하지 않는다.
- 설계 변경, API 변경, 의미 변경은 금지한다.

## 실행 규칙
1. 대상 범위를 1~2문장으로 고정한다.
2. 반드시 Step 1 → (Step 2) → Step 3 순서로 진행한다. 순서를 바꾸거나 건너뛰지 않는다 (Step 2는 조건부 skip 가능).
3. 각 Step의 서브에이전트는 `subagent chain`으로 순차 실행한다.
4. 체인 중 어느 단계에서든 실패하면 해당 단계에서 멈추고 결과를 보고한다.

## 최종 응답 형식

1. `Scan` (code-cleaner 결과 요약)
   - P0/P1 findings 수
   - 핵심 항목 1줄씩
2. `Fix` (worker-fast 결과, 또는 "skipped — no P0/P1")
   - 수정된 파일 목록
   - skip된 항목과 사유
3. `Polish` (simplifier 결과)
   - 수정된 파일 목록
   - no-op이면 "no changes needed"
4. `Remaining`
   - 자동 수정하지 않은 항목 (scope 초과, P2 이하)

## 주의
- 이 스킬은 기능 변경이 아니라 코드 품질 개선 전용이다.
- 사용자가 functional change를 요청한 경우 이 스킬 단독으로 처리하지 않는다.
- code-cleaner는 읽기 전용이다. 절대 코드를 수정하지 않는다.
- worker-fast의 수정은 항상 최소 범위여야 한다. 3+ 파일 변경 시 escalation.
