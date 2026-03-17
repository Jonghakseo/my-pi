---
name: simplify
description: code-cleaner → (조건부) worker-fast+simplifier 체인 또는 simplifier 단독으로 코드를 정리하는 스킬.
argument-hint: "방금 수정한 코드 다듬어줘 | 이 변경사항 polish 해줘 | 가독성만 개선해줘 | 코드 정리해줘"
disable-model-invocation: false
---

# simplify

`$ARGUMENTS`를 대상으로 **code-cleaner → (조건부 분기) → simplifier** 흐름을 실행한다.

## 목적
- 코드의 구조적 문제(중복, dead code, 비효율)를 먼저 진단한다.
- 진단 결과에 따라 수정이 필요하면 빠르게 수정 후 다듬는다.
- 기능 변경 없이 코드 품질만 높인다.

## 실행 흐름

```
code-cleaner (단독 run)
       │
       ▼
  마스터 판단
       │
       ├─ P0 있음 → 사용자에게 보고 + escalation (자동 수정 안 함)
       │
       ├─ P1 있음 (단일 파일 범위) → worker-fast + simplifier 체인
       │
       ├─ P1 있음 (cross-file) → 사용자에게 보고 (worker 또는 수동 처리 권장)
       │
       └─ P0/P1 없음 → simplifier 단독 run
```

## Step 1: `code-cleaner` — 진단 (단독 `subagent run`)

대상 코드를 3-phase(reuse, quality, efficiency)로 스캔하여 정리 항목을 수집한다.

**호출 프롬프트:**
> `$ARGUMENTS` 를 code cleanup 리뷰해줘. 중복 코드, 품질 이슈, 비효율성을 3-phase로 스캔해서 findings를 보고해줘.

**마스터 판단 단계** (code-cleaner 결과 수신 후):
1. findings YAML에서 `priority`와 `exceeds_cleanup_scope` 필드를 확인한다.
2. **P0 finding** → 자동 수정하지 않는다. 사용자에게 보고하고 escalation한다. (P0은 correctness/data-loss/security이므로 동작 변경이 필요할 수 있다.)
3. **P1 finding + `exceeds_cleanup_scope: true`** → 자동 수정하지 않는다. 사용자에게 보고만 한다.
4. **P1 finding + `exceeds_cleanup_scope: false` + 단일 파일 범위** → Step 2A로 진행.
5. **P1 finding + cross-file 범위** → 사용자에게 보고하고 worker(또는 수동) 처리를 권장한다. worker-fast는 단일 파일 수정에 최적화되어 있으므로 넘기지 않는다.
6. **P0/P1 없음** → Step 2B로 진행.

## Step 2A: `worker-fast` + `simplifier` 체인 (`subagent chain`)

P1 findings가 있고 worker-fast 범위 내일 때만 실행한다.

마스터는 code-cleaner 결과에서 추린 P1 findings를 **구조화된 목록**(파일 경로, 라인 범위, 제목, 권장 조치 포함)으로 정리하여 worker-fast 태스크에 포함한다.

**체인 호출:**
```
subagent chain
  --agent worker-fast --task "아래 cleanup findings를 수정해줘. 동작 변경 없이 구조만 개선해. 각 수정 후 타입체크/테스트 확인해줘.
    {P1 findings 목록: title, source_file, line_range, suggested_action}"
  --agent simplifier --task "$ARGUMENTS 를 code polishing 해줘. 동작은 바꾸지 말고, 방금 수정된 범위의 가독성과 유지보수성을 다듬어줘. 결과는 수정한 파일과 라인만 반환해줘."
```

**안전장치:**
- worker-fast가 3+ 파일 또는 아키텍처 변경이 필요하다고 판단하면 escalation한다.
- 수정 후 타입체크/테스트 실패 시 revert하고 해당 항목을 skip 처리한다.

## Step 2B: `simplifier` 단독 (`subagent run`)

구조적 수정 없이 표현만 다듬을 때 실행한다.

**호출 프롬프트:**
> `$ARGUMENTS` 를 code polishing 해줘. 동작은 바꾸지 말고, 최근 수정되었거나 명시된 범위만 가독성과 유지보수성 관점에서 다듬어줘. 결과는 수정한 파일과 라인만 반환해줘.

**규칙:**
- simplifier 결과가 no-op에 가까우면 억지로 추가 변경하지 않는다.
- 설계 변경, API 변경, 의미 변경은 금지한다.

## 최종 응답 형식

1. `Scan` (code-cleaner 결과 요약)
   - P0/P1/P2 findings 수
   - 핵심 항목 1줄씩
   - escalation 항목 (P0 또는 scope 초과)
2. `Fix` (worker-fast 결과, 또는 "skipped")
   - 수정된 파일 목록
   - skip된 항목과 사유
3. `Polish` (simplifier 결과)
   - 수정된 파일 목록
   - no-op이면 "no changes needed"
4. `Remaining`
   - 자동 수정하지 않은 항목 (P0, scope 초과, cross-file, P2 이하)

## 주의
- 이 스킬은 기능 변경이 아니라 코드 품질 개선 전용이다.
- 사용자가 functional change를 요청한 경우 이 스킬 단독으로 처리하지 않는다.
- code-cleaner는 읽기 전용이다. 절대 코드를 수정하지 않는다.
- P0 finding은 자동 수정하지 않는다. 반드시 사용자에게 보고한다.
- worker-fast의 범위를 넘어서는 cross-file 수정은 시도하지 않는다.
