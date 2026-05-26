---
name: cleanup-remote-merged-branches
description: 원격(origin 등)에 남아 있는 자동 생성 prefix 브랜치(sync/, dependabot/, renovate/, release/, snyk/ 등) 중 base 브랜치(development/main/production)에 이미 머지된 것을 일괄 정리한다. 사용자가 "원격 sync/ 브랜치 정리", "origin sync/ 머지된 거 다 지워", "dependabot 브랜치 청소", "development에 merged된 원격 브랜치 삭제", "auto-sync PR 브랜치 일괄 삭제"처럼 말하면 사용한다. fetch --prune → 패턴 매칭 → merged 필터 → 메타 표 출력 → 사용자 승인 → `git push <remote> --delete` 일괄 삭제까지 수행하며, 보호 브랜치(production/development/main 등)는 절대 후보에 포함하지 않는다.
disable-model-invocation: false
---

# cleanup-remote-merged-branches

원격 저장소(`origin` 등)에 누적된 자동 생성 prefix 브랜치를 안전하게 일괄 삭제하기 위한 스킬이다. 자동화 봇(GitHub Actions sync PR, Dependabot, Renovate, release-please 등)이 만들어 두고 청소되지 않은 브랜치가 주 대상이다.

## 핵심 원칙

- **읽기 → 보고 → 승인 → 삭제**: 무조건 fetch + 후보 나열 + 메타 정보 보고 + 사용자 승인 후에만 삭제한다.
- **삭제는 단 한 번의 일괄 push**: 후보가 확정되면 `git push <remote> --delete <b1> <b2> ...` 한 번으로 끝낸다. 루프 안에서 한 건씩 push하지 않는다(불필요하게 hook이 여러 번 돈다).
- **머지 검증 필수**: prefix 매칭만으로 삭제하지 않는다. 반드시 `git branch -r --merged <remote>/<base>` 결과와 교집합을 본다.
- **보호 브랜치 절대 포함 금지**: `<remote>/HEAD`, `production`, `development`, `main`, `master`, `staging`, `release`(prefix가 아닌 정확히 이 이름)은 후보에서 제외한다.
- **삭제 후 검증**: 삭제 push 결과를 확인하고, `git branch -r --list '<remote>/<prefix>*'`로 잔여 0 또는 비머지 잔여만 남았는지 보고한다.
- **놀라움 금지**: 사용자가 prefix를 명시하지 않았는데 임의 prefix(예: `feature/`, `feat/`)를 추론해서 지우지 않는다. 사람이 만든 작업 브랜치는 별도 워크플로우(`gw-worktree-cleanup` 등)로 다룬다.

## 사용 도구

- `bash`: `git fetch`, `git branch -r`, `git log`, `git push --delete`
- `ask_user_question`: prefix/base/remote가 모호하거나, 머지되지 않은 후보가 섞여 있어 사용자 결정이 필요할 때
- `todo_write`: 후보 수가 많고 단계 진행 상태를 보여주고 싶을 때(선택)

## Workflow

### 1. 입력 파싱

사용자 발화에서 다음을 추출한다.

- `prefix`: 필수. 예 `sync/`, `dependabot/`, `renovate/`, `release/`, `snyk/`. 슬래시 포함 형태로 정규화한다.
- `remote`: 기본 `origin`. "upstream에서", "fork origin에서"처럼 명시되면 그 값을 사용한다.
- `base`: 머지 기준 브랜치. 자동 추론 규칙:
  - prefix가 `sync/production-to-development-*` → `development`
  - prefix가 `sync/development-to-*` → `*` 부분
  - prefix가 `dependabot/`, `renovate/`, `snyk/` → 사용자에게 묻지 않고 기본 `development`(이 레포 컨벤션). 다른 레포면 `main` 또는 사용자가 말한 base.
  - 그 외 prefix → `ask_user_question`으로 base 확인.

prefix가 없거나 너무 광범위(`feat/`, `feature/`, 빈 문자열)이면 진행하지 말고 `ask_user_question`으로 확인한다.

### 2. fetch + prune

```bash
git fetch <remote> --prune
```

`--prune`이 중요하다. 원격에서 이미 사라진 브랜치가 로컬 ref에 남아 있으면 후보 목록이 부정확해진다.

### 3. 후보 산출

```bash
# 패턴 매칭 전체
git branch -r --list '<remote>/<prefix>*'

# base에 머지된 것만
git branch -r --merged <remote>/<base> --list '<remote>/<prefix>*'
```

두 결과의 차집합(매칭됐지만 머지되지 않은 브랜치)도 확보해 따로 보고한다. 이 항목은 자동 삭제하지 않는다.

보호 브랜치 필터링: 결과에서 `<remote>/HEAD`, `<remote>/production`, `<remote>/development`, `<remote>/main`, `<remote>/master`를 제거한다(prefix 매칭상 들어올 일은 거의 없지만 방어적으로).

### 4. 메타 정보 보고

각 후보 브랜치마다 SHA(앞 10자), 마지막 커밋 일자, subject를 함께 표로 보여준다. 표가 너무 길면(>30개) 처음 5/마지막 5만 보여주고 합계와 함께 "전체 N개"로 명시한다.

```bash
for b in $(git branch -r --merged <remote>/<base> --list '<remote>/<prefix>*' | sed 's|^[ *]*||'); do
  sha=$(git rev-parse "$b")
  date=$(git log -1 --format='%ci' "$b")
  subj=$(git log -1 --format='%s' "$b")
  printf '%s | %s | %s | %s\n' "${b#<remote>/}" "${sha:0:10}" "$date" "$subj"
done
```

