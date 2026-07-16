---
name: pickle
description: 코딩·조사 작업을 별도 Picky Pickle에 위임할 때 사용한다. worktree 준비, 지침 작성, Pickle 생성·후속 관리를 수행한다.
---

# Pickle

Picky Pickle에 작업을 안전하게 위임하는 상위 workflow다. 저수준 명령 사용법보다 작업공간 격리, 명확한 handoff, 생성 결과 확인과 후속 제어에 집중한다.

## 적용 범위

다음 요청에 사용한다.

- “피클에 위임해”, “새 Pickle 만들어줘”
- “새 worktree를 만들고 피클에 맡겨줘”
- “핫픽스/기능 작업을 피클로 진행해”
- “각 작업을 별도 피클로 만들고 그룹에 넣어줘”
- 기존 Pickle에 정정 지시를 보내거나 중단·보관·복원해 달라는 요청

다음에는 사용하지 않는다.

- 메인 Picky 세션에 텍스트를 보내는 `picky submit`
- Picky push-to-talk 조작
- 일반 파일·셸 작업을 현재 세션에서 직접 수행하는 요청

이 경우에는 `picky-cli` 등 해당 작업에 맞는 지침을 사용한다.

## Workflow

### 1. CLI와 요청 범위 확인

1. `command -v picky`로 CLI 설치 여부를 확인한다.
2. 현재 명령 표면이 필요하면 `picky --help`와 해당 하위 명령의 `--help`를 확인한다.
3. 사용자 요청에서 다음을 추출한다.
   - 작업 목표와 완료 조건
   - 대상 repo와 workspace
   - hotfix인지 일반 개발인지
   - 커밋, push, PR 생성 범위
   - 단일 작업인지 병렬 fan-out인지
   - dock group 지정 여부
4. workspace, base branch, 전달 범위가 결과를 바꿀 정도로 불명확할 때만 사용자에게 확인한다.

### 2. 작업공간 준비

사용자가 새 worktree를 요청하면 Pickle 생성 전에 준비한다.

- Creatrip Product hotfix: repo 지침에 따라 production 기반 `gwp <slug>`를 사용한다.
- Creatrip Product 일반 수정·기능: development 기반 `gwd <slug>`를 사용한다.
- 다른 repo: 해당 repo의 로컬 지침과 worktree 도구를 따른다.
- 생성 후 실제 경로, branch, base와 `git status --short --branch`를 확인한다.
- 사용자가 현재 workspace 사용이나 빈 Pickle만 요청했다면 불필요한 worktree를 만들지 않는다.

동시에 실행되는 Pickle끼리 같은 writable worktree를 공유하지 않는다. 기존 미커밋 변경을 보호하며 `reset --hard`, 임시 stash, 강제 정리로 덮어쓰지 않는다.

### 3. Self-contained handoff 작성

Pickle이 현재 대화를 보지 않아도 수행할 수 있도록 지침을 작성한다. 긴 지침은 `${TMPDIR:-/tmp}` 아래 Markdown 파일로 만든 뒤 내용을 `--instructions`에 전달해 shell quoting 손상을 줄인다.

지침에는 필요한 항목만 포함한다.

1. 목표와 사용자 의도
2. workspace 경로, branch, base
3. 조사 근거와 재현 정보
4. 수정·조사 범위와 우선순위
5. 하지 말아야 할 일과 범위 밖 항목
6. 읽어야 할 repo 지침과 참고 파일
7. 필수 검증 명령과 기대 결과
8. 커밋, push, PR 생성 여부
9. 최종 보고에 포함할 내용

경로·브랜치·PR 정책처럼 중요한 값은 자연어에 묻어 두지 말고 별도 항목으로 명시한다. 지침이 깨졌거나 핵심 조건이 빠진 상태로 생성한 뒤 follow-up으로 보정하는 것보다, 생성 전에 handoff를 완성하는 것을 우선한다.

### 4. Pickle 생성

일반적인 코딩·조사 위임은 다음 형태를 사용한다.

```bash
picky pickle-create "<title>" \
  --cwd "<workspace>" \
  --instructions "$(cat "<handoff-file>")" \
  --no-context \
  --json
```

선택 규칙:

- `--cwd`: 항상 명시한다.
- `--instructions`: 빈 Pickle이 아니면 항상 구체적으로 제공한다.
- `--no-context`: handoff가 self-contained인 코딩·조사 위임의 기본값이다. 사용자가 현재 화면 맥락 전달을 원할 때만 생략한다.
- `--json`: 생성된 session ID를 정확히 확인하기 위해 사용한다.
- `--group <name>`: 사용자가 그룹을 지정했거나 여러 독립 작업을 fan-out할 때 사용한다.
- `--empty`: 사용자가 명시적으로 빈 Pickle을 요청했을 때만 사용한다.

여러 작업을 위임할 때는 작업별 독립 worktree와 handoff를 만든다. 자연스럽게 같은 작업군일 때만 동일 group을 사용하고, 억지로 서로 다른 작업을 묶지 않는다.

### 5. 생성 결과 확인과 보고

1. JSON 응답에서 session ID와 생성 성공 여부를 확인한다.
2. 응답이 불명확할 때만 `picky pickle-list --json --query "<id-or-title>"`로 한 번 확인한다.
3. 다음 항목을 간결하게 보고한다.
   - title과 session ID
   - workspace와 branch/base
   - group
   - handoff 요약 또는 파일 경로
   - 위임 범위(커밋/push/PR)

## Safety checklist

완료 전에 확인한다.

- 사용자가 Pickle 위임 또는 제어를 명시적으로 요청했는가
- Pickle의 `cwd`가 의도한 workspace와 일치하는가
- branch/base와 hotfix 여부가 지침에 명시됐는가
- 서로 다른 Pickle이 같은 writable worktree를 공유하지 않는가
- 커밋, push, PR 범위를 임의로 확대하지 않았는가
- 생성 응답에서 정확한 session ID를 확인했는가
- 메인 세션용 `picky submit`을 실수로 사용하지 않았는가
