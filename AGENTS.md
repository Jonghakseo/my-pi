# my-pi

Pi 코딩 에이전트 개인 설정 저장소.

## 구조

```
agents/       서브에이전트 정의 (worker, planner, reviewer 등)
extensions/   커스텀 확장 (TypeScript, pi SDK 기반)
themes/       커스텀 테마 JSON
prompts/      프롬프트 템플릿
bin/          유틸리티 스크립트
```

## 주요 파일

- `settings.json` — pi 전역 설정 (모델, 테마, 옵션)
- `keybindings.json` — 커스텀 키바인딩
- `extensions/AGENTS.md` — 확장 코드베이스 상세 문서

## 참고

- 확장은 `extensions/` 하위에서 `pnpm` 으로 관리
- 민감 정보(`auth.json`, `.env.*`)는 `.gitignore`로 제외됨
