## Plan: set_progress 강제 제거 + thinking 1줄 기반 thoughtText 전환

### Goal
서브에이전트 상태 표시를 `set_progress` 강제 호출 없이 동작하게 만들고, 기존 `progressText`를 thinking 블록 1줄 기반 `thoughtText`로 전환한다.

### Context
- Current state:
  - `set_progress` 강제 규칙은 `progress-widget-enforcer`에서 시스템 프롬프트 주입 + 첫 도구 호출 block으로 구현되어 있음 (`extensions/progress-widget-enforcer.ts:178-182`, `:197-209`).
  - 서브에이전트 쪽 상태 텍스트는 현재 `set_progress` toolCall 인자만 파싱해서 `progressText`에 저장함 (`extensions/subagent/runner.ts:390-395`).
  - 메시지의 thinking 구조는 이미 코드에서 인지 가능함 (`extensions/subagent/replay.ts:90-91`), 하지만 runner의 표시 아이템 수집은 text/toolCall만 포함 (`extensions/subagent/runner.ts:37-43`).
  - `progressText`는 타입/스토어/위젯/완료로그/복원로직 전반에 퍼져 있음 (`extensions/subagent/types.ts:37,66`, `store.ts:98`, `widget.ts:169-171`, `tool-execute.ts:144,521,579,594,659`, `commands.ts:419-425,454,857,927,942,1007`).
- Constraints:
  - 기존 세션 로그(`progressText`, `Result:`/`Progress:`) 복원 호환성을 유지해야 함 (`extensions/subagent/commands.ts:423-425`).
  - 타입 안정성 유지 필요 (`extensions/package.json`의 `typecheck` 스크립트).
  - "thoghtText"는 오타 가능성이 있어, 의도된 스키마명 확정이 선행되어야 함.

### Steps
1. **명명/호환 정책 확정 (`thoughtText` vs `thoghtText`)** — complexity: Low
   - What: 최종 필드명을 확정하고(권장: `thoughtText`), 레거시 입력(`progressText`)을 읽는 기간(브리지 기간) 정책 정의.
   - Where: 설계 결정 후 `extensions/subagent/types.ts`, `commands.ts` 복원 경로 반영.
   - Why: 오타 기반 스키마 확정 시 전체 모듈 불일치/재마이그레이션 리스크가 큼.
   - Risk: 이름을 중간에 바꾸면 상태 메시지(details)와 복원 로직이 어긋날 수 있음.

2. **`set_progress` 강제 규칙 제거 (선택적 도구로 다운그레이드)** — complexity: Medium
   - What: `before_agent_start`의 Progress Protocol 주입 및 `tool_call` block 로직 제거, 관련 상태(`requireInitialProgress`, allowlist 상수) 정리.
   - Where: `extensions/progress-widget-enforcer.ts:10`, `:115`, `:178-209`, `:193-214`, `:227`, `:240`.
   - Why: 더 이상 LLM이 매 턴/첫 턴에 `set_progress`를 호출하도록 강제하지 않기 위함.
   - Risk: 제거 과정에서 위젯 타이머/상태 전환 로직까지 깨질 수 있으므로 hook 단위로 분리 제거 필요.

3. **runner에 thinking 1줄 추출 로직 추가** — complexity: Medium
   - What: assistant `message_end` 수신 시 `part.type === "thinking"`의 `part.thinking`에서 첫 비어있지 않은 줄을 추출해 상태 텍스트 후보로 저장.
   - Where: `extensions/subagent/runner.ts:370-395` (현재 set_progress 파싱 지점), 참조 포맷 `extensions/subagent/replay.ts:90-91`.
   - Why: 상태 텍스트 소스를 toolCall 의존에서 메시지 자체(Thinking) 기반으로 전환.
   - Risk: thinking 첫 줄이 Markdown(`**...**`)이거나 비어있을 수 있음 → 전처리(공백/마크업 최소 정리) 필요.

