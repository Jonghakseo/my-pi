# Pi Extensions 코드베이스 구조

pi 코딩 에이전트의 **커스텀 확장(extension)** 모음. 모든 확장은 TypeScript로 작성되며 `@mariozechner/pi-coding-agent` API를 사용한다.

## 디렉터리 레이아웃

```
├── subagent/          # 🔑 핵심 — 서브에이전트 위임 시스템 (가장 큰 모듈)
│   ├── index.ts       #   진입점 & 확장 등록
│   ├── commands.ts    #   슬래시 커맨드 & 툴 핸들러
│   ├── tool-execute.ts#   툴 실행 로직
│   ├── tool-render.ts #   툴 호출/결과 렌더링
│   ├── runner.ts      #   프로세스 실행 & 결과 처리
│   ├── session.ts     #   세션 파일 관리 & 컨텍스트
│   ├── replay.ts      #   세션 리플레이 TUI 뷰어
│   ├── agents.ts      #   에이전트 탐색 & 설정
│   ├── widget.ts      #   실행 상태 위젯
│   ├── store.ts       #   공유 상태 저장소
│   ├── types.ts       #   타입 정의 & Typebox 스키마
│   ├── constants.ts   #   상수
│   ├── format.ts      #   포맷팅 유틸
│   └── run-utils.ts   #   실행 관리 유틸
├── claude-mcp-bridge/ # Claude Code MCP 설정을 pi에서 재사용하는 브릿지
│   └── index.ts       #   MCP 설정 병합 로드 & 서버 등록
├── system-mode/       # 시스템 모드 토글 (에이전트 모드 on/off)
│   ├── index.ts       #   모드 전환 로직
│   └── state.ts       #   전역 상태 관리
├── cross-agent.ts     # .claude/.gemini/.codex 디렉터리에서 커맨드/스킬 로드
├── progress-widget-enforcer.ts  # set_progress 툴 강제 주입 (에이전트 모드 연동)
├── delayed-action.ts  # 시간 지연 액션 예약 ("좀 있다가" 스타일)
├── session-replay.ts  # 세션 리플레이 오버레이 UI
├── status-overlay.ts  # /status — 스킬·툴·확장 목록 오버레이
├── pipi-footer.ts     # 커스텀 푸터 UI
├── last-input-widget.ts # 마지막 입력 표시 위젯
├── theme-cycler.ts    # Ctrl+X로 테마 순환
├── themeMap.ts        # 확장별 기본 테마 매핑
└── damage-control-rmrf.ts # rm -rf 안전장치
```

## 핵심 패턴
- **확장 진입점**: 각 `.ts` 파일 또는 `디렉터리/index.ts`가 pi에 자동 로드됨
- **의존성**: `@mariozechner/pi-coding-agent`, `@mariozechner/pi-ai`, `@mariozechner/pi-tui`
- **테마**: `themeMap.ts`에서 확장별 테마를 매핑, `theme-cycler.ts`로 런타임 전환
- **상태 공유**: `system-mode/state.ts`의 에이전트 모드 플래그를 여러 확장이 참조
