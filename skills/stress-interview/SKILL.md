---
name: stress-interview
description: verifier + reviewer + challenger를 병렬 호출해 동일 변경사항을 다각도로 검토받는 스킬.
argument-hint: "이 변경사항 검토해줘 | 방금 수정한 코드 스트레스 테스트 | PR 전 점검"
disable-model-invocation: false
---

# stress-interview

`$ARGUMENTS`에 대해 **`verifier` + `reviewer` + `challenger`를 병렬 호출**해 교차 검토한다.

## 목적
- 구현/수정 사항을 배포 전 관점에서 압박 검토한다.
- 실행 증거, 코드 리뷰, 반론/리스크를 동시에 수집한다.
- 한 에이전트의 편향을 줄이고, 겹치는 지적과 상충 지적을 비교한다.

## 실행 규칙
1. 먼저 검토 대상을 1~2문장으로 재정의한다.
2. `subagent help`가 아직 확인되지 않았거나 현재 세션에서 인터페이스가 불명확하면 먼저 확인한다.
3. 아래 3개를 **병렬**로 실행한다.
   - `verifier`: 테스트/타입체크/빌드/재현 가능한 검증 중심
   - `reviewer`: correctness, regressions, maintainability 중심
   - `challenger`: 숨은 가정, 실패 시나리오, 의사결정 취약점 중심
4. 세 결과를 합쳐 아래 기준으로 정리한다.
   - 공통 지적: 둘 이상이 비슷하게 지적한 항목
   - 독립 지적: 한 에이전트만 찾은 항목이지만 타당한 항목
   - 상충 지적: 서로 결론이 다른 부분
5. 에이전트 결과를 **있는 그대로 요약**하고, 근거 없이 임의 판정하지 않는다.

## 권장 호출 프롬프트
- `verifier`: "$ARGUMENTS 를 검증해줘. 가능하면 테스트/타입체크/빌드/재현 가능한 증거를 수집해줘."
- `reviewer`: "$ARGUMENTS 를 코드 리뷰해줘. correctness, regression, maintainability 위주로 봐줘."
- `challenger`: "$ARGUMENTS 에 대해 숨은 가정, 실패 시나리오, 취약한 결정 포인트를 최대 3개 질문으로 압박 검토해줘."

## 종합 응답 형식
최종 응답은 아래 순서로 간단히 정리한다.

1. `Overall`
   - Ready | Needs changes | Blocked
2. `Common Findings`
   - 공통 지적만 추림
3. `Verifier`
   - 핵심 검증 결과
4. `Reviewer`
   - 핵심 리뷰 결과
5. `Challenger`
   - 핵심 질문/리스크
6. `Severity Classification`
   - 🔴 Must-fix: blocker, correctness 오류, 재현 가능한 버그
   - 🟡 Should-fix: maintainability, clarity, 저위험 개선
   - ⚪ Won't-fix: 근거 부족, 의도된 설계, 대규모 변경 필요
7. `Recommended Next Step`
   - 수정 필요 시 가장 먼저 할 일 1~3개

## 2-Pass 리뷰 모드

`$ARGUMENTS`에 `--2pass` 또는 "2단계 리뷰"가 포함되면 아래 순서를 따른다:

### Pass 1: Spec Compliance (명세 적합성)
목적: 구현이 요구사항/계획/명세를 **정확히** 충족하는지 확인.

1. `verifier`에게: 명세 대비 구현 일치 여부 검증 요청
2. `reviewer`에게: 요구사항 누락/초과 구현 집중 리뷰 요청

판정:
- **누락(Under-built)**: 명세에 있는데 구현에 없는 것
- **초과(Over-built)**: 명세에 없는데 구현에 있는 것 → YAGNI 위반
- 누락/초과가 있으면 수정 후 Pass 1 재실행

### Pass 2: Code Quality (코드 품질)
**Pass 1 통과 후에만** 진행한다.

1. `reviewer`에게: correctness, regressions, maintainability 리뷰 요청
2. `challenger`에게: 숨은 가정, 실패 시나리오 압박 검토 요청

판정:
- Critical/Important 이슈 → 수정 후 Pass 2 재실행
- Minor 이슈 → 기록만 하고 통과

**주의: Pass 1 전에 Pass 2를 시작하지 않는다.** 명세 미충족 상태에서 코드 품질을 논하는 것은 무의미하다.

## 주의
- 3개 결과가 모두 오기 전 성급히 결론 내리지 않는다.
- `verifier`가 실행 증거를 못 모으면 그 사실을 명시한다.
- `challenger`의 질문은 가설일 수 있으므로, 검증된 사실과 구분해서 표시한다.
- 사용자가 단순 요약만 원하면 장황하게 재서술하지 말고 핵심만 정리한다.