4. **`progressText` → `thoughtText` 타입/상태/위젯 전파 리네이밍** — complexity: Medium
   - What: 타입(`SingleResult`, `CommandRunState`)과 스토어 업데이트, 위젯 렌더 조건/출력 라벨을 `thoughtText` 기준으로 변경.
   - Where: `extensions/subagent/types.ts:37,66`, `store.ts:98`, `widget.ts:169-171`.
   - Why: 필드 의미를 "진행(progress)"가 아닌 "사고(thought) 1줄"로 명확히 반영.
   - Risk: 일부 경로만 변경되면 위젯이 비거나 타입 에러 발생.

5. **커맨드/툴 완료 메시지 및 세션 복원 경로 이행** — complexity: High
   - What:
     - follow-up details 키를 `thoughtText`로 전환.
     - 사용자 표시 라벨(`Result:`)을 `Thought:`로 변경(상태 메타 라인 한정).
     - 복원 시 `d.thoughtText ?? d.progressText` 우선순위로 읽고, 텍스트 파싱도 `Thought:` + 레거시 `Result:`/`Progress:` 모두 허용.
   - Where:
     - `extensions/subagent/tool-execute.ts:144,521,579,594,659`
     - `extensions/subagent/commands.ts:419-425,454,857,927,942,1007`
   - Why: 신규 실행과 기존 로그 복원 모두 동작해야 런타임/세션 전환 시 상태가 안정적임.
   - Risk: `Result:`는 출력 섹션 헤더(`"Result:"`)와도 겹치므로 파서 조건(공백 포함 prefix)을 유지/강화해야 오탐 방지 가능.

6. **검증 및 회귀 점검** — complexity: Medium
   - What: 타입체크 + 수동 시나리오 점검(툴 경로/커맨드 경로/세션 복원).
   - Where: `extensions/` 루트에서 `pnpm run typecheck`.
   - Why: 변경 범위가 다중 모듈(실행/렌더/복원)에 걸쳐 있어 회귀 위험이 높음.
   - Risk: 비동기 run/세션 전환 경로에서만 드러나는 결함이 있을 수 있음.

### Test Scenarios
- [ ] **강제호출 해제 확인** — expected: `set_progress` 없이 첫 도구 호출이 block되지 않는다 (`progress-widget-enforcer` hook 제거 반영).
- [ ] **thinking 1줄 추출** — expected: 서브에이전트 실행 중/완료 후 위젯 및 상태 로그에 첫 thinking 줄이 `thoughtText`로 표시된다.
- [ ] **thinking 없음 케이스** — expected: `thoughtText`가 비어도 실행/완료/복원에 오류가 없고 기존 lastLine 표시가 유지된다.
- [ ] **레거시 세션 복원** — expected: `progressText` 또는 `Result:`/`Progress:`만 있는 과거 로그도 복원 시 상태 텍스트가 보인다.
- [ ] **신규 세션 복원** — expected: `thoughtText`와 `Thought:` 라벨이 저장/복원되어 동일하게 재표시된다.
- [ ] **툴/커맨드 경로 일관성** — expected: `subagent` tool 실행과 `/sub:*` command 실행 모두 동일한 `thoughtText` 동작을 보인다.

### Edge Cases & Risks
- thinking 첫 줄이 `"**...**"`, 코드펜스, 빈 문자열일 수 있음 → 1줄 추출 후 trim + 최소 정규화 적용.
- 모델/설정에 따라 thinking 파트가 안 올 수 있음 → `thoughtText` optional 유지 + 기존 `lastLine` fallback 유지.
- 내부 reasoning 노출 민감도 이슈 → 길이 제한(예: 80~140자) 및 1줄만 노출로 최소화.
- 필드명 오타(`thoghtText`) 확정 시 장기 유지보수 비용 증가 → 초기 합의 단계에서 final key 고정.

### Dependencies
- 서브에이전트 JSON 이벤트에서 `message_end.message.content[].type === "thinking"`가 제공되어야 함 (현재 replay 코드 기준 지원됨).
- 변경 후 `extensions` 타입체크/리로드 가능 환경 필요 (`pnpm`, `/reload`).

### Estimated Total Effort
중간 난이도, 약 **2~4시간** (리네이밍 범위 + 복원 호환 처리 + 수동 회귀 점검 포함).
