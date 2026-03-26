<div align="center">

[English](./README.en.md) | **한국어**

# 🧠 my-pi

**[pi](https://github.com/mariozechner/pi-coding-agent) 기반 개인 AI 오퍼레이팅 시스템**

*13개의 전문 에이전트 · 25개 이상의 확장 기능 · 한 개발자의 주관적인 셋업*

<br/>

`🤖 13 에이전트` &nbsp; `🧩 25+ 확장 기능` &nbsp; `🎨 7 테마`

<br/>

> AI 코딩 에이전트 설정을 하나의 **엔지니어링 프로젝트**로 다룬다면?
>
> 이 레포가 그 답이다 — 매일 실사용하는 설정으로, pi를 CLI 도구에서 멀티 에이전트 오케스트레이션 플랫폼으로 확장한다. 역할별 전문 에이전트, 안전 장치, 세밀한 커스터마이징까지.

</div>

---

> [!WARNING]
> 이 레포는 계속 바뀌는 개인 실사용 셋업이라 문서와 실제 상태가 언제든 어긋날 수 있다.
> 일부 기능이나 설정은 특정 시점에 불안정하거나 깨져 있을 수 있다.


## 🏗️ 아키텍처

<p align="center">
  <img src="./tmp/architecture.ko.svg" alt="시스템 아키텍처" width="800"/>
</p>

시스템은 **네 개의 레이어**로 구성된다:

| 레이어 | 역할 |
|---|---|
| **사용자 / pi TUI** | 터미널 기반 인터랙티브 인터페이스 |
| **확장 기능** | 25개 이상의 TypeScript 플러그인 — 서브에이전트, 음성 I/O, MCP 브릿지, UI 오버레이, 안전 장치 |
| **에이전트 오케스트라** | 역할과 모델이 다른 13개의 전문 에이전트 정의 |
| **인프라** | [claude-mcp-bridge](./extensions/claude-mcp-bridge/)를 통한 MCP 도구 연동 — 기존 Claude Code MCP 설정을 그대로 재사용 (Jira, Slack, Gmail, Calendar, GA4, Figma, DB 등) |

---

## 🤖 에이전트 오케스트라

<p align="center">
  <img src="./tmp/agents.ko.svg" alt="에이전트 오케스트라" width="800"/>
</p>

현재 기준 13개의 에이전트 정의, 3개의 모델, 하나의 오케스트레이터로 구성된다:

| 에이전트 | 모델 | 역할 | 사용 시점 |
|---|---|---|---|
| 🔍 **finder** | `anthropic/claude-sonnet-4-6` | 빠른 파일·코드 탐색 | 빠른 조회, grep 스타일 탐색 |
| ⚡ **worker** | `openai-codex/gpt-5.4` | 범용 작업 실행기 | 구현, 작성, 수정 (복잡한 다중 파일) |
| 🏃 **worker-fast** | `openai-codex/gpt-5.4` | 경량 단순 작업 실행기 | 단일 파일 수정, 간단한 변경 |
| 📐 **planner** | `anthropic/claude-opus-4-6` | 구현 설계자 | 복잡한 작업 분할 |
| ✨ **simplifier** | `anthropic/claude-sonnet-4-6` | 코드 단순화 전문가 | 최근 수정 코드 정리, 가독성 개선, 동작 보존 리팩터링 |
| 🧹 **code-cleaner** | `openai-codex/gpt-5.4` | 코드 정리 분석가 | 중복 제거 후보, 품질 문제 탐색 |
| 🔎 **reviewer** | `openai-codex/gpt-5.4` | 코드 리뷰 (P0–P3 심각도) | PR 리뷰, 품질 점검 |
| 🥊 **challenger** | `openai-codex/gpt-5.4` | 스트레스 테스터 | 실행 전 계획 검증 |
| ✅ **verifier** | `anthropic/claude-opus-4-6` | 3단계 근거 검증 | 주장 확인, 정확성 점검 |
| 🔐 **security-auditor** | `openai-codex/gpt-5.4` | 보안 검토자 | 취약점 중심 리뷰 |
| ⚖️ **decider** | `openai-codex/gpt-5.4` | 기술 의사 결정 | 아키텍처 선택, 트레이드오프 분석 |
| 🌐 **searcher** | `anthropic/claude-sonnet-4-6` | 리서치·웹 검색 | 문서 탐색, 조사 |
| 🖥️ **browser** | `openai-codex/gpt-5.4` | 브라우저 자동화·UI 테스트 | E2E 테스트, 시각 검증 |

<details>
<summary><strong>모델 선택 기준</strong></summary>

- **openai-codex/gpt-5.4** — 범용 실행·리뷰 (구현, 테스트, 리뷰, 의사결정, 브라우저 자동화)
- **anthropic/claude-sonnet-4-6** — 빠른 탐색·리서치 (파일 검색, 웹 리서치, 코드 단순화)
- **anthropic/claude-opus-4-6** — 깊은 추론 작업 (전략 설계, 검증)

오케스트레이터(메인 에이전트)는 `anthropic/claude-opus-4-6` 기반으로 동작하여 위임 결정을 수행한다.

</details>

---

## 🧩 확장 기능

25개 이상의 커스텀 TypeScript 확장 중 대표 항목들을 도메인별로 정리했다:

### 코어 시스템

| 확장 | 설명 |
|---|---|
| **subagent/** | 멀티 에이전트 위임 엔진 — 서브 `pi` 프로세스 생성, below-editor 상태 위젯으로 실행 관리, 자동 follow-up/정리 |
| **system-mode/** | "마스터 모드" (위임 전용 오케스트레이터) ↔ 일반 모드 전환 |
| **claude-mcp-bridge/** | Claude Code의 MCP 서버 설정을 그대로 재사용 — 중복 설정 제로 |
| **cross-agent.ts** | `.claude/`, `.gemini/`, `.codex/` 디렉터리에서 에이전트 정의 로드 |
| **dynamic-agents-md.ts** | 런타임에 AGENTS.md를 동적 로드하여 편집·쓰기 범위 제한 강제 |
| **escalate-tool.ts** | 서브에이전트가 마스터에게 에스컬레이션 신호를 보내는 도구 |
| **claude-hooks-bridge.ts** | Claude Code의 훅(hook) 이벤트를 Pi 세션에 연결하는 브릿지 |
| **memory-layer/** | 세션 간 영속 메모리 시스템 |

### UI / UX

| 확장 | 설명 |
|---|---|
| **voice-input.ts** | `Option+V` 음성 받아쓰기 + TTS 응답 — 에이전트와 대화하기 |
| **pipi-footer.ts** | 모델, git 브랜치, 컨텍스트 사용량을 보여주는 커스텀 푸터 |
| **working-text.ts** | 처리 중 경과 시간과 함께 재미있는 스피너 텍스트 |
| **idle-screensaver.ts** | 유휴 시 터미널 스크린세이버 |
| **theme-cycler.ts** | `Ctrl+X`로 테마 실시간 순환 |
| **diff-overlay.ts** | `/diff` — 분할 화면 git diff 뷰어 오버레이 |
| **github-overlay.ts** | 터미널에서 바로 GitHub PR 확인 |
| **status-overlay.ts** | `/status` — 확장 기능·스킬 상태 대시보드 |
| **files.ts** | `/files` — git 트리 파일 브라우저 + 열기/편집/diff 빠른 액션 |
| **fork-panel.ts** | `/fork-panel` — 현재 세션을 새 Ghostty split panel로 포크 |
| **generative-ui/** | `visualize_read_me`, `show_widget` — 네이티브 시각화/위젯 렌더링 |
| **override-builtin-tools.ts** | 도구 출력 접기/펼치기로 세션 깔끔하게 유지 |

### 개발 도구

| 확장 | 설명 |
|---|---|
| **todo-write.ts** | 할 일 관리 — `todo_write` 도구, 영속 저장소, TUI 렌더링 |
| **session-replay.ts** | `/replay` — 과거 세션 탐색·재생 |
| **auto-name.ts** | 첫 사용자 메시지로 세션 이름 자동 감지 |
| **upload-image-url.ts** | GitHub CDN으로 이미지 업로드 후 임베딩 |
| **clipboard.ts** | OSC52 이스케이프 시퀀스로 클립보드에 텍스트 복사 |
| **ask-user-question.ts** | 사전 정의 옵션을 갖춘 인터랙티브 질문 도구 |
| **delayed-action.ts** | 지연 실행 예약 |
| **until.ts** | `/until`, `until_report` — 조건 충족까지 반복 실행 |
| **usage-analytics.ts** | `/analytics` — 서브에이전트·스킬 사용 통계 오버레이 |
| **archive-to-html.ts** | to-html 스킬로 생성된 HTML 파일을 `~/Documents`에 자동 아카이브 |

### 안전 장치

| 확장 | 설명 |
|---|---|
| **damage-control-rmrf.ts** | 🛡️ `rm -rf` 같은 파괴적 명령을 실행 전에 차단 |
| **command-typo-assist.ts** | 명령어 오타를 감지하고 자동 수정 제안 |

---

## 📋 프롬프트 템플릿

`/template-name` 형태로 호출하는 재사용 가능한 워크플로우 템플릿:

### `/one-shot` — 풀 리서치 & 해결 파이프라인

다음을 강제하는 고강도 문제 해결 템플릿:

1. **리서치 우선** — 행동하기 전에 맥락 파악
2. **대안 탐색** — 폭넓은 트레이드오프 검토
3. **서브에이전트 무제한 활용** — 에이전트 자유롭게 위임
4. **challenger 게이트 필수** — 실행 전후 스트레스 테스트
5. **3단계 검증** — 자동 테스트 → 브라우저 검증 → 소스 분석
6. **HTML 산출물** — 최종 리포트, 대안 분석, 회고

```
/one-shot 결제 처리 파이프라인의 레이스 컨디션 수정
```

### `/qa-chain` — QA 파이프라인

여러 에이전트를 순차 연결하는 E2E 품질 보증:

```
worker → browser → verifier → reviewer
```

```pseudo
scenarios = worker("변경사항 분석, 테스트 시나리오 도출")
results   = browser(scenarios, "각 시나리오를 실제 브라우저에서 테스트")
fixes     = worker(failures, "이슈 수정")  →  verifier(fixes)
retest    = browser("수정 사항을 스크린샷으로 검증")
final     = reviewer("전체 변경사항 리뷰")
```

---

## 🏷️ 세션 이름

`/name`은 프롬프트 템플릿이 아니라 **내장 명령**이다.

```
/name <세션 이름>   # 이름 설정
/name               # 현재 이름 확인
```

---

## 🎨 테마

현재 7개 테마를 제공하며, `Ctrl+X`로 실시간 전환할 수 있다:

| 테마 | 스타일 |
|---|---|
| **nord** *(기본)* | 북극풍, 깔끔한 블루와 서리 톤 |
| **catppuccin-mocha** | 다크 초콜릿 위의 따뜻한 파스텔 |
| **darcula** | JetBrains 스타일의 진한 다크 톤 |
| **dracula** | 대비가 선명한 퍼플 계열 다크 테마 |
| **gruvbox** | 레트로 따뜻한 톤, 눈이 편한 |
| **midnight-ocean** | 깊은 바다 블루와 틸 |
| **rose-pine** | 차분하고 우아한 로즈 톤 |

---

## ⌨️ 단축키

| 키 | 동작 |
|---|---|
| `Ctrl+T` | 사고(thinking) 표시 토글 |
| `Ctrl+X` | 테마 순환 |
| `Ctrl+Q` | 테마 역순 순환 |
| `Ctrl+Shift+O` | 파일 브라우저 열기 |
| `Ctrl+Shift+F` | 최근 파일 참조를 Finder에서 표시 |
| `Ctrl+Shift+R` | 최근 파일 참조 Quick Look |
| `Ctrl+O` | 도구 출력 접기/펼치기 |
| `Option+V` | 음성 입력 (받아쓰기 + TTS) |


## 🌐 웹 리서치 확장

이 셋업은 `web_search`, `fetch_content`, `get_search_content` 도구 사용을 위해 **pi-web-access**를 함께 사용한다.

- 레포지토리: https://github.com/nicobailon/pi-web-access

```bash
pi install npm:pi-web-access
```
---

## 💡 설계 철학

이 프로젝트는 몇 가지 핵심 원칙에 기반한다:

**1. 에이전트 설정은 설정 파일이 아니라 엔지니어링이다.**
모든 에이전트 프롬프트는 직무 기술서처럼 설계한다. 모든 확장 기능은 실제 불편을 해결한다. 모든 자동화는 그 복잡성의 값어치를 한다.

**2. 전문화가 범용을 이긴다.**
리뷰만 하는 리뷰어가 "리뷰도 해줘"라는 범용 에이전트보다 더 많은 버그를 잡는다. challenger 에이전트는 오직 헛점을 찌르기 위해 존재하며, 시스템에서 가장 가치 있는 에이전트 중 하나다.

**3. 안전은 제약이 아니라 기능이다.**
`damage-control-rmrf.ts`는 `rm -rf /` 한 번이면 충분하기 때문에 존재한다. 오타 감지, 확인 프롬프트, 사고 과정 표시 모두 일급 관심사다.

**4. 터미널이 곧 IDE다.**
음성 입력, git diff, GitHub PR, 스크린세이버 — 전부 터미널 안에서. 컨텍스트 스위칭 필요 없음.

---

## 📈 운영 현황

데모 프로젝트가 아니다. 프로덕션 엔지니어링 업무에 **매일 사용하는 실전 설정**이다.

| 지표 | 값 |
|---|---|
| 활성 확장 기능 | 25+ |
| 에이전트 정의 | 13개 |
| 테마 | 7개 |

---

<div align="center">

*[@Jonghakseo](https://github.com/Jonghakseo)가 매일 만들고 사용하는 설정*

*[pi coding agent](https://github.com/mariozechner/pi-coding-agent) 기반*

</div>
