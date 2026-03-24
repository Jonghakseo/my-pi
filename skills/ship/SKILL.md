---
name: ship
description: "테스트→리뷰→커밋 정리→PR 생성을 자동화하는 출시 워크플로우. /ship 또는 '출시해줘', 'PR 만들어줘', '배포 준비해줘' 등으로 호출."
argument-hint: "ship | PR 만들어줘 | 출시해줘 | 배포 준비"
disable-model-invocation: false
---

# /ship — 출시 워크플로우

테스트 → Pre-Landing 리뷰 → 커밋 정리 → PR 생성까지 **자동 실행**한다.

사용자가 `/ship`을 말한 순간 = **"해줘"**. 불필요한 확인 없이 진행한다.

---

## 멈춰야 하는 경우 (이것만)

- base 브랜치 위에 있음 (abort)
- merge conflict 해소 불가 (stop, 충돌 표시)
- 테스트 실패 (stop, 실패 표시)
- Pre-Landing 리뷰에서 **ASK** 항목 존재 (사용자 판단 필요)
- gh CLI 미인증 (stop, 안내)

## 멈추지 않는 경우

- 미커밋 변경사항 (항상 포함)
- 커밋 메시지 확인 (자동 생성)
- PR 본문 확인 (자동 생성)
- 파일 수가 많음 (자동 분할)

---

## Step 0: Pre-flight

### 0-1. 브랜치 확인

```bash
CURRENT=$(git branch --show-current 2>/dev/null)
echo "BRANCH: $CURRENT"
```

base 브랜치 감지:

```bash
BASE=$(gh pr view --json baseRefName -q .baseRefName 2>/dev/null \
  || gh repo view --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null \
  || echo "main")
echo "BASE: $BASE"
```

**현재 브랜치 = base 브랜치이면 → STOP:**
> "base 브랜치 위에 있습니다. feature 브랜치에서 /ship을 실행하세요."

### 0-2. 변경사항 확인

```bash
git fetch origin "$BASE" --quiet
git diff "origin/$BASE" --stat
git log "origin/$BASE..HEAD" --oneline
```

diff가 비어 있으면 → STOP:
> "origin/$BASE 대비 변경사항이 없습니다."

### 0-3. gh CLI 확인

```bash
gh auth status 2>&1 | head -3
```

인증되지 않았으면 → STOP:
> "gh CLI 인증이 필요합니다. `gh auth login`을 먼저 실행하세요."

---

## Step 1: Base 브랜치 머지

최신 base를 머지하여 테스트가 최신 상태에서 실행되도록 한다.

```bash
git fetch origin "$BASE" && git merge "origin/$BASE" --no-edit
```

- merge conflict 발생 시: 단순한 것(VERSION, CHANGELOG 순서)은 자동 해소 시도. 복잡한 충돌이면 **STOP**하고 충돌 내용을 표시.
- 이미 최신이면: 조용히 진행.

---

## Step 2: 테스트 실행

### 2-1. 테스트 명령 감지

프로젝트의 테스트 명령을 자동 감지한다. **아래 순서**로 확인하고 첫 번째 매칭을 사용:

1. `package.json`의 `scripts.test` → `npm test` / `pnpm test` / `bun run test` (lock 파일로 판단)
2. `Makefile`에 `test` 타겟 → `make test`
3. `Cargo.toml` 존재 → `cargo test`
4. `go.mod` 존재 → `go test ./...`
5. `pytest.ini` / `pyproject.toml`의 `[tool.pytest]` → `pytest`
6. 감지 실패 → AskUserQuestion으로 직접 입력 받기

### 2-2. 테스트 실행

```bash
set -o pipefail
<감지된 테스트 명령> 2>&1 | tee /tmp/ship-test-output.txt
TEST_EXIT=$?
echo "EXIT_CODE: $TEST_EXIT"
```

`pipefail`을 설정하여 `tee`가 아닌 **테스트 명령의 exit code**를 사용한다.

- **`TEST_EXIT` ≠ 0 → STOP.** 실패 내용을 표시하고 종료.
- **`TEST_EXIT` = 0 →** 테스트 출력에서 실행된 테스트 수를 추출한다.

### 2-3. Zero-Test Guard

테스트 출력에서 실행된 테스트 수를 확인한다. 출력에 `0 tests`, `0 passing`, `0 specs`, `no tests found` 등의 패턴이 보이면 AskUserQuestion:

