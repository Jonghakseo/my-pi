---
name: easy-review
description: "Create selective, read-only, evidence-anchored review views from Git working trees, staged or unstaged changes, commits and ranges, GitHub PRs, agent-authored changes, or unified diff files. Use when the user asks for Easy Review, 이지 리뷰, or to review, inspect, summarize, abridge, or make a PR or diff easier to understand in chat or self-contained HTML. Organize changes into a reader-first story, deliberately show, summarize, or omit files and low-signal regions, preserve the complete original diff outside the reading view, expose coverage and uncertainty, and never post reviews, modify code, or call an LLM API. Do not use for implementing fixes, addressing review comments, or diagnosing runtime failures."
---

# Easy Review

코드 변경을 사람이 위에서 아래로 자연스럽게 이해할 수 있는 읽기 문서로 만든다. 현재 에이전트가 의미와 위험을 판단하고, 번들 스크립트는 원본 보존·분할·검증·렌더링만 결정적으로 수행한다. HTML은 문자열 조각을 이어 붙이지 않고 표준 라이브러리의 구조화된 노드로 만든다. 동적 텍스트와 attribute는 serializer가 이스케이프하고, 검증한 정적 CSS·JavaScript 자산만 별도로 삽입한다.

## 지켜야 할 경계

- 저장소와 원격 서비스에는 읽기 전용으로 접근한다. checkout, 소스 수정, stage, commit, push, 리뷰 게시, 스레드 해결을 하지 않는다.
- 외부 LLM API를 호출하거나 제공자 API 키를 읽지 않는다. 현재 대화 중인 에이전트만 의미 판단을 맡는다.
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

`<bundle-dir>/review-plan.json`을 `edit` 도구로 편집한다(대규모 재작성이 필요하면 `write`). Git 파일 순서를 그대로 사용하지 않는다.

