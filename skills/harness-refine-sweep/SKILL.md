---
name: harness-refine-sweep
description: 최근 N일·N시간 동안의 여러 pi 세션을 worker 서브에이전트로 병렬 harness-refine 분석하고 결과를 종합해 durable harness 개선 후보를 도출할 때 사용한다. 사용자가 '최근 세션들 refine 돌려줘', 'refine 스윕', '지난 며칠 세션 시행착오 종합 검토'처럼 요청하면 트리거한다. 현재 세션 하나만 분석할 때는 harness-refine을 사용한다.
---

# harness-refine-sweep

최근 세션들을 병렬로 harness-refine 분석하고 결과를 종합한다. **분석 전용 dry-run**이며 리포트 파일 생성 외에 어떤 파일이나 메모리도 변경하지 않는다.

## Hard Rules

- `edit`, `write`, `remember`, `forget`으로 개선안을 적용하지 않는다. 리포트 저장만 허용된다.
- **서브에이전트 batch를 띄우기 전에 반드시 대상 세션 목록과 예상 worker 수를 보여주고 사용자 승인을 받는다.** 병렬 LLM 실행은 비용이 크다.
- 현재 세션(`PI_SESSION_FILE`)은 분석 대상에서 제외한다 (스크립트가 자동 처리).
- transcript·분석 결과를 외부 서비스로 전송하지 않는다.
- 시크릿·개인정보로 보이는 값은 최종 출력에서 마스킹을 재확인한다.
- worker가 실패한 세션은 결과를 지어내지 않고 실패로 보고한다.

## 경로

- Inspector: 형제 스킬 `../harness-refine/scripts/session_inspect.py` (이 스킬 디렉터리 기준 상대 경로를 절대 경로로 해석)
- Worker 태스크 템플릿: `references/worker-task.md`
- 리포트 루트: `~/.pi/agent/retrospective/refine-reports/`
  - 세션별 리포트(처리 마커 겸용): `refine-reports/sessions/<session-id>.md`
  - 종합 리포트: `refine-reports/SUMMARY-<YYYYMMDD-HHmmss>.md`

## Workflow

### 1. 범위 확정

`/skill:harness-refine-sweep 7일` 처럼 인자가 있으면 기간으로 해석한다. 기본값: 최근 3일, 최소 assistant turn 10, 최대 10개 세션, 최근 12시간 내 상호작용 있던 세션 제외(현재 사용 중일 수 있음, `--min-idle-hours`로 조정).

```bash
python3 scripts/list_sessions.py --days 3 --min-turns 10 --limit 10 --pretty
```

- `--hours N`으로 시간 단위 지정 가능. 이미 리포트가 있는 세션은 자동 스킵된다(재분석은 `--include-processed`).
- 세션 안에서 harness-refine이 이미 실행된 세션(`session_inspect.py summary` 호출 흔적)도 자동 스킵된다(포함하려면 `--include-refined`).
- `total_matched`가 limit보다 크면 사용자에게 알리고 limit 조정 여부를 확인한다.

### 2. 사용자 승인

후보 목록을 표로 보여준다: session id(앞 8자), cwd, mtime, assistant turns, size. 예상 worker 수와 함께 실행 승인을 받는다. 승인 없이는 batch를 띄우지 않는다.

### 3. 병렬 분석 실행

1. `mkdir -p ~/.pi/agent/retrospective/refine-reports/sessions`
2. 세션마다 worker 태스크를 구성한다. 태스크 본문에 apostrophe를 넣지 않는다.

```
subagent batch --isolated \
  --agent worker --task "read <skill-dir>/references/worker-task.md and follow it. TARGET_SESSION=<jsonl abs path> INSPECTOR=<inspector abs path> OUTPUT=<reports>/sessions/<session-id>.md" \
  --agent worker --task "..."
```

3. 한 batch에 worker 최대 5개. 세션이 더 많으면 batch 완료 follow-up을 받은 뒤 다음 batch를 띄운다.
4. 띄운 뒤에는 status 폴링 없이 자동 follow-up을 기다린다.

### 4. 결과 검증

follow-up 수신 후 각 `OUTPUT` 파일 존재와 형식을 확인한다. 누락·실패 세션은 종합 리포트의 Coverage에 실패로 기록한다. 필요하면 실패 worker의 실행 로그를 확인한다.

### 5. 종합 (main agent 수행)

세션별 리포트를 모두 읽고:

