# my-pi-extension

[pi 코딩 에이전트](https://github.com/mariozechner/pi-coding-agent)용 커스텀 확장 모음.

> 참고: 일부 확장(`codex-fast-mode`, `clipboard`, `ask-user-question`, `auto-name`, `delayed-action`, `idle-screensaver`, `todo-write`)은 이제 로컬 파일이 아니라 설치형 npm 패키지로 사용한다. 나머지 커스텀 확장들도 점진적으로 패키지화해 옮길 계획이다.

## 대표 확장

| 확장 | 설명 |
|------|------|
| [`subagent/`](./subagent/index.ts) | 서브에이전트 위임 시스템 (프로세스 실행, 세션 관리, 상태 위젯, 서브세션 전용 `ask_master`) |
| [`claude-mcp-bridge/`](./claude-mcp-bridge/index.ts) | Claude Code MCP 설정을 pi에서 재활용 |
| [`memory-layer/`](./memory-layer/index.ts) | 장기 기억 관리 (remember/recall/forget 도구 & UI) |
| [`generative-ui/`](./generative-ui/index.ts) | `visualize_read_me`, `show_widget` 기반 네이티브 위젯 렌더링 |
| [`archive-to-html.ts`](./archive-to-html.ts) | to-html 스킬 출력 HTML 자동 아카이브 |
| [`claude-hooks-bridge.ts`](./claude-hooks-bridge.ts) | Claude Code 훅을 pi에서 실행하는 브릿지 |
| [`command-typo-assist.ts`](./command-typo-assist.ts) | 슬래시 커맨드 오타 감지 → 제안 + 에디터 프리필 |
| [`context.ts`](./context.ts) | 컨텍스트 윈도우 사용량 & 세션 통계 오버레이 |
| [`cross-agent.ts`](./cross-agent.ts) | .claude/.gemini/.codex 디렉토리에서 커맨드/스킬 로드 |
| [`diff-overlay.ts`](./diff-overlay.ts) | Diff 뷰어 오버레이 |
| [`dynamic-agents-md.ts`](./dynamic-agents-md.ts) | 디렉토리 스코프별 동적 AGENTS.md 로딩 |
| [`files.ts`](./files.ts) | 파일 피커 / Diff 뷰어 UI |
| [`fork-panel.ts`](./fork-panel.ts) | 현재 세션을 Ghostty split panel로 포크 |
| [`open-pr.ts`](./open-pr.ts) | 현재 브랜치 PR을 브라우저에서 열기 (gh CLI 연동) |
| [`interactive-shell/`](./interactive-shell/index.ts) | 인터랙티브/핸즈프리/디스패치 모드의 셸 오버레이 |
| [`footer.ts`](./footer.ts) | 커스텀 푸터 UI (모델, 브랜치, 컨텍스트 바) |
| [`theme-cycler.ts`](./theme-cycler.ts) | `Ctrl+X`로 테마 순환 |
| [`until.ts`](./until.ts) | `/until`, `until_report` 기반 반복 작업 관리 |
| [`upload-image-url.ts`](./upload-image-url.ts) | 이미지 → GitHub 스토리지 업로드 |
| [`usage-analytics.ts`](./usage-analytics.ts) | 서브에이전트·스킬 사용 통계 오버레이 |
| [`working-text.ts`](./working-text.ts) | 스피너 작업 메시지 (팁 텍스트 + 경과 시간) |

## 기술 스택

- **언어**: TypeScript
- **패키지 매니저**: pnpm
- **린터/포매터**: Biome 2.x
- **의존성**: `@mariozechner/pi-coding-agent`, `@mariozechner/pi-ai`, `@mariozechner/pi-tui`

## 스크립트

```bash
pnpm run typecheck        # 타입 체크
pnpm run lint             # Biome 린트 (자동 수정)
pnpm run format:write     # Biome 포맷
```