> ⚠️ 테스트가 0건 실행되었습니다. 테스트 명령이 올바른가요?
> 감지된 명령: `{테스트 명령}`
>
> A) 맞음 — 이 프로젝트에 테스트가 아직 없음 (계속 진행)
> B) 잘못됨 — 다른 테스트 명령 입력
> C) 중단

B 선택 시 → 사용자가 입력한 명령으로 Step 2-2부터 재실행.
C 선택 시 → STOP.

**monorepo 참고**: root에 단일 테스트 명령이 없는 monorepo의 경우, 감지 실패 → AskUserQuestion 경로를 통해 사용자가 올바른 명령(예: `pnpm -r test`, `nx affected:test`)을 직접 지정할 수 있다.

---

## Step 3: Pre-Landing 리뷰

diff를 대상으로 **2-Pass 구조화 리뷰**를 직접 수행한다.

### 3-0. Scope Check (범위 점검)

```bash
git log "origin/$BASE..HEAD" --oneline
git diff "origin/$BASE" --stat
```

커밋 메시지에서 **의도(intent)**를 추출하고, diff의 **실제 변경**과 비교:

- 의도에 없는 파일 변경 → `⚠️ SCOPE CREEP` 경고
- 의도에 있지만 변경 없는 항목 → `⚠️ MISSING` 경고

```
Scope Check: [CLEAN / DRIFT DETECTED]
Intent: <커밋 메시지 기반 1줄 요약>
Delivered: <diff 기반 1줄 요약>
```

이 결과는 **정보 제공만** — 블로킹하지 않는다.

### 3-1. diff 수집

```bash
git diff "origin/$BASE"
```

### 3-2. Pass 1 — Critical (반드시 확인)

| 카테고리 | 확인 항목 |
|---------|---------|
| **SQL & 데이터 안전** | 사용자 입력이 쿼리에 직접 삽입되는가? raw SQL에 변수 보간이 있는가? |
| **인증/인가** | 보호되어야 할 엔드포인트가 미들웨어 없이 노출되는가? |
| **레이스 컨디션** | 동시 접근 시 데이터 무결성이 보장되는가? 낙관적 잠금이 필요한가? |
| **비밀값 노출** | API 키, 토큰, 비밀번호가 코드에 하드코딩되는가? |
| **LLM 신뢰 경계** | AI 생성 출력이 검증 없이 DB/시스템에 삽입되는가? |

### 3-3. Pass 2 — Informational (품질 개선)

| 카테고리 | 확인 항목 |
|---------|---------|
| **Dead Code** | 사용되지 않는 import, 함수, 변수가 추가되는가? |
| **Magic Numbers** | 설명 없는 숫자/문자열 상수가 있는가? |
| **테스트 갭** | 새 코드 경로에 대응하는 테스트가 있는가? |
| **성능** | N+1 쿼리, 불필요한 루프, 거대한 번들 임포트가 있는가? |
| **일관성** | 기존 코드베이스의 패턴/네이밍과 불일치하는가? |

### 3-4. Fix-First 분류

발견한 각 이슈를 분류:

- **AUTO_FIX**: 기계적으로 수정 가능 (dead import 제거, 명확한 타입 오류, unused variable)
  → 즉시 수정. 한 줄 로그: `[AUTO-FIXED] [file:line] 문제 → 수정 내용`
- **ASK**: 판단이 필요 (아키텍처 변경, 비즈니스 로직, 보안 관련)
  → AskUserQuestion으로 묶어서 질문
- **INFO**: 수정 불필요 또는 별도 추적 (기존 코드 문제, 대규모 변경 필요)
  → 보고서에 기록만. 자동 수정하지 않음.

### 3-5. ASK 항목 처리

ASK 항목이 있으면 **하나의 AskUserQuestion**으로 묶어서 제시:

```
Pre-Landing 리뷰: N개 이슈 (X critical, Y informational)
M개 자동 수정 완료. K개 판단 필요:

1. [CRITICAL] file.ts:42 — 레이스 컨디션 가능성
   수정안: WHERE status = 'draft' 추가
   → A) 수정  B) 건너뛰기

2. [INFO] service.ts:88 — LLM 출력 미검증
   수정안: JSON 스키마 검증 추가
   → A) 수정  B) 건너뛰기

RECOMMENDATION: 모두 수정 권장
```

