---
name: gh-attach
description: "이슈·PR·코멘트에 로컬 이미지/영상을 첨부하거나(gh --attach), GitHub user-attachments 업로드 URL만 얻을 때(gh attach 확장) 사용한다."
compatibility: "Native --attach requires gh >= 2.99.0 and push access to the repo. The sudosubin/gh-attach extension additionally requires a GitHub browser session/cookies."
---

# gh-attach

로컬 이미지/영상을 GitHub에 올리는 두 가지 경로를 다룬다. 목적에 따라 갈린다.

| 목적 | 사용할 것 | 결과물 |
| --- | --- | --- |
| 이슈/PR/코멘트에 붙인다 | 네이티브 `--attach` (gh ≥ 2.99.0) | 본문에 인라인 렌더 |
| URL 문자열 자체가 필요하다 (Slack, 리포트, 리뷰 문서 등) | `gh attach` 확장 | `https://github.com/user-attachments/assets/...` |

공식 레퍼런스:

- 네이티브 첨부 문서: https://docs.github.com/en/github-cli/github-cli/attaching-files-with-github-cli
- 릴리스 노트 v2.99.0: https://github.com/cli/cli/releases/tag/v2.99.0
- Changelog: https://github.blog/changelog/2026-09-01-github-cli-media-in-issues-pull-requests-and-comments/
- 확장 README: https://github.com/sudosubin/gh-attach

## 핵심 원칙

- 사용자가 명시적으로 첨부를 요청했거나, 요청한 GitHub 작업에 명백히 필요한 파일만 올린다.
- 시크릿, 자격증명, 개인키, DB 덤프, 토큰이 섞인 로그, 내용을 모르는 파일은 절대 올리지 않는다.
- 이슈/PR 본문에 넣을 거면 확장 대신 네이티브 `--attach`를 쓴다. 업로드와 본문 작성이 한 번에 끝난다.
- 대상 저장소가 애매하고 현재 디렉터리가 의도한 repo가 아니면, 업로드 전에 `OWNER/REPO`를 확인한다.

## 경로 A: 네이티브 `--attach` (권장)

### 지원 명령

`gh issue create`, `gh issue edit`, `gh issue comment`, `gh pr create`, `gh pr edit`, `gh pr comment`.

repo에 push 권한이 필요하다. 이미지·미디어 파일만 올라간다.

### 버전 확인

```bash
gh --version
gh pr comment --help | rg -- '--attach' || echo "gh 업데이트 필요 (>= 2.99.0)"
```

2.99.0 미만이면 `brew upgrade gh`로 올린 뒤 진행한다. 버전이 낮은 상태로 경로 B에 우회하지 말고, 업그레이드가 곤란한 사정이 있으면 사용자에게 알린다.

### 기본 사용

```bash
gh pr comment 123 --attach ./screenshot.png
```

`--attach`는 반복 가능하다. 명령당 최대 50개, 같은 파일을 두 번 붙일 수는 없다.

```bash
gh pr create \
  --title "결제 실패 화면 수정" \
  --body-file ./pr-body.md \
  --attach ./before.png \
  --attach ./after.png
```

### 본문 인라인 참조

본문이 이미 로컬 경로를 참조하면 `gh`가 그 자리에서 업로드 URL로 치환한다. 참조되지 않은 첨부는 본문 끝에 플래그 순서대로 덧붙는다. 로컬에서 렌더링을 확인한 마크다운을 그대로 올릴 수 있다는 뜻이라, 리포트성 PR 본문에 특히 잘 맞는다.

`pr-body.md`:

```markdown
로그인 화면에서 폼 자리에 에러가 뜬다:

![로그인 인증 에러 화면](./login-error.png)
```

```bash
gh issue comment 456 --body-file ./pr-body.md --attach ./login-error.png
```

치환 규칙은 `--body`, `--body-file`, stdin, 에디터 입력 모두에 동일하게 적용된다.

### alt 텍스트

경로 뒤에 `#`로 붙인다. 생략하면 파일명이 alt로 들어간다.

```bash
gh issue comment 456 --attach './login.png#로그인 에러 상태'
```

