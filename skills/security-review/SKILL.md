---
name: security-review
description: security-auditor 서브에이전트를 호출해 코드 변경사항의 보안 취약점을 검토하는 스킬.
argument-hint: "이 브랜치 보안 검토해줘 | PR 보안 리뷰 | 보안 취약점 점검"
disable-model-invocation: false
---

# security-review

`$ARGUMENTS`를 대상으로 `security-auditor` 서브에이전트를 호출해 보안 취약점을 검토한다.

## 목적
- 코드 변경사항에서 악용 가능한 보안 취약점을 탐지한다.
- SQL injection, auth bypass, command injection 등 고신뢰도 취약점만 보고한다.
- false positive를 최소화하여 실제 조치가 필요한 항목만 전달한다.

## 실행 규칙

### 1. diff 생성
검토 대상에 맞는 diff를 생성하여 임시 파일에 저장한다.

| 입력 | diff 생성 방법 |
|------|---------------|
| 브랜치명 | `git diff main...<branch>` |
| 커밋 범위 | `git diff <from>..<to>` |
| 파일 목록 | 각 파일에 대해 `git diff HEAD -- <file>` 실행. tracked 파일이 아니면 `diff /dev/null <file>`로 전체 내용을 diff 형식으로 생성 |
| 아무것도 명시 안 됨 | `git diff HEAD` + untracked 파일은 `git ls-files --others --exclude-standard`로 목록을 구한 뒤 각각 `diff /dev/null <file>`로 추가 |

**핵심:** untracked(신규) 파일이 누락되지 않도록 항상 확인한다. `git diff HEAD`만으로는 untracked 파일이 빠진다.

### 2. security-auditor 호출 (`subagent run`)
생성된 diff 파일 경로와 변경 파일 목록을 함께 전달한다.

**호출 프롬프트:**
> 보안 리뷰를 수행해줘. diff 파일: {diff_path}. 변경된 파일 목록: {file_list}. 각 파일의 전체 컨텍스트를 읽고, 사용자 입력에서 민감한 연산(SQL, LLM, 파일 시스템)까지의 데이터 플로우를 추적해줘.

### 3. 결과 정리
security-auditor의 YAML 출력을 요약한다.

## 최종 응답 형식

1. `Result`
   - "vulnerabilities found" 또는 "no vulnerabilities found"
   - 분석한 영역 요약 (예: "6개 API 라우트, SQL 쿼리 빌더, 입력 검증")
2. `Findings` (있을 경우)
   - 파일, 라인, 카테고리, 심각도, 설명, 공격 시나리오, 권장 수정
3. `Areas Analyzed`
   - 검토한 보안 영역별 간단 요약 테이블

## 주의
- 이 스킬은 읽기 전용이다. 코드를 수정하지 않는다.
- confidence 7 미만 findings는 자동 제외된다.
- hard exclusion 목록(DoS, rate limiting, secrets on disk 등)에 해당하는 항목은 보고하지 않는다.
- 결과가 clean이어도 "분석한 영역"을 반드시 명시하여 커버리지를 확인할 수 있게 한다.
