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

### 4. Scope Ceiling & Generalization Gate

솔루션이나 target을 고르기 전에 **증거가 허용하는 최대 적용 범위(scope ceiling)**를 정한다. 같은 기능에서 연쇄 결함이 여러 번 발견된 것은 원인에 대한 깊이 증거이지, 일반화의 폭 증거가 아니다.

`Evidence breadth`는 적용 범위만 표현한다.

- `same-feature`: 같은 기능·diff·이슈의 연쇄 발견
- `same-project`: 같은 프로젝트의 서로 다른 기능 또는 세션에서 독립적으로 반복
- `cross-project`: 서로 다른 프로젝트·도메인에서 독립적으로 반복

`Promotion basis`는 별도 축으로 하나 이상 기록한다.

- `recurrence`: 같은 근본 원인의 반복 실패
- `explicit-user`: 사용자가 재사용 가능한 정책·선호를 명시
- `verified-workaround`: 실패 후 성공이 tool result로 검증된 우회책
- `repeated-workflow`: 입력·절차·검증 또는 위임 패턴이 반복
- `safety-critical`: 보안·데이터 손실처럼 단일 사례도 예방 가치가 큰 사건

Scope eligibility:

- 단일 repo에서 나온 신호는 기본적으로 project scope를 넘지 않는다.
- `global-system`, global Pi extension, user/global scope의 `skill`·`subagent`는 원칙적으로 서로 다른 프로젝트의 독립 사례 2건 이상이 필요하다.
- `explicit-user`는 사용자가 전역·반복 정책으로 말한 경우에만 user/global scope 근거가 된다. 현재 작업만 고친 말은 해당하지 않는다.
- `safety-critical`은 단일 사례로 breadth 요구를 우회할 수 있지만, 넓은 예방이 필요한 이유와 오탐 통제를 명시한다.
- `same-feature`는 project scope 후보로 좁히거나 Held ideas·Rejected signals로 보낸다. 반복 횟수만으로 scope ceiling을 올리지 않는다.

Counterfactual scope check:

1. 현재 repo·기능의 고유 명사, ID 형식, 내부 상태명을 제거한다.
2. 같은 프로젝트의 다른 기능에서도 lesson이 유지되는지 먼저 확인한다.
3. 다른 프로젝트에서도 Proposed change가 거의 그대로 유효한지 별도로 확인한다.
4. 추상 문장만 남겨 억지로 일반화하지 않는다. 통과하지 못하면 scope를 좁히거나 hold/reject한다.

Candidate consolidation:

- 넓은 후보의 구체 절차가 더 좁고 타당한 project 후보에 온전히 포함되면 별도 후보로 두지 않고 `merge`한다.
- candidate마다 `Evidence breadth`, `Promotion basis`, `Scope fit`, `Why this scope`, `Why not broader`를 기록한다.

### 5. Promotion Gate

Scope ceiling 안에서 다음 중 하나를 만족해야 lesson을 Candidate 검토 대상으로 올린다.

- 재사용 가능한 명시적 사용자 교정
- 같은 근본 원인의 실패 2회 이상
- tool result로 성공이 검증된 재사용 가능한 우회책
- 반복된 절차 또는 위임 패턴
- 안전상 중요한 단일 실패

“같은 근본 원인의 실패 2회 이상”은 선택된 scope 안에서의 승격 근거일 뿐 evidence breadth를 넓히지 않는다. 각 후보에는 concrete entry id, timestamp, tool call id 중 하나 이상을 포함한다.

근거는 있으나 재발 가능성·정책 정본·구현 타당성이 아직 부족하면 `Held ideas`에 보존하고, 다시 승격할 조건을 적는다. 일시적이거나 잘못된 신호는 Rejected signals에 `overfit`, `insufficient breadth`, `transient`, `duplicated` 등 구체 사유를 남긴다.

### 6. Solution-Fit Gate

Candidate의 lesson과 evidence를 고정한 뒤에만 해결책을 설계한다. 다음 순서를 건너뛰지 않는다.

