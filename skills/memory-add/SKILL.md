---
name: memory-add
description: 현재 pi 세션 transcript 에서 기억할 가치가 있는 fact (사용자 룰, 프로젝트 관례, 도구 gotcha, 도메인 사실, 의사결정+이유, 안티패턴) 를 추출해 사용자 confirm 후 remember 로 저장하는 워크플로우. 사용자가 "메모리 추가", "기억할거 정리해서 추가", "memory add", "/memory-add", "이번 세션에서 배운거 저장", "지금까지 룰 메모리에 박아"처럼 말하면 발동. 시크릿/PII/일회성 ID는 자동 제외, 기존 memory 와 dedup, 항목별 confirm 후에만 remember 호출.
argument-hint: "이번 세션 메모리에 추가 | 방금 정한 룰 기억 | 도메인 사실만 추가 | 시크릿 빼고 추가"
disable-model-invocation: false
---

# memory-add

`$ARGUMENTS` 가 비어있으면 현재 세션 전체 transcript 에서 후보를 모은다. 토픽/카테고리 명시가 있으면 그 범위로 좁힌다.

## Hard Rules

```
사용자 confirm 없이 remember 를 호출하지 않는다.
시크릿 / PII / 일회성 ID 는 후보에서 제외 — 통과시키지 않는다.
```

dry-run 이 기본 — 후보를 모두 보여주고 사용자가 선택한 것만 저장.

## Phase 1 — 후보 추출

현재 세션 컨텍스트(이미 agent 에 로드되어 있음)에서 다음 6개 카테고리로 분류한 후보를 모은다.

### K1. 사용자 룰 / 선호
- 명령형 + 미래 표현: "앞으로 X는 Y로", "X 사용 금지", "이제부터 Z 적용".
- 사용자가 명시적으로 "기억해", "remember this", "이 룰 적용" 이라고 말한 부분.

### K2. 프로젝트 관례 (스코프 = project)
- 사실형 + 영속성: "이 repo 는 X 사용", "Y 는 Z 로 빌드", "패턴은 W".
- repo 별 도구 / 컨벤션 / 디렉토리 구조 핵심.

### K3. 도구 gotcha / 우회법
- 인과 + 해결: "X 에러 → Y 옵션 추가", "Z 는 W 후 작동".
- 같은 세션에서 시행착오 끝에 발견한 fix.

### K4. 도메인 사실
- 정량 / 식별: "결제 OFF 1383건", "API 5분 쿨다운", "테이블 X 의 컬럼 Y 는 nullable".
- 변경 빈도 낮은 사실만.

### K5. 의사결정 + 이유
- 단순 결정만 ("PR 머지함") 은 제외. 이유까지 있어야 후보. "X 결정함, 이유는 Y".

### K6. 안티패턴 / lesson
- "X 다시 쓰지 마", "Y 패턴 지양", "Z 는 항상 실패".

## Phase 2 — 블랙리스트 / Ephemeral 필터 (강제)

추출 후보를 다음 패턴으로 사전 필터. 통과 못 하면 후보에서 즉시 제외.

### F1. 시크릿
정규식: `(ghp_[A-Za-z0-9]{36,}|gho_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{82,}|glpat_[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|xoxb-[0-9]+-[0-9]+-[A-Za-z0-9]+|xoxp-[0-9]+-[0-9]+-[0-9]+-[A-Za-z0-9]+)`

### F2. 토큰 환경변수
`[A-Z_]*(TOKEN|KEY|SECRET|PASSWORD|API_KEY)\s*=\s*\S{20,}`

### F3. PII
- 전화 `01[016789]-?\d{3,4}-\d{4}`
- 카드 `\d{4}-?\d{4}-?\d{4}-?\d{4}`
- 주민번호 패턴