3개 이하면 개별 질문도 허용.

### 3-6. 수정 후 재검증

수정 사항이 있으면:

```bash
<테스트 명령> 2>&1
echo "EXIT_CODE: $?"
```

테스트 실패 시 → 수정을 revert하고 **STOP**.
테스트 통과 시 → 진행.

이슈가 없으면: `Pre-Landing Review: No issues found.` 출력 후 진행.

---

## Step 4: 커밋 정리 (Bisectable)

### 4-1. 변경사항 분석

```bash
git status
git diff --cached --stat
git diff --stat
```

### 4-2. 논리적 커밋 분할

변경사항을 논리적 단위로 묶는다. 각 커밋은 **독립적으로 유효**해야 한다:

**커밋 순서** (의존성 순):
1. **인프라**: 마이그레이션, 설정 변경, 라우트 추가
2. **핵심 로직**: 모델, 서비스, 유틸리티 (+ 관련 테스트)
3. **인터페이스**: 컨트롤러, 뷰, 컴포넌트 (+ 관련 테스트)
4. **문서/설정**: README, CHANGELOG, VERSION 등

**분할 규칙**:
- 모델과 그 테스트는 **같은 커밋**
- 서비스와 그 테스트는 **같은 커밋**
- 총 diff가 작으면 (< 50줄, < 4파일) **단일 커밋**으로 충분
- 다음 커밋이 이전 커밋에 없는 코드를 참조하면 안 됨

### 4-3. 커밋 메시지

```
<type>: <한 줄 요약>

<선택: 1-2줄 설명>
```

type: `feat` / `fix` / `chore` / `refactor` / `docs` / `test` / `style`

미커밋 + staged + unstaged 모두 포함하여 정리한다.

---

## Step 5: Push + PR 생성

### 5-1. Push

```bash
git push -u origin "$(git branch --show-current)"
```

**절대 force push 하지 않는다.**

### 5-2. PR 생성

```bash
gh pr create \
  --base "$BASE" \
  --title "<type>: <한 줄 요약>" \
  --body "$(cat <<'PRBODY'
## Summary
<CHANGELOG 스타일 bullet points — 사용자가 무엇을 할 수 있게 되었는지>

## Pre-Landing Review
<Step 3 결과: N issues, M auto-fixed, K asked 또는 "No issues found.">

## Scope Check
<Step 3-0 결과 또는 "CLEAN">

## Test Results
- [x] 테스트 통과 (N tests, 0 failures)

🤖 Generated with pi + /ship
PRBODY
)"
```

### 5-3. 결과 출력

PR URL을 출력하고 완료:

```
✅ Shipped!
   PR: <URL>
   Branch: <feature> → <base>
   Commits: <N>
   Review: <이슈 수 요약>
```

---

## 전체 흐름 요약

```
/ship
  │
  ├─ Step 0: Pre-flight (브랜치, diff, gh 확인)
  │    └─ abort 조건 확인
  │
  ├─ Step 1: Base 머지
  │    └─ conflict → STOP
  │
  ├─ Step 2: 테스트 실행
  │    └─ fail → STOP
  │
  ├─ Step 3: Pre-Landing 리뷰
  │    ├─ Scope Check (정보 제공)
  │    ├─ Pass 1: Critical
  │    ├─ Pass 2: Informational
  │    ├─ AUTO_FIX 즉시 적용
  │    ├─ ASK 항목 → 사용자 판단
  │    └─ 수정 시 → 테스트 재실행
  │
  ├─ Step 4: 커밋 정리 (bisectable)
  │
  └─ Step 5: Push + PR
       └─ ✅ PR URL 출력
```

---

## 주의 사항

- **테스트를 절대 건너뛰지 않는다.** 실패하면 멈춘다.
- **force push 하지 않는다.** `git push`만 사용.
- **사소한 확인을 요청하지 않는다.** ("push 할까요?" 금지)
- **리뷰 수정 후 반드시 테스트를 재실행한다.** 이전 결과는 무효.
- **커밋은 각각 독립적으로 유효해야 한다.** 깨진 중간 커밋 금지.
- **PR body는 자동 생성한다.** 사용자에게 설명을 요청하지 않는다 — diff와 커밋에서 추론.