1. **De-solutioning**: worker의 Provisional idea를 결론으로 사용하지 않는다. 먼저 구현 방식이 제거된 lesson, evidence, 적용 경계, 기존 workaround만 추출한다.
2. **독립성 기반 병합**: 같은 근본 원인의 lesson을 병합하되 recurrence와 evidence breadth를 분리한다. 같은 기능·diff의 연쇄 실패는 여러 번이어도 `same-feature`이며, 서로 다른 기능·세션·프로젝트인지 확인한다.
3. **Scope ceiling과 Promotion basis 판정**: `same-feature | same-project | cross-project`와 `recurrence | explicit-user | verified-workaround | repeated-workflow | safety-critical`을 별도 축으로 기록한다. scope ceiling을 넘는 target은 좁히거나 hold/reject한다.
4. **기존 harness와 native mechanism 확인**: 관련 후보에 한해 해당 cwd의 `AGENTS.md`, `~/.pi/agent/SYSTEM.md`, 관련 SKILL.md, `recall({ query })` 메모리, `~/.pi/agent/agents/*.md`, repo script·config·CLI·package command를 좁게 확인한다. 기존 mechanism이 충분하면 update/merge하거나 새 후보를 만들지 않는다.
5. **Solution-Fit 후 target 선택**: `../harness-refine/references/output-schema.md`에 따라 smaller alternative, semantic determinism, proportionality, target locality를 판정한다. 사용자 목적이나 암묵적 dependency를 추론해야 하는 static/tool, repo 정책을 하드코딩한 global extension, 구현비가 효과보다 큰 해결책은 Candidate로 승격하지 않는다. 같은 owner·scope·비용 안에서만 `static > tool > instruction > memory`를 tie-breaker로 쓴다.
6. 최종 Candidate는 **최대 5개**다. 가능하지만 근거·정본·비례성이 부족한 것은 `Held ideas`에 재검토 조건과 함께 기록하고, 일시적·중복·과적합 신호는 Rejected signals로 보낸다.
7. **메모리 승격·폐기 검토**: 독립적으로 정당화된 Candidate 또는 이미 검증된 mechanism이 관련 메모리를 온전히 대체하는 경우에만 최대 3개를 제안한다. 메모리 삭제만을 위해 새 enforcement를 만들지 않는다. 순서는 대체 구현 → 검증 → 삭제이며 일부 대체는 split-and-trim으로 제안한다. 없더라도 최종 섹션에 `없음`을 적는다.

### 6. 보고

종합 리포트를 `SUMMARY-<timestamp>.md`로 저장하고 채팅에는 요약을 보여준다.

```markdown
# Refine sweep summary — <기간>

## Coverage
- 대상/성공/실패 세션 수, 스킵 사유별 수, 세션별 리포트 경로

## Candidates (최대 5)
### C1. <lesson>
- Recurrence: N개 세션 (<session-id 앞 8자 목록>)
- Evidence breadth / Promotion basis
- Scope fit / Target locality
- Evidence: <대표 근거>
- Native mechanism considered / Smaller alternative
- Semantic determinism / Proportionality
- Target: <target> (신규 | 기존 update)
- Proposed change: <그대로 적용 검토 가능한 구체안>
- Risk / Confidence

## Held ideas
### H1. <plausible lesson>
- Hold reason: <부족한 근거·정본·deterministic contract·비례성>
- Revisit when: <승격 조건>

## Rejected signals

## Enforcement upgrades (최대 3)
### MU-001. <memory title>
- Current memory: <reference>
- Independent justification: <Candidate ID 또는 이미 검증된 mechanism>
- Replace with: static | tool | instruction → <target>
- Why replacement is sufficient: <의미 손실 없이 memory를 대체하는 이유>
- Proposed replacement: <구체안>
- Validation before deletion: <검증>
- Memory action after validation: delete | split-and-trim

채팅 요약의 마지막에도 `메모리 승격·폐기 제안`을 항상 표시한다. 해당 항목이 없으면 `없음`이라고 쓴다.

어떤 변경도 적용하지 않았습니다. 적용을 원하면 후보 번호를 지정해 주세요.
```

## Validation

- worker의 Provisional idea를 그대로 채택하지 않고 lesson부터 다시 종합했는가
- recurrence와 evidence breadth를 분리했는가
- scope ceiling을 넘는 global target을 좁히거나 hold/reject했는가
- repo script·config·CLI·shell composition 같은 native mechanism을 먼저 확인했는가
- static/tool 후보가 semantic intent를 추론하지 않는 deterministic predicate인가
- 비례성이 excessive인 아이디어를 Candidate로 올리지 않았는가
- global extension에 repo 고유 정책을 하드코딩하지 않았는가
- memory upgrade가 독립 Candidate 또는 기존 mechanism에 연결되었는가
- Candidate, Held ideas, Rejected signals를 구분했는가

## Edge cases

- 후보 세션 0개: 조건(기간·min-turns)을 보여주고 종료한다. 억지로 낮추지 않는다.
- worker 전원 실패: inspector 경로·python3 실행부터 점검하고 사용자에게 보고한다.
- 관련 메모리가 없거나 독립적으로 정당화된 replacement가 없음: `Enforcement upgrades`에 `없음`과 이유를 기록한다.
- 매우 큰 세션(수십 MB)은 worker가 bounded 명령만 쓰므로 그대로 진행하되, 실패 시 해당 세션만 제외하고 계속한다.
- 사용자가 특정 세션·기간·프로젝트(cwd)를 지정하면 그 범위만 분석한다 (cwd 필터는 목록에서 수동 선별).
