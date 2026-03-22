---
name: self-healing
description: stress-interview로 문제를 모은 뒤 worker 수정 → 재검토를 2사이클 반복하는 자가 치유 스킬.
argument-hint: "이 변경사항 자동으로 두 번 고쳐가며 안정화해줘 | 방금 만든 코드 self-healing 돌려줘"
disable-model-invocation: false
---

# self-healing

`$ARGUMENTS`에 대해 아래 루프를 수행한다:

- **Cycle 1**: `stress-interview` 실행 → `worker` 수정
- **Cycle 2**: 다시 `stress-interview` 실행 → `worker` 수정

총 **2 사이클**만 수행한다. 무한 반복하지 않는다.

## 목적
- 초기 구현의 결함, 리스크, 미검증 영역을 빠르게 줄인다.
- reviewer/verifier/challenger의 관점을 worker 수정 루프에 반영한다.
- 짧은 자동 안정화 루틴으로 품질을 끌어올린다.

## 실행 순서
1. 대상 범위를 1~2문장으로 고정한다.
2. **Cycle 1**
   - `/skill:stress-interview $ARGUMENTS`
   - 결과에서 수정이 필요한 actionable item만 추린다.
   - `worker`에게 **해당 actionable item만** 수정하도록 요청한다.
3. **Cycle 2**
   - 다시 `/skill:stress-interview $ARGUMENTS`
   - 남은 actionable item만 추린다.
   - `worker`에게 다시 수정 요청한다.
4. 2사이클 후 종료하고, 남은 리스크와 미해결 항목을 명시한다.

## worker 지시 원칙
- stress-interview 결과 중 **구체적이고 재현 가능하며 수정 가치가 높은 항목만** 반영한다.
- 모호한 주장, 근거 부족 항목, 의도된 변경으로 보이는 항목은 자동 수정하지 않는다.
- 수정 범위를 불필요하게 넓히지 않는다.
- 각 사이클마다 가능한 최소 수정으로 진행한다.

## 사이클별 체크리스트
stress-interview 결과에서 reviewer의 `fix_class`와 `priority` 필드를 활용하여 분류한다:

- `Must fix now (auto)`: P0/P1 + fix_class `AUTO_FIX` (blocker / correctness / reproducible failures → worker가 즉시 수정)
- `Must fix now (escalate)`: P0/P1 + fix_class `ASK` (판단이 필요한 심각 이슈 → **자동 수정하지 않고** 사용자에게 에스컬레이션)
- `Good to fix`: P2/P3 + fix_class `AUTO_FIX` (maintainability / clarity / low-risk cleanup)
- `Report as remaining risk`: P2/P3 + fix_class `ASK` (판단 필요하지만 긴급하지 않음 → Remaining Risks에 기록)
- `Do not auto-fix`: fix_class `INFO`, 또는 근거 부족, 제품 의도 불명, 대규모 설계 변경 필요

reviewer가 `fix_class`를 제공하지 않는 경우 기존 심각도 언어(Critical/Important/Minor)로 폴백한다.

## 종료 조건
다음 중 하나면 종료한다.
- 2사이클 완료
- 수정할 actionable item이 더 이상 없음
- worker가 범위 초과/불명확성으로 중단함

## 최종 응답 형식
1. `Cycle 1`
   - stress-interview 핵심 결과
   - worker가 반영한 수정
2. `Cycle 2`
   - stress-interview 핵심 결과
   - worker가 반영한 수정
3. `Remaining Risks`
   - 여전히 남은 문제
4. `Recommendation`
   - 추가 수동 작업 필요 여부

## 주의
- 이 스킬은 자동 수정 루프이므로, 변경 범위 통제가 가장 중요하다.
- 사용자 요청 범위를 벗어나는 리팩터링/정리는 하지 않는다.
- 마지막 상태가 "완벽함"이라고 단정하지 말고, 2사이클 기준의 남은 리스크를 솔직히 적는다.