- `summary`는 이 변경으로 최종적으로 무엇이 달라지는지 한 문단으로 쓴다.
- `overview`는 독자가 상세 코드를 읽기 전에 알아야 할 결과를 1~5개 평문으로 쓴다.
- `sections` 배열 순서가 문서의 실제 읽는 순서다. 기능 흐름과 인과관계를 기준으로 관련 파일을 묶는다.
- 보통 사용자에게 보이는 진입점과 핵심 판단을 먼저, 연동 경계를 다음, DB·마이그레이션·설정과 테스트·생성물을 뒤에 둔다. 실제 변경의 이해 순서가 다르면 그에 맞게 바꾼다.
- 핵심 동작 묶음은 `default_open: true`로, 마이그레이션·설정·테스트·fixture·생성물·lockfile 같은 보조 묶음은 대개 `false`로 둔다.
- 각 section 제목은 독자가 답을 얻을 질문이나 동작으로 쓴다. `서비스 변경`, `기타`, `mechanical` 같은 분류명은 쓰지 않는다.
- 각 파일의 `note`는 그 파일이 묶음에서 맡는 역할을 설명한다. `reviewed`, `generated`, `mechanical` 같은 내부 분류를 독자 문구로 노출하지 않는다.
- section 안의 각 파일은 `view`를 고른다. 핵심 판단과 효과를 직접 보여줘야 하면 `detail`, 존재와 역할만 알면 충분하면 `summary`다. 렌더러는 `detail`을 먼저 보여주고 `summary`는 section 최하단의 닫힌 `보조 변경` 묶음으로 모은다.
- 읽어 본 뒤에도 독해에 도움이 되지 않는 생성물, lockfile, 반복 boilerplate, source-of-truth와 동일한 복제물은 section에 넣지 않고 `omitted_files`에 사유와 함께 둔다. 이 파일들은 HTML 본문에 나오지 않고 원본 diff와 review JSON에만 남는다.
- 큰 diff는 상세 코드 파일을 기본 8개 이내로 고른다. 더 필요하다면 각 파일에 다른 조건·판단·효과가 있어야 한다. 파일 수를 채우기 위해 코드를 보여주지 않는다.
- `attention`은 실제로 먼저 판단해야 할 항목만 둔다. `fix`는 고칠 결함, `caution`은 구체적인 위험, `confirm`은 결정에 필요한 미확인 사항이다. 아무것도 없으면 섹션 자체를 만들지 않는다.
- `verification`에는 대상 코드에 대해 별도로 확인한 테스트·typecheck·lint·build·CI·관련 소스 대조·실제 런타임 근거만 기록한다. Easy Review 자체의 chunk 열람, hash·schema·근거 ID 검사, coverage 계산, HTML 생성 성공은 내부 무결성 검사이므로 넣지 않는다. 대상에 대해 확인한 내용이 없으면 빈 배열로 둔다.
- 모든 section과 attention에는 `detail` 파일의 원본 `D...` 근거를 붙인다. HTML에서는 파일명과 실제 줄 번호가 먼저 보이고 내부 ID는 기본적으로 숨겨진다.
- `focus`의 `reason`은 해당 파란 코드 영역 바로 위에 해설로 나타난다. 입력·조건·결과가 드러나는 자연스러운 완전한 문장으로 쓰고 `핵심 로직`, `실제 정책`, `대표 시나리오` 같은 추상 딱지는 쓰지 않는다.
- `collapse`는 파일 안의 import 정리, 반복 setup, 큰 literal, 단순 전달 코드처럼 펼쳐서 복구할 수 있는 저신호 영역에 적극 사용한다. `reason`은 코드 행 사이에 남으므로 숨긴 코드의 역할을 짧게 쓴다. `DI 주입`, `hook 연결`, `import 추가` 같은 구현 용어보다 `알림 처리에서 앱 리뷰 기능을 사용할 수 있게 연결`처럼 독자가 얻는 의미를 우선한다. import가 의존성이나 side effect를 바꾸면 접지 않는다.
- 검토한 파일은 section 또는 `omitted_files` 중 정확히 한 곳에 넣는다. 못 읽은 파일만 `unreviewed_file_ids`에 남긴다.
- 테스트 묶음은 구현 파일과 섞지 말고, 어떤 조건과 결과를 보증하는지 설명한다.

스키마가 불명확하거나 검증이 실패하면 [references/artifact-contract.md](references/artifact-contract.md)를 읽는다.

## 검증하고 렌더링한다

```bash
python3 "$SKILL_DIR/scripts/easy_review.py" preview --bundle <bundle-dir>
```

stale hash, 알 수 없는 근거, section 밖 근거, 파일 중복·누락, 범위 겹침, 미검토 chunk 주장을 바로잡고 다시 검증한다. 오류를 없애려고 계획의 신뢰 기준을 낮추지 않는다.

```bash
python3 "$SKILL_DIR/scripts/easy_review.py" compile --bundle <bundle-dir> --format <chat|html|both>
```

사용자가 형식을 정했다면 그대로 쓴다. 별도 지정이 없으면 파일 8개·변경 300줄 이하는 `chat`, 둘 중 하나라도 넘으면 `both`를 쓴다.

## 결과를 전달한다

채팅 결과는 `<bundle-dir>/review.md`의 내용을 현재 GUI에 맞게 전달한다. HTML은 `<bundle-dir>/review.html`의 절대 경로 링크를 준다. 두 형식 모두 결과 요약 → 읽는 순서 → 먼저 볼 점 → 의미 묶음 → 대상에 대해 확인한 내용이 있을 때만 검증 근거 → 기술 정보 순서를 유지한다.

최종 답변에는 대상, 전체/일부 검토 범위, 실제로 먼저 볼 점, 수행한 검증, 생성한 HTML 링크만 간결하게 적는다. 문제를 찾지 못했다는 사실을 승인이나 안전 보장으로 표현하지 않는다.