1. **Native mechanism 확인**: 기존 repo script·config·package command·CLI 오류/옵션, 기존 skill·instruction, shell composition(`&&`, 명시적 cwd), 이미 존재하는 checker 순으로 확인한다.
2. **Semantic determinism 판정**: 위반 여부를 명시적 입력과 로컬 상태만으로 결정할 수 있으면 `deterministic`, 사용자 목적·작업 의미·암묵적 의존성을 추론해야 하면 `context-dependent`로 기록한다.
3. **작은 대안 비교**: 새 static/tool을 만들기 전에 기존 native mechanism 또는 더 좁은 repo-local 변경으로 해결 가능한지 적는다.
4. **비례성 판정**: 재발 빈도·영향과 구현 복잡도·유지비·오탐 비용을 비교해 `acceptable | excessive`로 기록한다.
5. **Hold/Reject**: `context-dependent`인데 명시적 계약이 없거나, 비례성이 `excessive`면 새 static/tool 후보로 만들지 않는다. 명시적 workflow·shell 조합·instruction으로 충분하면 그쪽으로 좁히고, 그렇지 않으면 hold/reject한다.

Global mechanism 추가 조건:

- global Pi extension은 cross-project breadth뿐 아니라 repo 고유명사 없이 판정 가능한 deterministic predicate가 필요하다.
- repo별 정책을 global extension에 하드코딩하지 않는다. 이미 정당화된 범용 opt-in contract가 없는 한 repo-local script·CLI·config를 우선한다.
- semantic dependency를 도구가 추론하게 만들지 않는다. 의존 관계는 `&&`, workflow config, explicit job dependency처럼 호출자가 선언해야 한다.

각 Candidate에 `Native mechanism considered`, `Smaller alternative`, `Semantic determinism`, `Proportionality`를 기록한다.

### 7. Target & Enforcement 선택

`references/output-schema.md`의 Target mapping을 따른다. 먼저 문제를 소유한 위치와 `Target locality`를 정한다.

- `repo-local`: 한 저장소의 script·config·CLI·test·project skill·AGENTS
- `project-shared`: 같은 프로젝트군에서 공유하는 도구·skill
- `global`: 거의 모든 프로젝트에 적용되는 SYSTEM·Pi extension·user/global skill·subagent

그다음 같은 owner·scope·비용의 대안끼리만 enforcement 강도를 tie-breaker로 비교한다.

1. `static`: 기계적으로 참/거짓을 판정하고 허용 가능한 오탐으로 위반을 차단
2. `tool`: 올바른 동작을 실행 경로에 내장
3. `instruction`: semantic judgment나 절차를 모델이 읽고 수행
4. `memory`: static·tool·instruction으로 의미 손실 없이 표현할 수 없는 사실·결정·선호·gotcha

“구현 가능하다”는 이유만으로 더 강하거나 넓은 수단을 선택하지 않는다. 가장 작은 native mechanism이 충분하면 그것을 선택한다. 한 lesson은 한 target에만 제안한다.

### 8. 메모리 승격·폐기 후보 확인

기존 harness 중복 확인 과정에서 조회한 관련 메모리를 다시 검토한다. 메모리 삭제만을 목적으로 새 enforcement를 발명하지 않는다. 독립적으로 정당화된 Candidate 또는 이미 존재하는 mechanism이 메모리를 온전히 대체할 때만 upgrade를 제안한다.

