---
name: gh-attach
description: "GitHub 이슈·PR·코멘트에 로컬 이미지·영상을 네이티브 --attach로 첨부하거나, 게시된 본문의 첨부 URL을 확인할 때 사용한다."
compatibility: "Requires GitHub CLI >= 2.99.0, GitHub.com authentication, and push access to the target repository."
---

# gh-attach

GitHub CLI의 `--attach`로 이미지·영상을 업로드하면서 이슈·PR·코멘트 본문에 반영한다. 별도 확장이나 브라우저 쿠키 없이 기존 `gh` 인증을 사용한다.

## 준비

```bash
gh --version
gh pr comment --help
gh auth status
```

- `gh >= 2.99.0`과 대상 저장소의 push 권한이 필요하다. 인증은 `gh auth login`의 OAuth 또는 classic PAT를 사용한다.
- `--attach`가 없는 버전이면 설치 방식에 맞춰 업데이트한다. 예전 확장 설치나 쿠키 추출로 우회하지 않는다.
- GitHub Enterprise Server는 지원하지 않는다.
- 사용자 요청의 대상과 첨부 파일을 확인한다. 내용을 모르는 파일, 토큰·PII·시크릿이 포함된 로그나 캡처는 올리지 않는다.
- 작업 디렉터리로 저장소를 명확히 식별할 수 없으면 `--repo OWNER/REPO`를 지정한다.

## 지원 명령

| 대상 | 명령 |
|---|---|
| 이슈 생성·본문 수정·코멘트 | `gh issue create`, `gh issue edit`, `gh issue comment` |
| PR 생성·본문 수정·코멘트 | `gh pr create`, `gh pr edit`, `gh pr comment` |

```bash
gh pr comment 123 --repo owner/repo \
  --body "저장 결과 화면입니다." \
  --attach './screenshot.png#저장 완료 화면'
```

`--attach`는 반복할 수 있으며 명령당 최대 50개다. 같은 파일을 중복 첨부하거나 `--web`과 함께 사용하지 않는다.

## 본문 위치에 첨부

`pr-body.md`에 로컬 파일 참조를 작성한다.

```markdown
### 저장 결과
![저장 완료 화면](./screenshot.png)

### 동작 영상
![](./walkthrough.mp4)
```

본문과 `--attach`에는 같은 파일 경로를 사용한다. 상대 경로는 실행 CWD에 맞추고, 혼선이 있으면 둘 다 절대 경로로 작성한다.

```bash
gh pr create --repo owner/repo \
  --title "저장 흐름 수정" --body-file ./pr-body.md \
  --attach ./screenshot.png --attach ./walkthrough.mp4
```

기존 PR을 갱신할 때는 현재 본문을 읽어 내용을 병합한 뒤 실행한다. 다른 내용과 이미 업로드된 URL은 보존한다.

```bash
gh pr edit 123 --repo owner/repo \
  --body-file ./pr-body.md \
  --attach ./screenshot.png --attach ./walkthrough.mp4
```

- 본문에 참조된 파일은 해당 위치에서 업로드 URL로 치환된다. `--body`, `--body-file`, stdin, 에디터 입력 모두 동일하다.
- 참조되지 않은 첨부는 본문 끝에 플래그 순서대로 추가된다.
- 이미지 alt는 본문의 값을 유지한다. 본문에 없는 이미지의 alt는 `--attach './image.png#설명'`으로 지정하며, 생략하면 파일명을 사용한다.
- 영상에는 `#alt`를 지정할 수 없다. 플레이어로 표시하려면 `![](./video.mp4)`를 별도 문단에 둔다. 문장 중간이면 링크로 표시된다.
- `gh pr edit` 또는 `gh issue edit`에 `--attach`만 주면 기존 본문을 유지하면서 파일을 덧붙인다.

## 파일 제한

| 파일 | 크기 제한 |
|---|---|
| PNG, JPEG, GIF, WebP, SVG | 10 MB |
| MP4, MOV, WebM | Free 플랜 10 MB, 유료 플랜 100 MB |
| HTML, PDF, ZIP 등 이미지·영상 외 파일 | 네이티브 첨부 미지원 |

큰 이미지·GIF는 해상도·프레임을 조정하고 다시 크기를 확인한다. 영상으로 변환했으면 본문 참조와 첨부 경로도 함께 바꾼다. HTML 리포트는 로컬 프리뷰로 유지하고, 공유에는 이미 정해진 별도 전달 경로를 사용한다.

## 결과 확인과 실패 처리

명령의 출력은 개별 첨부의 JSON `href`가 아니라 대상 이슈·PR·코멘트 URL이다. 게시 후 실제 본문을 다시 읽어 로컬 참조가 업로드 URL로 바뀌었는지 확인한다.

```bash
gh pr view 123 --repo owner/repo --json body,url
```

일부 파일 업로드가 실패해도 성공한 첨부로 대상이 생성·갱신될 수 있다. 이때 명령은 non-zero를 반환하면서 대상 URL을 출력한다. 출력된 URL의 실제 본문과 실패 파일부터 확인하고, 새 이슈·PR·코멘트를 통째로 다시 만들지 않는다. 기존 대상과 성공한 URL을 보존하면서 누락만 보완한다.

인증·권한 오류는 `gh auth status`와 대상 저장소의 push 권한을 확인한다. 종료 코드만으로 전체 성공이나 전체 미반영을 단정하지 않는다.

## 첨부 URL만 필요한 경우

이미 게시한 첨부의 URL은 해당 본문을 재조회해 얻는다. 네이티브 CLI에는 파일만 업로드하고 URL을 반환하는 독립 명령이 없다. URL을 얻으려고 임의의 이슈·코멘트를 만들거나 PR을 수정하지 않는다. 파일 단독 업로드가 요청되면 지원 범위를 설명하고 정해진 다른 업로드 경로를 사용한다.

## 명령과 제한 확인

- [로컬 파일 참조 치환·alt·영상 렌더링](https://docs.github.com/en/github-cli/github-cli/attaching-files-with-github-cli)
- [지원 버전·인증·파일 크기·서버 범위](https://github.blog/changelog/2026-09-01-github-cli-media-in-issues-pull-requests-and-comments/)
- [`gh pr edit` 옵션과 일부 업로드 실패](https://cli.github.com/manual/gh_pr_edit)
