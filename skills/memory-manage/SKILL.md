---
name: memory-manage
description: "기존 user/project 메모리의 중복·노후·보안·scope 문제를 스캔하고, 보수적인 기준으로 자동 통합·정리할 때 사용한다. 별도 사용자 확인 없이 끝까지 적용한다."
disable-model-invocation: false
---

# memory-manage

`$ARGUMENTS` 가 비어있으면 user + project 양쪽 전체를 대상으로, 토픽/scope 명시가 있으면 그 범위만 다룬다.

## Hard Rules

```
사용자 confirm을 요청하지 않고 스캔부터 적용까지 자동으로 완료한다.
확신이 낮은 후보는 삭제하거나 다시 쓰지 말고 KEEP으로 남긴다.
```

자동 적용이 기본이다. 명백하고 손실 없이 정리할 수 있는 항목만 변경하고, 판단이 애매하면 보존한다.

## Phase 1 — 스캔

1. `memory_list({ scope: "user" })` 와 `memory_list({ scope: "project" })` 로 전체 메모리 인덱스 확보.
2. 항목 수가 많으면 (>30) `recall({ query })` 로 키워드 군집화 보조 (중복 후보를 좁히는 용도). 적으면 전체 `recall({ id })` 로 본문 펼쳐서 직접 비교.
3. 본문 펼친 결과를 in-memory 로만 보유. 파일 직접 수정 금지 (반드시 forget/remember 도구 경유).

## Phase 2 — Issue 카테고리별 후보 정리

다음 7 카테고리로 분류하고 각 항목에 (scope, topic, title, evidence, suggestion) 을 채운다.

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
- suggestion = **즉시 `URGENT_FORGET`**. 같은 fact가 재사용 가치가 있으면 민감값을 제거한 버전을 자동으로 `REWRITE`한다.

### M6. 의도 불명 / 너무 모호함
- 무엇을 가리키는지 외부 참조 없이는 알 수 없는 본문 (예: "이 부분 처리하기").
- suggestion = `CLARIFY` (사용자에 의미 묻기) 또는 `DEPRECATE`.

### M7. 재사용성 낮음 / 1회성
- 다음 작업에서 다시 활용할 일반 규칙·선호·사실이 아니라, 특정 순간이나 단일 사건에만 유효한 지나치게 지엽적인 내용.
- 단순 실행 결과, 종료된 작업의 세부 상태, 재현 가능성이 낮은 예외 케이스처럼 장기 메모리로 보존할 실익이 낮은 항목.
- 중요한 사용자 선호, 안전 규칙, 반복 가능한 도구 gotcha는 좁아 보여도 이 카테고리에서 제외한다.
- suggestion = `DEPRECATE` 또는 재사용 가능한 일반 원칙만 남기는 `REWRITE`.

## Phase 3 — 자동 결정

사용자에게 확인 질문을 하지 않고 다음 기준으로 적용 여부를 결정한다.

- M5는 즉시 적용한다.
- M1은 제목 또는 본문이 사실상 동일할 때만 자동 병합한다.
- M2는 기존 사실과 제약을 빠짐없이 보존하는 통합 본문을 만들 수 있을 때만 자동 병합한다.
- M3/M4/M7은 객관적 근거가 명확할 때만 적용한다. 도구나 경로가 단지 낯설다는 이유만으로 stale 판정하지 않는다.
- M6는 자동 삭제하지 않는다. 의미를 안전하게 복원할 수 없으면 `KEEP_UNCLEAR`로 남긴다.
- 적용하지 않은 후보와 이유도 결과 로그에 기록한다.

## Phase 4 — 적용

자동 결정된 동작을 다음 순서로 실행:

1. **M5 URGENT_FORGET 우선** — `forget({ title, topic?, scope? })` 즉시 실행 후 sanitized 버전 `remember`.
2. **M3/M7 DEPRECATE** — `forget`. M6는 자동 보존한다.
3. **M3/M7 REWRITE** — old `forget` → new `remember`.
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
- 🗑️ DEPRECATE: 5 (M3/M7)
- ✏️ REWRITE: 2 (M3/M7)
- 📦 RELOCATE: 1 (M4)

## Kept (불확실하여 자동 보존)
- ...

## Failed (도구 호출 실패)
- ...
```

## 안전 원칙

- **불확실하면 보존** — 사용자 의도를 추정해 삭제·축약하지 않는다.
- **MERGE 시 새 entry 먼저 저장 → 구 forget**. 역순이면 사고 시 데이터 손실.
- **M5 보안 위반은 즉시 제거**하고, 필요한 경우 민감값 없는 사실만 다시 저장한다.
- **자동 적용은 명백한 후보에만 수행**한다. 의미 손실 가능성이 있으면 `KEEP` 처리한다.
- **메모리 파일 직접 fs 수정 금지** — 항상 forget/remember 도구 경유 (memory layer 가 인덱스/포맷 일관성 책임).

## 트리거 예시

- "메모리 관리해줘"
- "기존 메모리 정리하고 싶어"
- "중복된 기억들 합쳐줘"
- "오래된 PR 번호 박힌 메모리들 정리"
- "혹시 토큰 새서 들어간 메모리 있는지 확인해서 정리"
- "/memory-manage"
