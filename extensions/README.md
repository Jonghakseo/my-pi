# my-pi-extension

[Pi 코딩 에이전트](https://github.com/nicholasgasior/pi-coding-agent)용 커스텀 확장 모음.

## 주요 확장

| 확장 | 설명 |
|------|------|
| [`subagent/`](./subagent/index.ts) | 서브에이전트 위임 시스템 (프로세스 실행, 세션 관리, 위젯) |
| [`claude-mcp-bridge/`](./claude-mcp-bridge/index.ts) | Claude Code MCP 설정을 pi에서 재활용 |
| [`memory-layer/`](./memory-layer/index.ts) | 장기 기억 관리 (remember/recall/forget 도구 & UI) |
| [`system-mode/`](./system-mode/index.ts) | 에이전트 모드 온/오프 토글 |
| [`archive-to-html.ts`](./archive-to-html.ts) | to-html 스킬 출력 HTML 자동 아카이브 |
| [`ask-user-question.ts`](./ask-user-question.ts) | 옵션 선택 + 자유 입력 질문 도구 |
| [`claude-hooks-bridge.ts`](./claude-hooks-bridge.ts) | Claude Code 훅을 pi에서 실행하는 브릿지 |
| [`clipboard.ts`](./clipboard.ts) | OSC52 기반 클립보드 복사 도구 |
| [`command-typo-assist.ts`](./command-typo-assist.ts) | 슬래시 커맨드 오타 감지 → 제안 + 에디터 프리필 |
| [`context.ts`](./context.ts) | 컨텍스트 윈도우 사용량 & 세션 통계 오버레이 |
| [`cross-agent.ts`](./cross-agent.ts) | .claude/.gemini/.codex 디렉토리에서 커맨드/스킬 로드 |
| [`damage-control-rmrf.ts`](./damage-control-rmrf.ts) | `rm -rf` 안전 가드 |
| [`delayed-action.ts`](./delayed-action.ts) | 지연 실행 스케줄링 |
| [`diff-overlay.ts`](./diff-overlay.ts) | Diff 뷰어 오버레이 |
| [`dynamic-agents-md.ts`](./dynamic-agents-md.ts) | 디렉토리 스코프별 동적 AGENTS.md 로딩 |
| [`files.ts`](./files.ts) | 파일 피커 / Diff 뷰어 UI |
| [`github-overlay.ts`](./github-overlay.ts) | GitHub PR 뷰 (gh CLI 연동) |
| [`idle-screensaver.ts`](./idle-screensaver.ts) | 유휴 시 세션 컨텍스트 스크린세이버 |
| [`override-builtin-tools.ts`](./override-builtin-tools.ts) | 도구 출력 접기/펼치기 |
| [`pipi-footer.ts`](./pipi-footer.ts) | 커스텀 푸터 UI (모델, 브랜치, 컨텍스트 바) |
| [`purpose.ts`](./purpose.ts) | 세션 목적 상단 오버레이 + 가드/도구/커맨드 |
| [`session-replay.ts`](./session-replay.ts) | 세션 리플레이 뷰어 |
| [`status-overlay.ts`](./status-overlay.ts) | 스킬, 도구 & 확장 목록 오버레이 |
| [`theme-cycler.ts`](./theme-cycler.ts) | `Ctrl+X`로 테마 순환 |
| [`todos.ts`](./todos.ts) | 할 일 관리 UI & 도구 |
| [`upload-image-url.ts`](./upload-image-url.ts) | 이미지 → GitHub 스토리지 업로드 |
| [`voice-input.ts`](./voice-input.ts) | 음성 딕테이션 입력 & TTS 요약 |
| [`working-text.ts`](./working-text.ts) | 스피너 작업 메시지 (재미 텍스트 + 경과 시간) |

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