보고 형식 예:

```markdown
원격 `origin`의 `sync/` 접두 브랜치 N개 모두 `origin/development`에 머지된 상태입니다.

| # | Branch | SHA | Date (UTC) | Subject |
|---|---|---|---|---|
| 1 | sync/... | abc1234567 | 2026-05-06 09:58 | Merge branch ... |
...

머지 안 된 후보(자동 삭제 제외): none
```

### 5. 승인 게이트

- 사용자가 같은 턴에 이미 "다 지워줘"처럼 명시 승인을 한 상태면 다음 단계로 진행한다.
- 그렇지 않으면 표를 보여주고 한 줄로 묻는다: "원격에서 일괄 삭제할까요? (`git push <remote> --delete ...` 한 번에 처리)" 또는 옵션이 분기되면 `ask_user_question`을 사용한다.
- 머지되지 않은 항목이 섞여 있으면 반드시 `ask_user_question`으로 처리 방식을 묻는다(머지된 것만 / 전부 / 취소).

### 6. 일괄 삭제

승인되면 단 한 번의 push로 처리한다.

```bash
git push <remote> --delete \
  <branch-1> \
  <branch-2> \
  ...
```

배치 분할 기준: 한 번에 100개 초과하면 50개 단위로 나눈다(서버 측 거부/타임아웃 방지). 그 이하면 무조건 한 번에 보낸다.

### 7. 사후 검증

```bash
git branch -r --list '<remote>/<prefix>*' | wc -l
```

- 0이면 깨끗이 정리된 것으로 보고한다.
- 잔여가 있다면 그것은 4단계의 "머지되지 않은" 항목과 일치해야 한다. 일치하지 않으면 원인(권한/보호 브랜치/충돌)을 조사 보고한다.

최종 응답은 다음을 포함한다.

- 삭제한 브랜치 수와 prefix/remote/base
- 잔여 0 또는 잔여 목록
- (선택) 다음 정리 시점에 자동화하고 싶다면 GitHub Actions/`gh api repos/:owner/:repo/branches`로 옮길 수 있음을 한 줄 안내

## Tool guidance

- `bash`로 git 명령을 실행한다. `read`/`edit`은 이 스킬에선 거의 쓰지 않는다.
- 한 번에 보고할 메타 정보 산출은 위의 for 루프 한 덩어리로 묶어 한 번의 bash 호출로 끝낸다.
- 일괄 삭제 명령은 가독성을 위해 백슬래시 줄바꿈 형태로 작성하되, 단일 `git push` 호출이어야 한다.
- pre-push hook(lefthook 등)이 있는 레포라면 hook 출력이 결과에 섞여 나온다. 이는 정상이며 마지막의 `[deleted] <branch>` 라인을 검증 근거로 본다.

## Output format

```markdown
완료: origin의 `sync/` 브랜치 22개 삭제
- prefix: `sync/`, remote: `origin`, base: `development`
- 머지 검증: `git branch -r --merged origin/development` 기준
- 잔여: 0개 (또는 비머지 N개 — 목록)
```

## Validation checklist

완료 전 확인:

- [ ] `git fetch <remote> --prune`을 먼저 실행했다.
- [ ] prefix 매칭과 머지 검증을 모두 통과한 항목만 삭제 후보에 넣었다.
- [ ] 보호 브랜치(production/development/main/master 등)를 후보에서 제외했다.
- [ ] 사용자가 일괄 삭제를 명시 승인했다(같은 턴 직전 발화 또는 `ask_user_question` 응답).
- [ ] 단일 `git push <remote> --delete` 호출로 일괄 삭제했다(또는 50개 배치).
- [ ] 사후 `git branch -r --list` 잔여 카운트를 보고했다.

## Edge cases

- **후보 0개**: prefix 매칭 결과가 빈 경우, 그대로 "정리 대상 없음"으로 종료. 삭제 시도하지 않는다.
- **머지되지 않은 항목 혼재**: 자동 삭제 금지. 사용자가 "강제로 다 지워"라고 말해도, 그 항목은 이 스킬 범위가 아님을 안내하고 별도 확인을 받는다(`git push --delete`는 단지 ref 삭제이므로 데이터 손실은 즉시 일어나지 않지만, 검토 트레이스/PR이 깨질 수 있음).
- **로컬에 같은 이름 브랜치 존재**: 이 스킬은 원격만 다룬다. 로컬 정리는 `gw-worktree-cleanup` 스킬로 안내한다.
- **권한 부족**: `git push --delete` 실패 시 stderr에 `protected branch` 또는 `permission denied`가 보일 것이다. 실패 브랜치를 따로 보고하고 나머지는 그대로 둔다.
- **base가 origin에서 fast-forward되지 않은 상태**: fetch 직후이므로 일반적으로 문제 없으나, 사용자가 "fetch 없이 진행"을 요구하면 머지 검증 결과가 오래된 ref 기준일 수 있음을 한 줄 경고한다.
- **prefix가 광범위/모호**: `feat/`, `feature/`, `bugfix/` 같은 사람이 만드는 브랜치는 자동 후보에서 제외하고 `gw-worktree-cleanup` 또는 `gh pr list --state merged` 기반 워크플로우를 권한다.
- **사용자가 `git push --delete` 대신 `gh api`를 원함**: 권한/감사 로그가 다른 도구가 필요한 경우만 `gh api -X DELETE repos/:owner/:repo/git/refs/heads/<branch>`로 대체할 수 있다. 기본은 `git push --delete`.
