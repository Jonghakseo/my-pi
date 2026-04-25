# my-pi-extension

[pi 코딩 에이전트](https://github.com/mariozechner/pi-coding-agent)용 커스텀 확장 모음.

> 참고: 일부 확장(`codex-fast-mode`, `clipboard`, `ask-user-question`, `auto-name`, `delayed-action`, `idle-screensaver`, `todo-write`, `open-pr`, `generative-ui`, `cross-agent`, `claude-hooks-bridge`, `claude-mcp-bridge`, `memory-layer`, `diff-review`, `claude-spinner`, `cc-system-prompt`, `codex-large-context`)은 이제 로컬 파일이 아니라 설치형 npm 패키지로 사용한다. 나머지 커스텀 확장들도 점진적으로 패키지화해 옮길 계획이다.

## 엔트리포인트 규칙

Pi 공식 문서는 auto-discovery 대상으로 `extensions/*.ts`와 `extensions/*/index.ts`를 모두 지원한다고 설명한다. 이 저장소는 중복 로딩을 피하고 구조를 일관화하기 위해 **모든 로컬 확장을 `extensions/<name>/index.ts` 디렉터리형 엔트리포인트로 관리한다.**

- 새 확장은 root-level `*.ts`로 추가하지 않는다.
- 새 확장은 `extensions/<name>/index.ts`로 추가한다.
- 지원 모듈은 해당 확장 디렉터리 내부 또는 공용 `utils/`에 둔다.

## 대표 확장

| 확장 | 설명 |
|------|------|
| [`subagent/`](./subagent/index.ts) | 서브에이전트 위임 시스템 (프로세스 실행, 세션 관리, 상태 위젯, 서브세션 전용 `ask_master`) |
| [`archive-to-html/`](./archive-to-html/index.ts) | 조건에 맞는 임시 HTML 출력과 `show_widget` 렌더링 자동 아카이브 |
| [`command-typo-assist/`](./command-typo-assist/index.ts) | 슬래시 커맨드 오타 감지 → 제안 + 에디터 프리필 |
| [`diff-overlay/`](./diff-overlay/index.ts) | Diff 뷰어 오버레이 |
| [`dynamic-agents-md/`](./dynamic-agents-md/index.ts) | 디렉토리 스코프별 동적 AGENTS.md 로딩 |
| [`files/`](./files/index.ts) | 파일 피커 / Diff 뷰어 UI |
| [`fork-panel/`](./fork-panel/index.ts) | 현재 세션을 Ghostty split panel로 포크 |
| [`interactive-shell/`](./interactive-shell/index.ts) | 인터랙티브/핸즈프리/디스패치 모드의 셸 오버레이 |
| [`pr-comments/`](./pr-comments/index.ts) | `/github:get-pr-comments` — 현재 PR의 unresolved inline review comment를 에디터에 append |
| [`pr-review-re-request/`](./pr-review-re-request/index.ts) | `/github:pr-review-re-request` — 현재 PR의 미승인 리뷰어에게 review re-request 전송 |
| [`github-pr-merge/`](./github-pr-merge/index.ts) | `/github:pr-merge` — 현재 PR을 gh CLI로 merge |
| [`notify/`](./notify/index.ts) | `/notify`로 세션별 작업 완료 알림(OSC 777/99) + macOS `say` TTS |
| [`footer/`](./footer/index.ts) | 커스텀 푸터 UI facade (`custom-style/main.ts`) |
| [`theme-cycler/`](./theme-cycler/index.ts) | `Ctrl+Shift+X`로 테마 순환 |
| [`until/`](./until/index.ts) | `/until`, `until_report` 기반 반복 작업 관리 |
| [`upload-image-url/`](./upload-image-url/index.ts) | 이미지 → GitHub 스토리지 업로드 |
| [`usage-analytics/`](./usage-analytics/index.ts) | 서브에이전트·스킬 사용 통계 오버레이 |
| [`working-text/`](./working-text/index.ts) | 스피너 작업 메시지 (팁 텍스트 + 경과 시간) |
| [`web-access/`](./web-access/index.ts) | 웹 검색/콘텐츠 추출 도구 및 큐레이터 워크플로우 |

## 기술 스택

- **언어**: TypeScript
- **패키지 매니저**: pnpm
- **린터/포매터**: Biome 2.x
- **테스트 러너**: Vitest 4.x
- **의존성**: `@mariozechner/pi-coding-agent`, `@mariozechner/pi-ai`, `@mariozechner/pi-tui`

## 스크립트

```bash
pnpm run typecheck            # 전체 TypeScript 타입 체크 (web-access 포함)
pnpm run typecheck:web-access # web-access focused 타입 체크
pnpm test                     # extensions/**/*.test.ts 전체 실행
pnpm run test:watch           # Vitest watch
pnpm run test:coverage        # coverage 리포트
pnpm exec biome check .       # Biome 검사만, 파일 변경 없음
pnpm run lint                 # Biome 검사 + 자동 수정(--write)
pnpm run format:write         # Biome 포맷 자동 적용
```

## 안전 리팩토링 체크리스트

확장 엔트리포인트 구조나 타입 계약을 건드린 뒤에는 일반 검사와 함께 isolated headless Pi 로딩 검증을 실행한다.

```bash
cd /Users/creatrip/.pi/agent
tmp=$(mktemp -d)
exts=$(find extensions -mindepth 2 -maxdepth 2 -name index.ts | sort | awk '{printf " -e %s", $0}')
PI_CODING_AGENT_DIR="$tmp" PI_OFFLINE=1 pi -p --no-session --no-tools --offline $exts
code=$?
rm -rf "$tmp"
exit $code
```
