---
name: ship
description: "변경사항을 remote에 올리기 전에 의도 단위 커밋 정리, 사전 검증, push가 필요할 때 사용."
argument-hint: "ship | ship <branch-name> | 커밋해서 푸시해줘 | 올리기 전에 검증해줘 | push 준비해줘"
disable-model-invocation: false
---

# /ship — 커밋 정리 + 검증 + push

핵심은 3가지다.

1. 변경사항을 **의도 단위로 분리해 커밋**한다.
2. push 전에 **typecheck / lint / test / build**를 가능한 범위에서 모두 검증한다.
3. 검증이 통과하면 **push**한다.

기본 동작은 **commit + verify + push**다.
PR 생성은 **조건부 후처리**다.

## PR 관련 기본 규칙

- 이미 열린 PR이 있으면 **생성하지 않고 스킵**한다.
- **PR 템플릿이 있으면 사용**한다.
- **PR 생성 전용 스킬이 있으면 우선 사용**한다.
- GitHub 연동은 가능하면 **`gh api`를 우선 사용**한다.
- 전용 스킬이 없을 때만 필요에 따라 `gh api` 또는 `gh pr create`를 사용한다.

---

## 멈춰야 하는 경우

- 의도 단위로 나눠도 **독립적으로 유효한 커밋**을 만들 수 없음
- merge conflict 해소 불가
- 필수 검증(typecheck / lint / test / build) 실패
- push 권한/인증 문제
- 사용자 판단이 필요한 위험한 선택이 남아 있음

## 멈추지 않는 경우

- 미커밋 변경사항
- staged + unstaged 혼재
- 파일 수가 많음
- root 명령이 없는 monorepo
- base 브랜치 위에 있음
- 이미 PR이 열려 있음 (PR 생성만 스킵)

## 확인이 필요한 경우

- 검증 명령 자동 감지 실패
- 어떤 검증이 필수인지 불명확함

---

## Step 0: Pre-flight

### 브랜치 확인

`/ship`은 **브랜치 이름 인자를 옵션으로 받을 수 있다.**

- 인자가 있으면: 그 브랜치로 checkout/switch 해서 진행한다.
  - 없으면 새 브랜치를 만든다.
  - 있으면 그 브랜치를 그대로 사용한다.
- 인자가 없으면: **현재 브랜치에서 그대로** commit + push 한다.
- 현재 브랜치가 `main`/base여도 **묻지 않는다.** 그대로 진행한다.

```bash
TARGET_BRANCH="$ARGUMENTS"
CURRENT=$(git branch --show-current 2>/dev/null)
BASE=$(git remote show origin 2>/dev/null | sed -n '/HEAD branch/s/.*: //p' | head -1)
[ -n "$BASE" ] || BASE=main

if [ -n "$TARGET_BRANCH" ]; then
  if git show-ref --verify --quiet "refs/heads/$TARGET_BRANCH"; then
    git switch "$TARGET_BRANCH"
  else
    git switch -c "$TARGET_BRANCH"
  fi
fi

CURRENT=$(git branch --show-current 2>/dev/null)
echo "BRANCH: $CURRENT"
echo "BASE: $BASE"
```

### 변경사항 / remote 확인

```bash
git status --short
git diff --stat
git diff --cached --stat
git remote -v
```

변경사항이 없거나 push 대상 remote가 불명확하면 중단한다.

---

## Step 1: 의도 분석 + 커밋 계획

```bash
git status
git diff --cached
git diff
git log --oneline -5
```

변경사항을 파일이 아니라 **의도 기준**으로 나눈다.
예: 의존성 업데이트 / 버그 수정 / 리팩터링 / 테스트 보강 / 문서 정리

### 커밋 원칙

- 각 커밋은 **독립적으로 이해 가능**해야 한다.
- 각 커밋은 **독립적으로 통과 가능**해야 한다.
- 코드와 관련 테스트는 가급적 같은 커밋에 넣는다.
- 리팩터링과 기능 변경은 가능하면 분리한다.
- 대규모 포맷 변경은 의미 있는 변경과 분리한다.

### 단일 커밋 허용

아래면 단일 커밋 허용:
- 변경이 작음
- 의도가 하나뿐임
- 분리하면 오히려 맥락이 깨짐

### 커밋 메시지

```text
<type>: <한 줄 요약>

<선택: 1-2줄 설명>
```

`feat` / `fix` / `chore` / `refactor` / `docs` / `test` / `style`

---

## Step 2: 검증 계획 수립

push 전에는 가능하면 아래를 모두 실행한다.

- **typecheck**
- **lint**
- **test**
- **build**

### 자동 감지 우선순위

#### Typecheck
1. `package.json`의 `scripts.typecheck`
2. `package.json`의 `scripts.check`
3. TypeScript 프로젝트면 `tsc --noEmit`
4. `Cargo.toml` → `cargo check`
5. 실패 시 AskUserQuestion

