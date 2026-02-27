# my-pi-extension

[Pi 코딩 에이전트](https://github.com/nicholasgasior/pi-coding-agent)용 커스텀 확장 모음.

## 주요 확장

| 확장 | 설명 |
|------|------|
| `subagent/` | 서브에이전트 위임 시스템 (프로세스 실행, 세션 관리, 위젯) |
| `claude-mcp-bridge/` | Claude Code MCP 설정을 pi에서 재활용 |
| `system-mode/` | 에이전트 모드 온/오프 토글 |
| `ask-user-question.ts` | 옵션 선택 + 자유 입력 질문 도구 |
| `voice-input.ts` | 음성 딕테이션 입력 & TTS 요약 |
| `diff-overlay.ts` | Diff 뷰어 오버레이 |
| `github-overlay.ts` | GitHub PR 뷰 (gh CLI 연동) |
| `minimal-mode.ts` | 도구 출력 접기/펼치기 |
| `session-replay.ts` | 세션 리플레이 뷰어 |
| `theme-cycler.ts` | `Ctrl+X`로 테마 순환 |
| `todos.ts` | 할 일 관리 UI & 도구 |
| `upload-image-url.ts` | 이미지 → GitHub 스토리지 업로드 |

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
