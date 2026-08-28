---
name: easy-review
description: "Use when the user asks for Easy Review (이지 리뷰), an interactive Easy Review chatbot, or to make Git changes, commits, PRs, or diffs easier to understand as a read-only, reader-ordered HTML review document with optional local Pi Q&A."
---

# Easy Review

코드 변경을 사람이 위에서 아래로 자연스럽게 이해할 수 있는 읽기 문서로 만든다. 현재 에이전트가 의미와 위험을 판단하고, 번들 스크립트는 원본 보존·분할·검증·렌더링만 결정적으로 수행한다. HTML은 문자열 조각을 이어 붙이지 않고 표준 라이브러리의 구조화된 노드로 만든다. 동적 텍스트와 attribute는 serializer가 이스케이프하고, 검증한 정적 CSS·JavaScript 자산만 별도로 삽입한다.

## 지켜야 할 경계

- 저장소와 원격 서비스에는 읽기 전용으로 접근한다. checkout, 소스 수정, stage, commit, push, 리뷰 게시, 스레드 해결을 하지 않는다.
- 캡처·검증·컴파일은 외부 LLM API를 호출하거나 제공자 API 키를 읽지 않는다. 선택적 `serve`만 Node 서버 프로세스 안에 Pi SDK 세션을 만들며, 로컬 `auth.json`과 현재 모델 설정을 계승해 설정된 모델 제공자와 통신함을 사용자에게 알린다.
- 채팅 Pi에는 일반 Pi 도구를 제공하지 않는다. 저장소나 임의 로컬 파일을 읽지 못하게 하고, 검증된 `review.json` 메모리 데이터만 검색하는 읽기 전용 `review_diff` 도구 하나만 제공한다. 이 도구의 결과는 캡처 시점 diff이며 live Git 상태가 아니다.
- 표시할 코드를 다시 작성하지 않는다. 원본 diff의 `D000001` 형태 내부 근거 ID로 정확한 줄을 가리킨다. 원본은 모두 보존하되 HTML에 모든 파일을 표시할 의무는 없다.
- CI 통과, merge, 배포, 실제 런타임 동작을 서로 다른 근거로 취급한다.
- 일부 파일이나 변경 묶음을 읽지 못했다면 결과를 반드시 `partial`로 남긴다.

## 대상을 캡처한다

명확한 모드 하나를 고른다. base나 대상이 안전하게 정해지지 않을 때만 질문한다.

- 현재 에이전트 작업 또는 전체 미커밋 변경: `--worktree`
- unstaged만: `--unstaged`
- staged만: `--staged`
- 단일 commit: `--revision <rev>`
- 비교 범위: `--range <A..B-or-A...B>`
- GitHub PR URL 또는 번호: `--pr <url-or-number>`; `gh` CLI로 읽기만 한다.
- 기존 unified diff: `--diff-file <path>`

`SKILL_DIR`을 이 파일이 있는 디렉터리(`~/.pi/agent/skills/easy-review`)로 정하고 실행한다.

```bash
python3 "$SKILL_DIR/scripts/easy_review.py" capture <mode> --repo <repo> --output <bundle-dir>
```

`--output`을 생략하면 저장소의 Git metadata 아래에 번들이 생긴다. 출력된 경로를 기록한다.

## 전체 변경을 먼저 읽는다

```bash
python3 "$SKILL_DIR/scripts/easy_review.py" inspect --bundle <bundle-dir>
```

[references/review-rubric.md](references/review-rubric.md)를 완전히 읽은 뒤 계획을 작성한다. 모든 대상 chunk를 읽는다.

```bash
python3 "$SKILL_DIR/scripts/easy_review.py" inspect --bundle <bundle-dir> --chunk C001
```

큰 diff도 먼저 전체 파일 목록과 중복·이동·생성 후보·binary·rename·mode-change 힌트를 확인한다. 이후 chunk를 읽되, 마지막 chunk까지 본 다음에야 최종 묶음과 순서를 정한다. 파일명이나 한 조각만 보고 동작을 단정하지 말고, 필요한 정의·호출자·테스트를 저장소에서 읽는다.

## 독자의 읽는 순서를 설계한다

무엇을 보여주고 접고 생략할지, 제목·해설·attention·verification을 어떻게 쓸지는 모두 [references/review-rubric.md](references/review-rubric.md)의 기준을 따른다. 여기서는 계획 파일의 절차만 정한다.

`<bundle-dir>/review-plan.json`을 `edit` 도구로 편집한다(대규모 재작성이 필요하면 `write`).

- `summary`는 최종적으로 달라지는 결과 한 문단, `overview`는 상세 코드 전에 알아야 할 결과 1~5개다.
- `sections` 배열 순서가 문서의 실제 읽는 순서다. Git 파일 순서를 그대로 사용하지 않는다.
- 핵심 흐름 section은 `default_open: true`, 마이그레이션·설정·테스트·생성물 같은 보조 section은 대개 `false`로 둔다.
- 검토한 파일은 section(`view`: `detail` 또는 `summary`) 또는 `omitted_files` 중 정확히 한 곳에 넣고, 못 읽은 파일만 `unreviewed_file_ids`에 남긴다.
- 모든 section과 attention에는 같은 section의 `detail` 파일을 가리키는 `D...` 근거를 붙인다. HTML에서는 파일명과 실제 줄 번호가 먼저 보이고 내부 ID는 기본적으로 숨겨진다.
- `focus`의 `reason`은 해당 코드 바로 위의 해설로, `collapse`의 `reason`은 접힌 행의 요약으로 렌더링된다.
- `attention`과 `verification`은 rubric 기준을 만족하는 항목만 담고, 없으면 빈 배열로 둔다.