#### Lint
1. `package.json`의 `scripts.lint`
2. `Makefile`의 `lint`
3. `Cargo.toml` → `cargo clippy -- -D warnings`
4. 실패 시 AskUserQuestion

#### Test
1. `package.json`의 `scripts.test`
2. `Makefile`의 `test`
3. `Cargo.toml` → `cargo test`
4. `go.mod` → `go test ./...`
5. `pytest` 설정 존재 → `pytest`
6. 실패 시 AskUserQuestion

#### Build
1. `package.json`의 `scripts.build`
2. `Makefile`의 `build`
3. `Cargo.toml` → `cargo build`
4. 언어별 표준 빌드 명령
5. 실패 시 AskUserQuestion

### Guard

다음은 조용히 통과시키지 않는다.
- 테스트 0건 실행
- 타입체크가 사실상 noop
- 빌드가 사실상 noop

출력이 의심스러우면 계속/다른 명령/중단 중 하나를 AskUserQuestion으로 묻는다.

---

## Step 3: 검증 + 커밋 생성

권장 순서:

```text
typecheck → lint → test → build
```

원칙:
- 커밋이 1개면 전체 변경사항 기준으로 검증한다.
- 커밋이 여러 개면 최종 상태 전체 검증은 필수다.
- 중간 커밋이 깨질 수 있으면 그 커밋 전에도 필요한 검증을 한다.
- 자동 수정이 발생하면 관련 검증을 다시 실행한다.

### 실패 처리

하나라도 실패하면 중단한다.

```text
Ship blocked:
- failed check: <typecheck|lint|test|build>
- command: <실행한 명령>
- reason: <핵심 실패 요약>
```

### AUTO_FIX 허용 범위

허용:
- dead import 제거
- unused 정리
- 기계적 포맷 수정
- 명확한 타입 보강
- 사소한 lint autofix

금지:
- 비즈니스 로직 변경
- 보안 의미가 있는 수정
- 사용자 의도를 바꿀 수 있는 구조 변경
- 테스트 기대값을 논리 판단 없이 바꾸는 행위

---

## Step 4: 최종 검증

```bash
git status
git log --oneline --decorate -5
```

push 전 최종 게이트:
- 워킹트리 상태가 의도와 맞음
- 타입체크 성공
- 린트 성공
- 테스트 성공
- build가 있으면 빌드 성공

하나라도 아니면 중단한다.

---

## Step 5: Push

브랜치 인자를 받았다면 그 브랜치로 push한다. 없으면 현재 브랜치를 그대로 push한다.

```bash
git push -u origin "$(git branch --show-current)"
```

원칙:
- **force push 하지 않는다.**
- **`git commit --amend` 하지 않는다.** 필요하면 새 커밋으로 추가한다.
- push 전 마지막 확인은 묻지 않는다.

기본 결과:

```text
✅ Shipped!
   Branch: <current-branch>
   Commits: <N>
   Checks: typecheck / lint / test / build
   Push: success
```

---

## Step 6: 조건부 PR 생성

이 단계는 아래 경우에만 수행한다.
- 사용자가 PR 생성까지 명시적으로 요청함
- 프로젝트 규칙상 `/ship`에 PR 생성이 포함됨

### 기존 PR 확인

가능하면 `gh api`를 우선 사용한다.

```bash
gh api graphql -f query='query($owner:String!, $repo:String!, $headRefName:String!) { repository(owner:$owner, name:$repo) { pullRequests(states: OPEN, headRefName: $headRefName, first: 1) { nodes { url } } } }' -F owner='{owner}' -F repo='{repo}' -F headRefName='{branch}'
```

이미 PR이 있으면 `PR: skipped (already exists)` 로 기록한다.

### PR 생성 우선순위

1. PR 생성 전용 스킬
2. 저장소 PR 템플릿
3. `gh api`
4. 필요 시 `gh pr create`

PR까지 수행한 경우 결과에 아래를 추가한다.

```text
PR: <url | skipped (already exists)>
```

---

## Red Flags

- "일단 한 커밋으로 밀고 나중에 정리하자"
- "테스트만 통과하면 된다"
- "CI가 잡아주니 로컬 build는 안 해도 된다"
- "lint는 나중에 보자"
- "파일 기준으로만 나누면 된다"
- "main 브랜치면 무조건 물어봐야 한다"

---

## 주의 사항

- 핵심은 **PR이 아니라 commit + verify + push**다.
- 검증을 건너뛰지 않는다.
- 커밋은 각각 독립적으로 유효해야 한다.
- 최종 push 직전에는 검증 결과가 여전히 유효한지 확인한다.
- 모호하면 덜 하는 쪽이 아니라 더 검증하는 쪽을 택한다.