### F4. Ephemeral reference
- PR 번호 `#\d+`, Jira 티켓 `[A-Z]{2,}-\d+`, 커밋 SHA `[a-f0-9]{7,40}`, Sentry issue id 패턴.
- 본문 핵심에 박혀있고 ID 제거하면 의미 없는 경우 제외.
- ID 제거하고 durable 본문으로 다시 쓸 수 있으면 그 형태로 후보 유지 (예: `PR #2458 hotfix → production 머지` 는 제외, `AOS google billing 옵저버빌리티 회복은 production 핫픽스 경로 필수` 는 K5 후보).

### F5. 일회성 결과
- "오늘", "방금", "지금", "이번에" + 과거 동사 ("했다", "통과", "성공") → 제외.
- "다시", "안 돼", "고쳐줘", "에러 났어" 같은 retry 노이즈 자체 → 제외.

### F6. 임시 worktree 경로
- `temp-\d{8}-\d{6}` 포함된 절대경로 → 제외.

## Phase 3 — 기존 memory 와 dedup

각 후보 c 에 대해:
1. `recall({ query: <c.title 또는 핵심 키워드> })` 로 유사 entry 검색.
2. 유사 entry 가 있으면 본문 비교:
   - 거의 동일 → 후보 status = `SKIP (already-known)`, 사용자에 노출하되 default-off.
   - 부분적으로 다름 (강화/구체화) → status = `UPDATE` (기존 forget + 새 remember 제안).
   - 명백히 별개 → status = `ADD`.
3. 모호하면 status = `UNCERTAIN`, 사용자에 동시 노출.

## Phase 4 — 사용자 confirm

`ask_user_question` 으로 후보 목록을 보여준다.

- 카테고리별 그룹핑 (K1~K6).
- 각 후보에 (title, scope 제안, content 요약, status, 추출 근거) 표기.
- `checkbox` 로 일괄 선택 + 항목별 default 권장.
  - default-on: ADD + 명시적 K1 룰
  - default-off: SKIP + UNCERTAIN
- 사용자가 본문 편집 원하면 항목별 `text` 추가 질문.
- scope 변경 원하면 항목별 `radio` (`user` / `project`).

## Phase 5 — 적용

확정된 항목만:

1. **UPDATE** 처리 (구 entry forget → 새 remember). 새 remember 먼저 호출, 성공 확인 후 forget. 역순 금지.
2. **ADD** 처리 (`remember({ content, scope, title? })`). title 명시는 검색성 위해 권장.

각 호출 결과 수집. 실패 시 중단 + 사용자 알림.

## Phase 6 — 최종 보고

```markdown
# memory-add 결과

세션: <sessionId>
후보: <N> (extracted) → <M> (filtered) → <K> (user-confirmed) → <K'> (applied)

## Applied
- ➕ ADD: 5 (K1: 2, K3: 2, K5: 1)
- 🔄 UPDATE: 2

## Skipped (사용자 결정)
- ...

## Filtered out (블랙리스트)
- 1 시크릿 패턴, 2 ephemeral PR ID, 3 일회성 결과
```

## 안전 원칙

- **시크릿/PII는 사용자 노출도 안 함** — 후보 단계에서 즉시 drop, 보고 단계에서는 카운트만 노출 ("1 시크릿 패턴 필터됨").
- **사용자 의도 추정 금지** — 후보 제안만, 실행은 confirm 후.
- **UPDATE 시 새 remember 먼저 → 구 forget**. 역순이면 데이터 손실.
- **세션 transcript 외 정보 임의 추가 금지** — agent 가 알고 있는 일반 지식을 fact 로 박지 않는다. 출처는 항상 현재 세션.
- **dry-run 결과 먼저 사용자에 노출**.
- **scope 모호 시 사용자에 묻기** — agent 임의 결정 금지.

## 트리거 예시

- "이번 세션에서 메모리 추가할거 정리해줘"
- "방금 결정한 룰들 기억해놔"
- "지금까지 배운 거 메모리에 박아"
- "이 세션 도메인 사실들 저장"
- "/memory-add"
