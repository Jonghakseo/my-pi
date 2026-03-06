---
name: code-polishing
description: simplifier 서브에이전트를 호출해 최근 수정 코드를 동작 변경 없이 다듬는 스킬.
argument-hint: "방금 수정한 코드 다듬어줘 | 이 변경사항 polish 해줘 | 가독성만 개선해줘"
disable-model-invocation: false
---

# code-polishing

`$ARGUMENTS`를 대상으로 `simplifier` 서브에이전트를 호출해 코드를 다듬는다.

## 목적
- 최근 수정된 코드의 가독성, 일관성, 유지보수성을 높인다.
- 기능 변경 없이 구조와 표현을 더 명료하게 만든다.
- 불필요한 churn 없이 안전한 polishing만 수행한다.

## 실행 규칙
1. polishing 대상 범위를 짧게 재정의한다.
2. `simplifier`에게 아래 원칙으로 작업을 맡긴다.
   - 동작 변경 금지
   - 최근 수정/명시된 범위만 정리
   - 과도한 리팩터링 금지
   - 결과는 수정 파일/라인만 간단히 반환
3. 필요 시 `worker`가 아니라 `simplifier`를 우선 사용한다.
4. simplifier 결과가 no-op에 가까우면 억지로 추가 변경하지 않는다.

## 권장 호출 프롬프트
`$ARGUMENTS 를 code polishing 해줘. 동작은 바꾸지 말고, 최근 수정되었거나 명시된 범위만 가독성과 유지보수성 관점에서 다듬어줘. 결과는 수정한 파일과 라인만 반환해줘.`

## 최종 응답 형식
- `Polished`: 수행 여부
- `Files`: 수정된 파일 목록
- `Notes`: no-op 또는 범위 초과 시 한 줄 설명

## 주의
- 이 스킬은 스타일 전면 개편이 아니다.
- 설계 변경, API 변경, 의미 변경은 금지한다.
- 사용자가 functional change를 요청한 경우 이 스킬 단독으로 처리하지 않는다.
