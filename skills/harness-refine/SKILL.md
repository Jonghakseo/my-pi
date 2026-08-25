---
name: harness-refine
description: 현재 Pi 세션의 도구 사용과 시행착오를 분석해 AGENTS.md·SYSTEM.md·스킬·메모리·서브에이전트 개선안을 dry-run으로 제안한다. `/skill:harness-refine` 또는 세션 회고 요청에 사용한다.
disable-model-invocation: true
compatibility: Pi session environment with PI_SESSION_FILE and Python 3.10+.
---

# harness-refine

현재 세션의 시행착오를 durable harness 개선 후보로 변환한다. **분석 전용 dry-run**이며 리포트 파일 저장 외에 어떤 파일이나 메모리도 변경하지 않는다.

## Hard Rules

- `edit`, `write`, `remember`, `forget`으로 개선안을 적용하지 않는다. `~/.pi/agent/retrospective/refine-reports/sessions/<session-id>.md` 리포트 저장만 허용된다.
- `PI_SESSION_FILE`이 없거나 `PI_SESSION_ID`가 일치하지 않으면 중단한다. 최근 파일 추측으로 대체하지 않는다.
- transcript와 분석 결과를 외부 서비스로 전송하지 않는다.
- thinking block, 이미지 데이터, 대형 원문을 결과에 복사하지 않는다.
- 시크릿·토큰·개인정보로 보이는 값은 parser가 마스킹했더라도 최종 출력에서 다시 확인한다.
- 도구 호출 빈도 자체를 문제나 교훈으로 간주하지 않는다. 오류, 사용자 교정, 재시도, 검증 결과와 함께 해석한다.
- refine 실행 중 생성되는 inspector 호출은 분석 대상에서 제외하고 모든 명령이 동일한 cutoff leaf를 사용한다.
- 긴 세션에서 필터 없는 전체 tool history를 출력하지 않는다. `patterns`로 집계한 뒤 `search` 또는 `tools --tool`로 좁힌다.
- assistant의 주장보다 tool result와 사용자 메시지를 우선 증거로 사용한다.
- 개선 가치가 없으면 후보를 억지로 만들지 않는다.

## Session Inspector

이 스킬 디렉터리의 `scripts/session_inspect.py`를 사용한다. 경로는 현재 읽은 `SKILL.md`의 디렉터리를 기준으로 해석한다.

```bash
# 첫 호출에서 analysis.cutoff_leaf_id를 확보한다.
python3 <skill-dir>/scripts/session_inspect.py summary --exclude-current-turn --pretty

# 이후 모든 호출은 같은 cutoff leaf를 사용한다.
python3 <skill-dir>/scripts/session_inspect.py patterns --leaf-id <cutoff> --min-count 2 --examples 2 --example-chars 300 --limit 30 --pretty
python3 <skill-dir>/scripts/session_inspect.py search --leaf-id <cutoff> --errors-only --include-results --limit 50 --max-chars 1200 --pretty
python3 <skill-dir>/scripts/session_inspect.py search --leaf-id <cutoff> --tool bash --query "test" --include-results --pretty
python3 <skill-dir>/scripts/session_inspect.py tools --leaf-id <cutoff> --tool bash --limit 50 --max-chars 600 --pretty
python3 <skill-dir>/scripts/session_inspect.py timeline --leaf-id <cutoff> --limit 300 --max-chars 1200 --pretty
```

### Commands

- `summary`: 세션 메타데이터, active branch 크기, 역할/모델/토큰, 도구별 호출 수·빈도·오류·평균 시간과 async subagent 완료·실패 집계를 반환한다. dispatch tool 성공과 async run 결과는 별도 통계다.
- `patterns`: tool·operation·argument keys별 반복 횟수, 오류, first/last timestamp와 크기가 제한된 argument preview를 반환한다.
- `tools`: 개별 호출 arguments/history를 반환한다. refine workflow에서는 반드시 `--tool`로 범위를 좁힌다.
- `search`: 도구명·arguments·result를 검색한다. `--query`, `--tool`, `--errors-only`, `--include-results`를 조합한다. 결과의 `async_outcomes`에는 subagent dispatch 이후 도착한 완료·실패 알림이 별도로 포함되며, `--tool subagent`로 좁힐 수 있다.
- `timeline`: thinking과 이미지를 제외한 현재 branch의 대화·도구 흐름을 반환한다.
- `--exclude-current-turn`은 최신 user message와 이후 entry를 제외해 자기 관찰 편향을 막는다.
- 모든 command는 `--session <jsonl>`과 `--leaf-id <entry-id>` override를 지원하지만, 사용자가 명시하지 않으면 현재 `PI_SESSION_FILE`만 사용한다.

## Workflow

### 1. 분석 범위 확정

사용자가 `/skill:harness-refine` 뒤에 초점을 적었다면 해당 범위를 우선한다. 초점이 없으면 전체 세션을 분석한다.

먼저 `summary --exclude-current-turn`을 실행하고 응답의 `analysis.cutoff_leaf_id`를 고정한다. 이후 모든 inspector 명령에 `--leaf-id <cutoff>`를 전달한다.

다음을 Coverage와 Session metrics에 보존한다.

- session id, cwd, source leaf, cutoff leaf, 제외된 entry 수, 분석 branch entry 수
- compaction과 parser warning
- assistant turn 수와 model
- 총 tool calls, calls per assistant turn, errors
- 도구별 calls, frequency, errors, average duration