- replacement의 scope ceiling, native mechanism, semantic determinism, proportionality도 Candidate와 같은 기준으로 검토한다.
- 대체 가능하면 `Enforcement upgrades`에 최대 3개를 제안한다.
- 각 upgrade에 `Independent justification`으로 연결된 Candidate ID 또는 이미 검증된 mechanism을 적는다.
- 각 제안은 현재 memory reference, 대체 enforcement/target, 구체적인 대체안, 검증 방법, 메모리 삭제 조건을 포함한다.
- 순서는 항상 **대체 수단 구현 → 검증 → 기존 메모리 삭제**다. 대체 전에 삭제를 제안하지 않는다.
- 일부만 대체 가능하면 메모리 전체 삭제를 제안하지 말고, 대체 가능한 부분만 분리한 뒤 남길 내용을 명시한다.
- 사용자 취향·프로필·역사적 결정처럼 자동 강제하면 의미가 바뀌는 정보는 메모리에 유지한다.
- 해당 항목이 없더라도 최종 섹션을 생략하지 말고 `없음`과 짧은 이유를 적는다.
- 이 섹션은 기존 Candidate의 migration follow-up이며 Candidate 5개 제한이나 한 lesson-one-target 규칙에 포함하지 않는다.

### 9. 보고

`references/output-schema.md` 형식을 정확히 따른다. 보고는 두 단계다.

1. **풀 리포트를 파일로 저장**: `~/.pi/agent/retrospective/refine-reports/sessions/<session-id>.md`
   - 최대 5개 Candidate와 Candidate가 되지 못한 Held ideas를 구분한다. Coverage·Session metrics(도구별 호출·빈도·오류)·Rejected signals는 Appendix에 포함한다.
   - Proposed change는 나중에 그대로 적용 검토할 수 있을 정도로 구체적으로 작성
   - Risk는 적용 시 blast radius, Confidence는 증거 품질로 평가
2. **채팅에는 요약만 출력**: target 종류별 그룹 + 후보당 `제목 — 왜 · 변경` 한 줄씩 + 리포트 경로
   - Coverage, metrics, Rejected signals, Evidence ID는 채팅에 출력하지 않는다
   - 후보 요약 뒤 마지막 섹션으로 `메모리 승격·폐기 제안`을 항상 출력한다. 없으면 `없음`이라고 쓴다.
   - 마지막에 아무 변경도 적용하지 않았음을 명시

## Validation

Scope·solution-fit·target 규칙을 바꿀 때는 [target-selection regression cases](references/eval-cases.md)로 과잉 설계 회귀를 검토한다.

완료 전 확인한다.

- current session ID가 검증되었는가
- refine 호출 전 cutoff leaf를 고정하고 모든 명령에서 재사용했는가
- current inspector 호출이 통계에 포함되지 않았고 `pending=0`인가
- active branch만 분석했는가
- 반복 패턴을 bounded `patterns`로 먼저 좁혔는가
- 오류와 반복 패턴이 tool history로 근거화되었는가
- 기존 harness와 중복을 확인했는가
- target을 고르기 전에 scope ceiling과 Promotion basis를 분리해 기록했는가
- `same-feature` 증거만으로 user/global skill·subagent·system·extension 후보를 만들지 않았는가
- counterfactual scope check를 통과하지 못한 후보를 project scope로 좁히거나 hold/reject했는가
- 기존 native mechanism과 더 작은 대안을 먼저 검토했는가
- static/tool 후보의 predicate가 사용자 의도를 추론하지 않는 deterministic 조건인가
- 구현 복잡도·유지비·오탐 비용 대비 비례성이 acceptable인가
- global extension에 repo 고유 정책을 하드코딩하지 않았는가
- 같은 owner·scope·비용 안에서만 enforcement 강도를 tie-breaker로 사용했는가
- 넓은 후보가 더 좁은 project 후보에 포함될 수 있을 때 별도 후보로 중복하지 않았는가
- 후보가 5개 이하인가
- 각 후보에 검증 방법이 있는가
- 관련 메모리의 승격·폐기 가능성을 검토하고 마지막 섹션에 결과를 남겼는가
- 메모리 upgrade가 독립적으로 정당화된 Candidate 또는 기존 mechanism에 연결되었는가
- 메모리 삭제 제안이 대체 구현과 검증 이후로 순서화되었는가
- transcript의 시크릿·개인정보를 출력하지 않았는가
- 풀 리포트를 파일로 저장하고 채팅에는 요약만 출력했는가
- 리포트 파일 외에 어떤 파일·메모리도 변경하지 않았는가