본문 마크다운이 이미 참조하는 파일은 마크다운 쪽 alt를 유지한다. 즉 `#` alt는 본문 끝에 append되는 파일에만 적용된다. 영상에는 alt를 쓸 수 없다.

### 영상 임베드

플레이어로 렌더하려면 참조가 해당 문단의 유일한 내용이어야 한다.

```markdown
![](./walkthrough.mp4)
```

문장 중간에 있으면 플레이어가 아니라 링크로 렌더된다.

### 제약

- `--web`과 함께 쓸 수 없다.
- 이미지·미디어 외 파일 타입은 지원하지 않는다.
- `gh issue edit` / `gh pr edit`에서 `--attach`만 주면 기존 본문을 유지한 채 아래에 덧붙인다.

## 경로 B: `gh attach` 확장 (URL만 필요할 때)

이슈/PR 본문이 아니라 URL 문자열 자체가 필요한 경우에만 쓴다. Slack 공유, 외부 리포트, PR 본문을 여러 단계에 걸쳐 조립하는 경우 등이다.

```bash
gh extension list | rg '^gh attach\s' || gh extension install sudosubin/gh-attach
gh auth status
```

```bash
gh attach ./image.png -R owner/repo
gh attach ./image.png -R owner/repo --json href,name
gh attach ./image.png -R owner/repo --json href,name --template '![{{.name}}]({{.href}})'
```

의도한 repo 안에서 실행하면 `-R`을 생략하고 자동 감지에 맡겨도 된다.

### 브라우저 쿠키 옵션

확장은 `gh` 로그인 계정과 일치하는 브라우저 쿠키를 사용한다. 쿠키를 못 찾거나 다른 계정 세션이 잡히면 브라우저/프로필을 명시한다.

```bash
gh attach ./image.png -R owner/repo --browser chrome --profile Default
```

지원 값은 `gh attach --help` 참고 (`auto`, `arc`, `brave`, `chrome`, `chromium`, `edge`, `firefox`, `safari`, `vivaldi`, `whale` 등).

반복 사용 시 `~/.config/gh/attach.yml`:

```yaml
browsers:
  - browser: chrome
    profile: Default
  - browser: safari
```

## 트러블슈팅

- `unknown flag: --attach`: `gh` 버전이 2.99.0 미만. `brew upgrade gh`.
- `--attach`인데 권한 오류: 대상 repo에 push 권한이 필요하다.
- 같은 파일을 두 번 첨부: 허용되지 않는다. 본문에서 한 번만 참조하도록 정리한다.
- 확장에서 `unknown command attach`: `gh extension install sudosubin/gh-attach`.
- 확장 쿠키/세션 불일치: `--browser`, `--profile` 명시. `gh auth status` 계정과 브라우저 로그인 계정이 같은지 확인.
- `not logged in`: `gh auth login`.
- 상세 로그: 확장은 `-v`.

## 업로드 전 체크리스트

- 사용자가 이 첨부를 명시적으로 요청했거나 요청한 GitHub 작업에 직접 필요하다.
- 파일 경로가 정확하고 파일이 존재한다.
- 공개 또는 대상 GitHub 컨텍스트에 올려도 안전한 내용이다.
- 대상 저장소가 정확하다.

## Test prompts

트리거되어야 하는 프롬프트:

- `이 스크린샷 PR 코멘트에 붙여줘`
- `gh attach로 이 이미지 GitHub URL 만들어줘: /tmp/a.png -R my-org/my-repo`
- `PR 본문에 before/after 이미지 넣어서 만들어줘`
- `gh-attach가 쿠키를 못 찾는다고 하는데 해결해줘`

자동 업로드하면 안 되는 프롬프트:

- `GitHub Actions artifact 다운로드해줘`
- `이미지를 S3에 업로드해줘`
- 명확한 GitHub 첨부 요청과 안전성 확인 없는 `이 로그 파일을 어디든 올려줘`

## Validation

스킬 수정 후:

```bash
python3 ~/.pi/agent/skills/skill-creator/scripts/validate_skill.py ~/.pi/agent/skills/gh-attach
```
