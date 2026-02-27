---
description: 변경사항 기반 QA 체이닝 (시나리오 → 브라우저 테스트 → 검증 → 리뷰)
---
변경사항을 바탕으로 유저 테스트 시나리오를 검증하고, 실제 브라우저에서 꼼꼼히 테스트해줘.
아래 의사코드 흐름대로 에이전트를 체이닝해서 진행해.

```pseudo
// Phase 1: 테스트 시나리오 도출
scenarios = worker("현재 변경사항을 분석하고, 브라우저에서 테스트 가능한 유저 시나리오를 정리해줘")

// Phase 2: 브라우저 테스트 실행
test_results = browser(scenarios, "각 시나리오를 실제 브라우저에서 꼼꼼히 테스트하고, 결과와 스크린샷을 반환해줘")

// Phase 3: 의심 항목 정밀 검증
for issue in test_results where 의심되거나_실패한_항목:
    fix = worker("이 문제를 분석하고 수정해줘: {issue}")
    verifier(fix, "수정이 올바른지 코드 레벨에서 검증해줘")

// Phase 4: 수정 후 재검증
if 수정사항_존재:
    retest_results = browser("수정된 부분을 다시 브라우저에서 테스트하고 스크린샷과 함께 결과를 반환해줘")
    assert retest_results.all_passed

// Phase 5: 최종 코드 리뷰
if 모든_테스트_통과:
    deep-reviewer("전체 변경사항을 리뷰해줘")
```

$@