### 2. 증거 수집

고정한 cutoff leaf를 사용해 다음 순서로 필요한 데이터만 확장한다.

1. `search --errors-only --include-results`로 실제 실패를 확인한다.
2. `patterns`로 반복 tool·operation·argument shape을 bounded output으로 확인한다.
3. `timeline`으로 사용자 교정, 재시도 이유, 최종 검증 결과를 연결한다.
4. 특정 절차가 의심될 때만 `search --tool ... --query ... --include-results` 또는 `tools --tool ...`로 좁힌다.

필터 없는 `tools` 호출과 `--limit 0` 전체 덤프는 사용하지 않는다.

후보 신호:

- 사용자가 에이전트 행동이나 가정을 명시적으로 교정함
- 같은 원인의 실패가 두 번 이상 반복됨
- 실패 후 검증된 우회책이 나왔고 다시 쓸 가능성이 있음
- 입력·절차·검증이 반복되는 workflow가 드러남
- 같은 delegation 역할이나 prompt 보정이 반복됨
- 기존 instruction, skill, memory, subagent가 잘못되었다는 검증 결과가 있음
- 단일 사건이라도 보안·데이터 손실 위험이 큼

제외 신호:

- 일회성 작업 상태나 완료 보고
- 단순 tool output 또는 일시적 외부 장애
- 검증되지 않은 원인 추측
- 특정 timestamp, 임시 경로, 단일 PR/이슈에만 묶인 세부사항
- 이미 현재 harness에 같은 의미로 존재하는 규칙

### 3. 기존 Harness와 중복 확인

후보가 생긴 뒤에만 관련 대상을 좁게 확인한다.

- 프로젝트 규칙: session cwd에서 git root까지 적용되는 `AGENTS.md`
- 전역 행동 원칙: `~/.pi/agent/SYSTEM.md`
- 스킬: `~/.pi/agent/skills/`, `~/.agents/skills/`, 프로젝트 `.pi/skills/`, `.agents/skills/`에서 관련 이름/description을 찾고 필요한 `SKILL.md`만 읽는다.
- 메모리: `recall({ query })`로 관련 항목을 찾고 필요한 ID만 펼친다. 메모리 저장 파일을 직접 읽지 않는다.
- 서브에이전트: `~/.pi/agent/agents/*.md`에서 관련 role만 읽는다.

중복이면 새 후보를 만들지 말고 기존 target의 `update` 또는 `merge`로 제안한다.

### 4. 가장 작은 Target 선택

`references/output-schema.md`의 Target mapping을 따른다.

- 프로젝트 한정 규칙 → `project-agents`
- 모든 프로젝트에 적용되는 안정적 행동 원칙 → `global-system`
- 반복 가능한 절차 → `skill`
- 사실·결정·선호·gotcha → `memory`
- 독립적인 위임 역할 → `subagent`
- 익스텐션·스크립트 등 도구 코드 수정 → `extension`

한 lesson을 여러 target에 중복 제안하지 않는다. 가장 좁고 직접적인 대상 하나를 고른다.

### 5. Promotion Gate

다음 중 하나를 만족해야 Candidate로 승격한다.

- 재사용 가능한 명시적 사용자 교정
- 같은 근본 원인의 실패 2회 이상
- tool result로 성공이 검증된 재사용 가능한 우회책
- 반복된 절차 또는 위임 패턴
- 안전상 중요한 단일 실패

각 후보에 concrete entry id, timestamp, tool call id 중 하나 이상을 evidence로 포함한다. 근거가 약하면 Rejected signals로 보낸다.

### 6. 보고

`references/output-schema.md` 형식을 정확히 따른다. 보고는 두 단계다.

1. **풀 리포트를 파일로 저장**: `~/.pi/agent/retrospective/refine-reports/sessions/<session-id>.md`
   - 최대 5개 Candidate, Coverage·Session metrics(도구별 호출·빈도·오류)·Rejected signals는 Appendix에 포함
   - Proposed change는 나중에 그대로 적용 검토할 수 있을 정도로 구체적으로 작성
   - Risk는 적용 시 blast radius, Confidence는 증거 품질로 평가
2. **채팅에는 요약만 출력**: target 종류별 그룹 + 후보당 `제목 — 왜 · 변경` 한 줄씩 + 리포트 경로
   - Coverage, metrics, Rejected signals, Evidence ID는 채팅에 출력하지 않는다
   - 마지막에 아무 변경도 적용하지 않았음을 명시

## Validation

완료 전 확인한다.

- current session ID가 검증되었는가
- refine 호출 전 cutoff leaf를 고정하고 모든 명령에서 재사용했는가
- current inspector 호출이 통계에 포함되지 않았고 `pending=0`인가
- active branch만 분석했는가
- 반복 패턴을 bounded `patterns`로 먼저 좁혔는가
- 오류와 반복 패턴이 tool history로 근거화되었는가
- 기존 harness와 중복을 확인했는가
- 후보가 5개 이하인가
- 각 후보에 검증 방법이 있는가
- transcript의 시크릿·개인정보를 출력하지 않았는가
- 풀 리포트를 파일로 저장하고 채팅에는 요약만 출력했는가
- 리포트 파일 외에 어떤 파일·메모리도 변경하지 않았는가
