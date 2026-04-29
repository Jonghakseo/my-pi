---
name: memory-manage
description: 기존 ~/.pi/memory 의 user/project 메모리를 검토·정리·통합·폐기하는 워크플로우. 사용자가 "메모리 관리", "메모리 정리", "memory cleanup", "/memory-manage", "기존 메모리 통합", "오래된 기억 지워", "중복 메모리 정리"처럼 말하면 발동. recall/memory_list 로 전체 스캔 후 중복·노후·미배치·블랙리스트 위반을 카테고리별로 모아 사용자에게 항목별 confirm 받아 forget/remember 조합으로 적용. 절대 confirm 없이 forget 호출하지 않음.
argument-hint: "메모리 관리해줘 | 중복 메모리 정리 | 시크릿 새서 들어간 메모리 정리 | 특정 토픽만 정리"
disable-model-invocation: false
---

# memory-manage

`$ARGUMENTS` 가 비어있으면 user + project 양쪽 전체를 대상으로, 토픽/scope 명시가 있으면 그 범위만 다룬다.

## Hard Rules

```
사용자 confirm 없이 forget 을 호출하지 않는다.
remember 로 같은 내용을 새로 쓰는 통합·이동 동작도 confirm 후에만 한다.
```

dry-run 이 기본 — 후보를 모두 모아서 한 번에 보여준 뒤 사용자가 적용 여부를 결정한다.

## Phase 1 — 스캔

1. `memory_list({ scope: "user" })` 와 `memory_list({ scope: "project" })` 로 전체 메모리 인덱스 확보.
2. 항목 수가 많으면 (>30) `recall({ query })` 로 키워드 군집화 보조 (중복 후보를 좁히는 용도). 적으면 전체 `recall({ id })` 로 본문 펼쳐서 직접 비교.
3. 본문 펼친 결과를 in-memory 로만 보유. 파일 직접 수정 금지 (반드시 forget/remember 도구 경유).

## Phase 2 — Issue 카테고리별 후보 정리

다음 6 카테고리로 분류하고 각 항목에 (scope, topic, title, evidence, suggestion) 을 채운다.

### M1. 중복 / 거의 같은 entry
- 동일 scope/topic 안에서 title 또는 본문이 사실상 동일.
- suggestion = `MERGE` (남길 1개 + forget 할 N개).

### M2. 통합 후보 (같은 주제, 흩어진 entry)
- 서로 다른 entry 가 같은 도구 gotcha / 같은 룰 / 같은 도메인 사실의 부분만 다룸.
- suggestion = `MERGE` (새 통합 본문 제안 + forget 할 N개).

### M3. 노후/시대 지남 (stale)
- PR 번호 (`#\d+`), 커밋 SHA (`[a-f0-9]{7,40}`), Sentry 이슈 ID, Jira 티켓 번호가 본문 핵심에 박힌 일회성 결정 (ephemeral reference).
- 임시 worktree 경로 (`temp-\d{8}-\d{6}` 포함 절대경로).
- 시대가 지난 도구/버전 ("node 16 사용", "eslint 사용" 같이 명백히 대체된 것).
- suggestion = `DEPRECATE` (forget) 또는 ID 제거하고 durable 본문으로 `REWRITE`.

### M4. 잘못된 scope
- project memory 에 있어야 할 것이 user 에 있거나 그 반대.
- suggestion = `RELOCATE` (forget 후 다른 scope 에 remember).

### M5. 블랙리스트 위반 (보안)
- 본문에 시크릿 패턴 노출: `(ghp_[A-Za-z0-9]{36,}|gho_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{82,}|glpat_[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|xoxb-[0-9]+-[0-9]+-[A-Za-z0-9]+|xoxp-[0-9]+-[0-9]+-[0-9]+-[A-Za-z0-9]+)`.
- `[A-Z_]*(TOKEN|KEY|SECRET|PASSWORD|API_KEY)\s*=\s*\S{20,}` 형태의 환경변수.
- 전화 (`01[016789]-?\d{3,4}-\d{4}`), 카드, 주민번호 패턴.
- suggestion = **즉시 `URGENT_FORGET` 표시**, 사용자에 우선 노출. 같은 fact 의 sanitized 버전을 동시에 `REWRITE` 후보로 제안.

### M6. 의도 불명 / 너무 모호함
- 무엇을 가리키는지 외부 참조 없이는 알 수 없는 본문 (예: "이 부분 처리하기").
- suggestion = `CLARIFY` (사용자에 의미 묻기) 또는 `DEPRECATE`.

## Phase 3 — 사용자 컨펌

`ask_user_question` 으로 다음과 같이 일괄 또는 카테고리별 묶어서 묻는다.

- 항목 수가 적음 (≤8) → 단일 `checkbox` 질문에 모든 후보를 옵션으로 나열, 적용할 것만 체크.
- 많음 (>8) → 카테고리별로 분할 (M5 보안은 항상 첫 번째 질문, default = 모두 선택).
- M2 MERGE 후보는 통합 본문 초안을 description 에 함께 노출. 사용자가 본문 편집 원하면 별도 `text` 질문으로 받는다.
- M6 CLARIFY 는 항목별 `radio` (`forget` / `keep as-is` / `rewrite`).

## Phase 4 — 적용

확정된 동작만 순서대로 실행:

1. **M5 URGENT_FORGET 우선** — `forget({ title, topic?, scope? })` 즉시 실행 후 sanitized 버전 `remember`.
2. **M3/M6 DEPRECATE** — `forget`.
3. **M3 REWRITE** — old `forget` → new `remember`.
4. **M1/M2 MERGE** — 통합 본문 `remember` → 구 entry 들 `forget`. 순서 중요 (새 entry 먼저 저장해야 사고 시 회복 가능).
5. **M4 RELOCATE** — 새 scope 에 `remember` → 기존 `forget`.

각 호출마다 결과 로그 (성공/실패) 를 수집한다. 실패 시 즉시 중단하고 사용자 알림 (이미 적용된 변경은 `Applied so far` 로 보고).

## Phase 5 — 최종 보고

```markdown
# memory-manage 결과

대상: <scope/topic>
스캔: <N> entries

## Applied
- 🛡️ URGENT_FORGET: 2 (M5)
- 🔁 MERGE: 3 (M1+M2)
- 🗑️ DEPRECATE: 5 (M3/M6)
- ✏️ REWRITE: 2 (M3)
- 📦 RELOCATE: 1 (M4)

## Skipped (사용자 keep 결정)
- ...

## Failed (도구 호출 실패)
- ...
```

## 안전 원칙

- **사용자 의도 추정 금지** — 후보로만 제안, 실행은 confirm 후.
- **MERGE 시 새 entry 먼저 저장 → 구 forget**. 역순이면 사고 시 데이터 손실.
- **M5 보안 위반은 항상 default-on** — 사용자가 의도적으로 unchecking 해야만 skip.
- **Confirm 없이 forget 호출 절대 금지.**
- **메모리 파일 직접 fs 수정 금지** — 항상 forget/remember 도구 경유 (memory layer 가 인덱스/포맷 일관성 책임).
- **dry-run 결과는 항상 사용자에 먼저 노출**.

## 트리거 예시

- "메모리 관리해줘"
- "기존 메모리 정리하고 싶어"
- "중복된 기억들 합쳐줘"
- "오래된 PR 번호 박힌 메모리들 정리"
- "혹시 토큰 새서 들어간 메모리 있는지 확인해서 정리"
- "/memory-manage"
