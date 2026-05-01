[English](./README.md) | **한국어**

# my-pi

일상 개발에 사용하는 [pi](https://github.com/mariozechner/pi-coding-agent) 설정이다.

이 저장소에는 하나의 작업 환경에서 함께 쓰는 에이전트 정의, 로컬/패키지형 확장 기능, 스킬, 테마가 들어 있다.

> [!NOTE]
> 개인 실사용 셋업이라 문서가 현재 상태보다 늦을 수 있고, 일부 내용은 예고 없이 바뀔 수 있다.

## 사용 예시

<p align="center">
  <img src="./tmp/pi-usage-example.png" alt="도구 호출, thinking 상태, todo 진행률, 상태 푸터가 보이는 pi 사용 예시" width="800"/>
</p>

일반적인 세션에서는 압축된 도구 호출 프리뷰, 한국어 명령 제목, thinking/status 표시, 작업 추적, MCP 상태, 모델/thinking 표시, 저장소 컨텍스트를 하나의 터미널 UI에서 함께 사용한다.

---

## 아키텍처

<p align="center">
  <img src="./tmp/architecture.ko.svg" alt="시스템 아키텍처" width="800"/>
</p>

시스템은 **네 개의 레이어**로 구성된다:

| 레이어 | 역할 |
|---|---|
| **사용자 / pi TUI** | 터미널 기반 인터랙티브 인터페이스 |
| **확장 기능** | 디렉터리형 로컬 TypeScript 확장 + 설치형 npm 확장 패키지 |
| **에이전트** | 역할과 모델이 다른 11개의 전문 에이전트 정의 |
| **인프라** | `@ryan_nookpi/pi-extension-claude-mcp-bridge`를 통한 MCP 도구 연동 — 기존 Claude Code MCP 설정을 그대로 재사용 (Jira, Slack, Gmail, Calendar, GA4, Figma, DB 등) |

---

## 에이전트

<p align="center">
  <img src="./tmp/agents.ko.svg" alt="에이전트" width="800"/>
</p>

현재 기준 11개의 에이전트 정의, OpenAI/Anthropic 기반 에이전트 모델, 추가 Ollama Cloud provider 옵션으로 구성된다:

| 에이전트 | 모델 | 역할 | 사용 시점 |
|---|---|---|---|
| **finder** | `anthropic/claude-sonnet-4-6` | 빠른 파일·코드 탐색 | 빠른 조회, grep 스타일 탐색 |
| **worker** | `openai-codex/gpt-5.5` | 범용 작업 실행기 | 구현, 작성, 수정 (복잡한 다중 파일) |
| **planner** | `anthropic/claude-opus-4-7` | 구현 설계자 | 복잡한 작업 분할 |
| **simplifier** | `anthropic/claude-sonnet-4-6` | 코드 단순화 전문가 | 최근 수정 코드 정리, 가독성 개선, 동작 보존 리팩터링 |
| **code-cleaner** | `anthropic/claude-opus-4-6` | 코드 정리 분석가 | 중복 제거 후보, 품질 문제 탐색 |
| **reviewer** | `openai-codex/gpt-5.5` | 코드 리뷰 전문가 | PR 리뷰, 품질/정확성 점검 |
| **challenger** | `openai-codex/gpt-5.5` | 스트레스 테스터 | 실행 전 계획 검증 |
| **verifier** | `anthropic/claude-opus-4-6` | 근거 기반 검증 | 주장 확인, 정확성 점검 |
| **security-auditor** | `openai-codex/gpt-5.5` | 보안 검토자 | 취약점 중심 리뷰 |
| **searcher** | `anthropic/claude-sonnet-4-6` | 리서치·웹 검색 | 문서 탐색, 조사 |
| **browser** | `openai-codex/gpt-5.5` | 브라우저 자동화·UI 테스트 | E2E 테스트, 시각 검증 |

<details>
<summary><strong>모델 선택 기준</strong></summary>

- **openai-codex/gpt-5.5** — 범용 실행·리뷰 (구현, 테스트, 리뷰, 보안 검토, 브라우저 자동화)
- **anthropic/claude-sonnet-4-6** — 빠른 탐색·리서치 (파일 검색, 웹 리서치, 코드 단순화)
- **anthropic/claude-opus-4-6 / 4-7** — 깊은 추론 작업 (전략 설계, 검증, 정리 분석)
- **ollama-kimi-cloud/kimi-k2.6:cloud** — 텍스트/이미지 입력을 지원하는 Ollama Cloud Kimi K2.6 provider 옵션

메인 에이전트 기본값은 `openai-codex/gpt-5.5` + high thinking이다.

</details>

---

## 확장 기능

이 셋업은 **디렉터리 우선 확장 구조**를 사용한다.

pi는 `extensions/*.ts`와 `extensions/*/index.ts`를 모두 자동 발견할 수 있지만, 이 저장소는 중복 로딩을 피하고 지원 파일을 한곳에 모으기 위해 로컬 확장을 **`extensions/<name>/index.ts` 형식으로만** 관리한다.

- 로컬 확장은 `extensions/<name>/index.ts`에 둔다.
- 공용 헬퍼는 `extensions/utils/`에 둔다.
- `extensions/custom-style/`은 `footer/` facade가 사용하는 지원 모듈이며, 독립 자동 발견 확장이 아니다.
- 재사용 가능한 설치형 확장은 `settings.json`의 `packages`에 등록한다.
- 자세한 확장 개발 메모는 [`extensions/README.md`](./extensions/README.md)를 참고한다.

### 로컬 확장

#### 코어 / 에이전트 오케스트레이션

| 확장 | 설명 |
|---|---|
| [`subagent/`](./extensions/subagent/index.ts) | 멀티 에이전트 위임 엔진 — CLI/도구 인터페이스, 세션 영속화, 상태 위젯, retry/continue/batch/chain 워크플로우, 서브세션 에스컬레이션 |
| [`dynamic-agents-md/`](./extensions/dynamic-agents-md/index.ts) | 탐색/파일 도구 결과 이후 스코프별 `AGENTS.md` 컨텍스트를 동적으로 주입 |
| [`interactive-shell/`](./extensions/interactive-shell/index.ts) | `interactive_shell` 도구와 `/attach`, `/dismiss` — interactive/hands-free/dispatch/background/reattach 셸 세션 |
| [`web-access/`](./extensions/web-access/index.ts) | 로컬 웹 리서치/콘텐츠 추출 도구: `web_search`, `fetch_content`, `get_search_content`, 큐레이터 워크플로우, GitHub/PDF/동영상/YouTube 추출 |
| [`ollama-gemma4-26b/`](./extensions/ollama-gemma4-26b/index.ts) | Gemma 4 26B용 Ollama provider 연결 |
| [`ollama-kimi-k2-6-cloud/`](./extensions/ollama-kimi-k2-6-cloud/index.ts) | Kimi K2.6용 Ollama Cloud provider 연결 |

#### 도구 오버라이드 / 렌더링

| 확장 | 설명 |
|---|---|
| [`bash-tool-override/`](./extensions/bash-tool-override/index.ts) | `bash` 렌더링을 오버라이드하고 셸 명령 제목을 짧은 한국어로 강제 |
| [`read-tool-override/`](./extensions/read-tool-override/index.ts) | 커스텀 `read` 도구 UI/렌더링 |
| [`edit-tool-override/`](./extensions/edit-tool-override/index.ts) | 커스텀 `edit` 도구 UI/렌더링 |
| [`tool-group-renderer/`](./extensions/tool-group-renderer/index.ts) | 관련 도구 출력을 그룹화/접기 처리해 세션을 깔끔하게 유지 |

#### UI / UX

| 확장 | 설명 |
|---|---|
| [`footer/`](./extensions/footer/index.ts) | `custom-style/` 상태/UI 모듈을 사용하는 커스텀 푸터 facade |
| [`working-text/`](./extensions/working-text/index.ts) | 처리 중 경과 시간과 함께 팁 중심 스피너 텍스트 표시 |
| [`theme-cycler/`](./extensions/theme-cycler/index.ts) | `Ctrl+Shift+X` / `Ctrl+Q` 테마 순환 및 `/theme` 선택기 |
| [`diff-overlay/`](./extensions/diff-overlay/index.ts) | `/diff` — diff 모드와 commit 모드를 지원하는 git diff 오버레이 |
| [`files/`](./extensions/files/index.ts) | `/files`와 파일 참조 단축키 — 탐색, 열기, Finder 표시, Quick Look |
| [`fork-panel/`](./extensions/fork-panel/index.ts) | `/fork-panel` — 현재 세션을 Ghostty split panel로 포크 |
| [`bookmark/`](./extensions/bookmark/index.ts) | `/bookmark` — pi 세션 저장 및 다시 열기 |

#### GitHub / 워크플로우 자동화

| 확장 | 설명 |
|---|---|
| [`github-pr-merge/`](./extensions/github-pr-merge/index.ts) | `/github:pr-merge` — 현재 브랜치 PR을 `gh`로 merge |
| [`pr-comments/`](./extensions/pr-comments/index.ts) | `/github:get-pr-comments` — 현재 PR의 미해결 inline review comment를 append |
| [`pr-review-re-request/`](./extensions/pr-review-re-request/index.ts) | `/github:pr-review-re-request` — 미승인 리뷰어에게 review re-request 전송 |
| [`branch-rename/`](./extensions/branch-rename/index.ts) | `/auto-branch` — 컨텍스트를 분석해 현재 브랜치 이름을 백그라운드에서 변경 |
| [`notify/`](./extensions/notify/index.ts) | `/notify`, `/notify-off` — 세션 완료 알림과 macOS TTS |
| [`until/`](./extensions/until/index.ts) | `/until`, `/untils`, `/until-cancel`, `until_report` — 조건 충족까지 반복 실행 |
| [`upload-image-url/`](./extensions/upload-image-url/index.ts) | `upload_image_url` — 로컬/원격 이미지를 GitHub 기반 스토리지에 업로드해 임베딩 |
| [`usage-analytics/`](./extensions/usage-analytics/index.ts) | `/analytics` — 서브에이전트·스킬 사용 통계 오버레이 |
| [`archive-to-html/`](./extensions/archive-to-html/index.ts) | 조건에 맞는 임시 HTML 출력과 `show_widget` 렌더링을 `~/Documents/agent-history/분류 전`에 아카이브 |

#### 안전 장치

| 확장 | 설명 |
|---|---|
| [`command-typo-assist/`](./extensions/command-typo-assist/index.ts) | 알 수 없는 슬래시 명령을 가로채 가장 가까운 명령을 제안하고 에디터에 미리 입력 |

### 설치형 npm 확장 패키지

현재 `settings.json`에 등록된 재사용 확장 패키지 목록은 다음과 같다.

| 패키지 | 역할 |
|---|---|
| [`@ryan_nookpi/pi-extension-codex-fast-mode`](https://github.com/Jonghakseo/pi-extension/tree/main/packages/codex-fast-mode) | Codex Fast Mode 토글 |
| [`@ryan_nookpi/pi-extension-clipboard`](https://github.com/Jonghakseo/pi-extension/tree/main/packages/clipboard) | 클립보드 복사 도구 |
| [`@ryan_nookpi/pi-extension-ask-user-question`](https://github.com/Jonghakseo/pi-extension/tree/main/packages/ask-user-question) | 인터랙티브 질문 폼 도구 |
| [`@ryan_nookpi/pi-extension-auto-name`](https://github.com/Jonghakseo/pi-extension/tree/main/packages/auto-name) | 세션 이름 자동 지정 |
| [`@ryan_nookpi/pi-extension-delayed-action`](https://github.com/Jonghakseo/pi-extension/tree/main/packages/delayed-action) | 지연 실행 액션 |
| [`@ryan_nookpi/pi-extension-idle-screensaver`](https://github.com/Jonghakseo/pi-extension/tree/main/packages/idle-screensaver) | 유휴 스크린세이버 |
| [`@ryan_nookpi/pi-extension-todo-write-overlay`](https://github.com/Jonghakseo/pi-extension/tree/main/packages/todo-write-overlay) | 오버레이 UI를 포함한 `todo_write` 작업 추적 도구; 기존 `todo-write` 패키지를 대체 |
| [`@ryan_nookpi/pi-extension-open-pr`](https://github.com/Jonghakseo/pi-extension/tree/main/packages/open-pr) | 현재 브랜치 PR 열기 |
| [`@ryan_nookpi/pi-extension-generative-ui`](https://github.com/Jonghakseo/pi-extension/tree/main/packages/generative-ui) | `visualize_read_me`, `show_widget` 네이티브 시각화 위젯 |
| [`@ryan_nookpi/pi-extension-cross-agent`](https://github.com/Jonghakseo/pi-extension/tree/main/packages/cross-agent) | `.claude`, `.gemini`, `.codex`의 에이전트 정의/명령 로드 |
| [`@ryan_nookpi/pi-extension-claude-hooks-bridge`](https://github.com/Jonghakseo/pi-extension/tree/main/packages/claude-hooks-bridge) | Claude Code hooks 브릿지 |
| [`@ryan_nookpi/pi-extension-claude-mcp-bridge`](https://github.com/Jonghakseo/pi-extension/tree/main/packages/claude-mcp-bridge) | Claude Code MCP 브릿지 |
| [`@ryan_nookpi/pi-extension-memory-layer`](https://github.com/Jonghakseo/pi-extension/tree/main/packages/memory-layer) | 영속 메모리 도구 |
| [`@ryan_nookpi/pi-extension-diff-review`](https://github.com/Jonghakseo/pi-extension/tree/main/packages/diff-review) | Diff 리뷰 보조 |
| [`@ryan_nookpi/pi-extension-claude-spinner`](https://github.com/Jonghakseo/pi-extension/tree/main/packages/claude-spinner) | Claude 스타일 스피너/상태 피드백 |
| [`@ryan_nookpi/pi-extension-cc-system-prompt`](https://github.com/Jonghakseo/pi-extension/tree/main/packages/cc-system-prompt) | Claude Code 스타일 시스템 프롬프트 |
| [`@ryan_nookpi/pi-extension-codex-large-context`](https://github.com/Jonghakseo/pi-extension/tree/main/packages/codex-large-context) | Codex large-context 지원 |

---

## 테마

현재 8개 테마를 제공하며, `Ctrl+Shift+X` / `Ctrl+Q`로 실시간 전환하거나 `/theme`으로 선택할 수 있다:

| 테마 | 스타일 |
|---|---|
| **zentui** *(기본)* | ZenTUI에서 영감을 받은 미니멀 다크 테마 |
| **nord** | 북극풍, 깔끔한 블루와 서리 톤 |
| **catppuccin-mocha** | 다크 초콜릿 위의 따뜻한 파스텔 |
| **darcula** | JetBrains 스타일의 진한 다크 톤 |
| **dracula** | 대비가 선명한 퍼플 계열 다크 테마 |
| **gruvbox** | 레트로 따뜻한 톤, 눈이 편한 |
| **midnight-ocean** | 깊은 바다 블루와 틸 |
| **rose-pine** | 차분하고 우아한 로즈 톤 |

---

## 단축키

| 키 | 동작 |
|---|---|
| `Ctrl+T` | 사고(thinking) 표시 토글 |
| `Ctrl+Shift+X` | 테마 정방향 순환 |
| `Ctrl+Q` | 테마 역방향 순환 |
| `Ctrl+Shift+O` | 파일 브라우저 열기 |
| `Ctrl+Shift+F` | 최근 파일 참조를 Finder에서 표시 |
| `Ctrl+Shift+R` | 최근 파일 참조 Quick Look |
| `Ctrl+O` | 도구 출력 접기/펼치기 (pi 기본, 로컬 도구 렌더러로 커스터마이즈) |

---

## 웹 리서치 확장

이 셋업은 웹 리서치 스택을 로컬 확장 [`extensions/web-access/`](./extensions/web-access/index.ts)으로 관리한다.

- 도구: `web_search`, `fetch_content`, `get_search_content`
- Provider/워크플로우: Exa, Perplexity, Gemini API, Gemini Web, URL context, curator summary review
- 추출기: 읽기 쉬운 웹 페이지, GitHub 저장소/파일, PDF, RSC payload, YouTube/동영상 프레임과 transcript

---

## 메모

이 셋업은 다음 기준으로 정리되어 있다:

**1. 역할을 분리한다.**
에이전트마다 책임을 좁게 나눠서 위임 흐름을 단순하게 유지한다.

**2. 확장은 생명주기별로 나눈다.**
재사용 가능한 요소는 npm 패키지로 옮기고, 로컬 실험과 개인 워크플로우 접착 코드는 `extensions/<name>/index.ts`에 둔다.

**3. 안전 장치를 기본값으로 둔다.**
오타 감지, 확인 단계, 스코프별 AGENTS.md 주입, 표시 제어를 기본 흐름에 포함한다.

**4. 가능한 한 터미널 안에서 처리한다.**
파일 탐색, diff, PR 작업, 웹 리서치, 셸, 알림, 자동화를 같은 환경에서 처리한다.
