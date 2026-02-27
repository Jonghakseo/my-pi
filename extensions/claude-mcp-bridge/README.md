# Claude MCP Bridge (global pi extension)

Claude Code MCP 설정을 pi에서 재사용하는 전역 브릿지 확장입니다.

## What it does

- MCP 설정 파일 병합 로드
  - 우선순위: `PI_MCP_CONFIG`(단일 파일 강제) 또는 스코프 자동 탐색
  - 스코프 자동 탐색(가까운 경로 우선, 중복 서버명은 첫 항목 우선):
    - `<cwd>/.pi/mcp.json`
    - `<cwd>/.mcp.json`
    - `<cwd>/backend/.mcp.json`
    - `<cwd>/frontend/.mcp.json`
    - 부모 디렉토리로 올라가며 동일 규칙 반복
    - `~/.mcp.json`
    - `~/.claude.json`
- MCP 서버 연결
  - `stdio`
  - `sse`
  - `http` (streamable-http)
- MCP tool을 pi tool로 등록
  - 이름 형식: `mcp_<server>_<tool>`
  - pi 런타임 시작/리로드 시점에 반영
- 상태 표시
  - footer status: `MCP connected/total`
- 명령어
  - `/mcp-status`
  - `/mcp-reload`

## Install (global)

```bash
cd ~/.pi/agent/extensions/claude-mcp-bridge
npm install
```

pi를 어느 프로젝트에서 실행해도 자동 로드됩니다.

## Notes

- 설정의 `${ENV_NAME}` 값은 환경변수로 확장됩니다.
- MCP 설정 변경(서버 추가/삭제/이름 변경) 후에는 `/mcp-reload` 또는 `/reload`를 실행하세요.