스키마가 불명확하거나 검증이 실패하면 [references/artifact-contract.md](references/artifact-contract.md)를 읽는다.

## 검증하고 렌더링한다

```bash
python3 "$SKILL_DIR/scripts/easy_review.py" preview --bundle <bundle-dir>
```

stale hash, 알 수 없는 근거, section 밖 근거, 파일 중복·누락, 범위 겹침, 미검토 chunk 주장을 바로잡고 다시 검증한다. 오류를 없애려고 계획의 신뢰 기준을 낮추지 않는다.

```bash
python3 "$SKILL_DIR/scripts/easy_review.py" compile --bundle <bundle-dir>
```

## 요청받으면 로컬 Pi 채팅 서버까지 직접 실행한다

사용자가 HTML 안에서 리뷰와 대화하거나 챗봇 FAB·localhost 서버를 요청했을 때는 에이전트가 아래 명령을 장시간 실행 가능한 세션으로 직접 시작한다. 사용자가 실행할 명령만 안내하고 끝내지 않는다.

```bash
python3 "$SKILL_DIR/scripts/easy_review.py" serve --bundle <bundle-dir>
```

- `bash_async start`로 서버를 시작하고 timeout은 `7200`초로 둔다. 반환된 job ID를 기록하며, 반복 polling하지 않고 completion follow-up을 따른다. 2시간 뒤에도 필요하면 `serve`를 다시 실행해 새 job ID와 URL을 확인하고, 기존 job은 기록한 ID로 명시적으로 `bash_async kill`해 정리한다.
- 시작 로그가 나온 뒤 `bash_async output`을 한 번 조회해 실제 `http://127.0.0.1:<port>/` URL을 확인하고, 최종 답변에 클릭 가능한 링크로 전달한다. 포트를 추측하거나 고정하지 않는다.
- 서버 실행 전이나 URL 확인 전에 채팅 사용이 가능하다고 말하지 않는다.
- 자동으로 브라우저를 열지 않는다. 사용자가 중지를 요청하면 기록한 job ID에 `bash_async kill`을 실행한다.
- 서버는 loopback에만 바인딩하고 실행별 HttpOnly cookie와 Origin/Host 검사를 사용한다.
- 서버는 `@earendil-works/pi-coding-agent` SDK의 `ModelRuntime.create()`와 in-memory `AgentSession`을 같은 Node 프로세스에서 사용한다. 별도 Pi CLI/RPC subprocess를 만들지 않는다.
- `DefaultResourceLoader`에서 extensions, skills, prompt templates, themes, context files를 끄고, 세션은 `noTools: "builtin"`, `tools: ["review_diff"]`, `customTools: [reviewDiffTool]`로 만든다. custom tool 선택 계약은 설치된 Pi 공식 문서의 `docs/sdk.md`를 따르고 모델 제공자 동작은 `docs/providers.md`를 따른다.
- 질문에는 현재 보고 있는 section, 사용자가 선택한 리뷰 텍스트, 해당 section의 focus/evidence diff만 크기 제한과 함께 전달한다. 추가 근거가 필요할 때만 Pi가 `review_diff`로 `review.json`에 보존된 캡처 diff를 파일 경로·검색어·`D...` anchor 기준으로 조회한다.
- `review_diff`는 파일 경로를 filesystem path로 해석하지 않고 번들 파일 인덱스와만 대조한다. 응답은 최대 200개 diff 줄과 32,000자로 제한하고 offset pagination을 제공하며, `detail`·`summary`·`omitted`·`unreviewed` 상태를 보존한다.
- 답변은 스트리밍하면서 문단·제목·목록·강조·인라인 코드·코드 블록·인용·안전한 링크를 제한된 마크다운으로 렌더링한다. 모델 출력은 `innerHTML`에 넣지 않고 검증된 파서가 `createElement`와 text node로만 DOM을 구성한다.
- 정적 `file://`로 연 HTML은 기존 리뷰 기능을 유지하며, FAB에는 `serve`가 필요하다고 안내한다.
- 서버 종료 시 in-memory Pi SDK 세션을 `dispose()`한다.

## 결과를 전달한다

`<bundle-dir>/review.html`의 절대 경로 링크를 준다. 채팅 요청이 있었다면 서버를 직접 실행해 시작 로그에서 확인한 loopback HTTP URL을 클릭 가능한 링크로 함께 준다. 실행 명령만 전달하거나 사용자가 별도로 서버를 시작하게 하지 않는다.

최종 답변에는 대상, 전체/일부 검토 범위, 실제로 먼저 볼 점, 수행한 검증, 생성한 HTML 링크만 간결하게 적는다. 채팅을 실행했다면 실행 중인 서버 링크와 함께 번들 전용 컨텍스트이고 Pi의 설정된 모델 제공자와 통신한다는 점을 덧붙인다. 문제를 찾지 못했다는 사실을 승인이나 안전 보장으로 표현하지 않는다.
