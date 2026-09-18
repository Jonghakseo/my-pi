# Harness Refine Output Contract

결과물은 두 가지다. **풀 리포트는 파일로 저장**하고, **채팅에는 수정 대상·문제·변경안·근거를 설명**한다. 사용자가 리포트를 열지 않아도 적용 여부를 판단할 수 있어야 한다. 둘 다 dry-run 제안이며 적용된 변경이 아니다.

## 리포트 파일

경로: `~/.pi/agent/retrospective/refine-reports/sessions/<session-id>.md` (디렉터리는 `mkdir -p`로 생성)

```markdown
# Harness Refine Report — <session-id>

## Candidates

### HR-001 — <short title>
- Enforcement: `static | tool | instruction | memory`
- Target: `static-enforcement | extension | project-agents | global-system | skill | memory | subagent`
- Scope: `project | user | global`
- Action: `create | update | merge | delete`
- Target reference: `<path, skill name, memory title/topic, subagent name, or extension path>`
- Confidence: `high | medium | low`
- Risk: `low | medium | high`
- Evidence breadth: `same-feature | same-project | cross-project`
- Promotion basis: `[recurrence | explicit-user | verified-workaround | repeated-workflow | safety-critical, ...]`
- Scope fit: `strong | narrowed | exception`
- Target locality: `repo-local | project-shared | global`
- Why this scope: <why the evidence breadth supports this exact target and scope>
- Why not broader: <why a wider target is unsupported, or why broader scope is justified>
- Native mechanism considered: <existing script/config/CLI/skill/instruction/shell composition checked first>
- Smaller alternative: <smaller solution and why it is sufficient or insufficient>
- Semantic determinism: `deterministic | context-dependent`
- Proportionality: `acceptable | excessive`
- Evidence:
  - `<entry id / timestamp / tool call id>: <observed fact>`
- Lesson: <durable generalized lesson>
- Proposed change:
  - <exact draft content or focused patch description>
- Validation:
  - <how a later session can prove the change helps>

## Held ideas

### H-001 — <plausible lesson not ready for implementation>
- Evidence: <what makes it plausible>
- Hold reason: <missing recurrence, policy source, deterministic contract, or acceptable proportionality>
- Revisit when: <specific new evidence that would allow promotion>

`없음` is valid. Held ideas are not Candidates and do not count toward the five-candidate limit.

## Rejected signals
- `<signal>` — `<why it is transient, unsupported, duplicated, overfit, or not reusable>`

## Appendix

### Coverage
- Session: <id>
- CWD: <path>
- Active branch: <N entries>
- Analysis cutoff: <cutoff leaf id; excluded N current-turn entries>
- History: <raw_branch | raw_branch_with_compaction_entries>
- Evidence limits: <truncation, missing parent session, parse warnings, or none>

### Session metrics
- Assistant turns: <N>
- Tool calls: <N> (<calls per assistant turn>)
- Tool errors: <N>

| Tool | Calls | Frequency | Errors | Avg duration |
|---|---:|---:|---:|---:|
| ... |

## Enforcement upgrades

### MU-001 — <memory title>
- Current memory: `<scope/topic/title or memory ID>`
- Independent justification: `<Candidate ID or already-validated mechanism; never invent enforcement only to delete memory>`
- Replace with: `static | tool | instruction` → `<target and target reference>`
- Why replacement is sufficient: <how the independently justified replacement covers the memory without meaning loss>
- Proposed replacement: <focused implementation or patch description>
- Validation before deletion: <proof that the replacement covers the memory's behavior>
- Memory action after validation: `delete | split-and-trim`

`없음 — <why no related memory can be safely replaced>` is valid and must be written when there is no upgrade. This must be the final report section.
```

## 채팅 설명

리포트를 저장한 뒤 아래 형식으로 설명한다. **Coverage, Session metrics, Rejected signals, Evidence ID와 상세 검증 절차는 파일에만 둔다.** 관찰한 실패·성공과 효과의 근거는 짧게 설명에 포함한다.

```markdown
Refine 제안 <N>건. 상세 리포트: <리포트 파일 경로>

### 스킬

**HR-001 <무엇을 바꾸자는지 드러나는 제목>**
- 수정 대상: `<스킬 이름>`의 `<파일/섹션>`. <필요하면 이 대상의 역할 한 문장>
- 문제: <이번에 실제로 생긴 실패나 혼란을 쉬운 말로 설명>
- 바꿀 내용: <현재 방식> 대신 <누가 언제 무엇을 하도록 바꾸는지>.
- 효과를 기대하는 근거: <관찰한 사실> 때문에 <제안한 방식이 실패 원인을 어떻게 줄이는지>. <미검증 부분이 있으면 한계>

### 메모리 승격·폐기 제안

**MU-001 <메모리 제목>**
- 수정 대상: `<기존 메모리>`와 이를 대신할 `<스킬/도구/지침 이름 및 위치>`.
- 문제: <중복이나 강제력 부족 등 실제로 해결할 문제>.
- 바꿀 내용: <대체 수단을 어떻게 만들거나 확인할지>. <검증 조건>을 충족한 뒤 <메모리 전체 삭제 또는 일부 정리>.
- 효과를 기대하는 근거: <대체 수단이 기존 내용을 빠짐없이 보존하거나 더 확실히 지키게 한다고 판단한 이유>.

리포트만 저장했고, 제안은 적용하지 않았습니다. 적용할 후보 번호를 지정해 주세요.
```

### 작성 기준

- Target 종류별로 `스킬`, `익스텐션·도구`, `자동 검사`, `프로젝트 지침`, `전역 지침`, `서브에이전트`, `메모리`처럼 읽기 쉬운 이름으로 묶는다. 후보가 없는 그룹은 생략한다.
- 후보마다 네 항목을 쓰고, 항목당 1~2문장으로 제한한다. 한 줄에 대상·문제·변경·근거를 모두 압축하지 않는다.
- 대상은 `스킬 개선` 같은 종류만 쓰지 말고 이름과 실제 수정할 파일/섹션을 명시한다. 전체 홈 경로 대신 `~`나 저장소 상대 경로를 사용해도 된다.
- 변경은 `점검 강화`, `안정성 개선`으로 끝내지 않는다. 추가·삭제할 규칙이나 실행 순서, 이전과 달라지는 동작을 적는다.
- 근거는 `같은 문제가 반복됐다`를 되풀이하는 문장이 아니다. 무엇을 관찰했고 왜 이 변경이 그 원인을 줄이는지 연결한다. 예를 들어 “수정한 호출자에서는 컴파일 오류가 없어졌다. 같은 유형의 호출자를 처음에 함께 확인하면 뒤늦게 하나씩 발견하는 일을 줄일 수 있다. 재시도 감소 폭은 아직 측정하지 않았다.”처럼 관찰과 예상을 구분한다.
- 내부 용어는 판단에 꼭 필요할 때만 쓰고 짧게 풀어쓴다. 파일명이나 HR 번호만으로 이전 맥락을 기억한다고 가정하지 않는다.
- 메모리 제안도 네 항목으로 설명한다. 삭제만 제안하지 말고 무엇이 그 내용을 대신하며, 무엇을 확인한 뒤 삭제할지 밝힌다.
- 후보가 0개여도 `메모리 승격·폐기 제안`은 마지막 섹션으로 둔다. 해당 항목도 없으면 `없음`이라고 쓴다.

## Field rules

- Use stable candidate IDs in report order: `HR-001`, `HR-002`, ...
- Include at most five candidates.
- Session metrics must come from the fixed pre-refine cutoff and should report `pending=0`.
- Every candidate needs at least one concrete transcript entry ID, timestamp, or tool-call ID.
- `Confidence` measures evidence quality, not expected impact.
- `Risk` measures blast radius if the proposal were applied.
- `Evidence breadth` measures independent applicability only. Multiple findings from one feature remain `same-feature`.
- `Promotion basis` is a separate axis and may contain more than one value. Explicit correction or safety severity does not automatically widen evidence breadth.
- `Scope fit: strong` means the evidence directly supports the final target. `narrowed` means a broader initial idea was reduced to the supported scope. `exception` is reserved for explicit user-wide policy or safety-critical bypass and requires justification.
- `Target locality` describes where the mechanism lives. A project-scoped problem must not be implemented in a global Pi extension merely because the extension checks the cwd.
- `Why this scope` and `Why not broader` are mandatory. Generic wording alone does not justify a global target.
- `Native mechanism considered` and `Smaller alternative` must name concrete existing controls. “No alternative” without inspection is invalid.
- `Semantic determinism: deterministic` is required for new static/tool enforcement. If correctness depends on user intent, task meaning, or inferred dependency, use an explicit workflow contract, instruction, Held idea, or Rejected signal instead.
- `Proportionality: excessive` cannot be a Candidate. Move it to Held ideas when specific future evidence could change the decision; otherwise reject it.
- `Proposed change` must be precise enough to apply later without reinterpreting the lesson.
- Keep evidence excerpts short and redact secrets or personal data.
- Choose the smallest sufficient native mechanism first. Use `static > tool > instruction > memory` only as a tie-breaker between alternatives with the same owner, scope, maintenance cost, and false-positive profile.
- Do not duplicate the same lesson across multiple targets. If a broad procedure fits entirely inside a narrower project candidate, merge it into the project candidate.
- `same-feature` evidence cannot justify global `extension`, user/global `skill`, `subagent`, or `global-system` targets unless an explicit user-wide policy or safety-critical exception independently applies.
- Global extensions additionally require a repo-independent deterministic predicate and must not hardcode project paths, commands, or domain states.
- `Enforcement upgrades` are migration follow-ups and are exempt from the Candidate limit, but each must point to an independently justified Candidate or already-validated mechanism. Never invent enforcement solely to retire memory.
- Never propose deleting a memory before the replacement is implemented and validated. For partial replacement, use `split-and-trim` and preserve the irreducible fact or preference.
- If no candidate passes the promotion and solution-fit gates, write `No refine-worthy lesson` under Candidates.
- Always include Held ideas and Rejected signals when plausible or obvious signals were intentionally not promoted.

## Enforcement tie-breaker

Apply this ordering only after scope, owner, native mechanism, semantic determinism, and proportionality are fixed.

### `static`

Prefer lint rules, type constraints, schemas, tests, CI guards, and configuration validation when a machine can decide pass or fail from explicit inputs with acceptable false positives. Target: `static-enforcement`.

### `tool`

Prefer extensions, scripts, CLI defaults, and generated arguments when the correct action can be embedded deterministically in execution but cannot be expressed as a static pass/fail rule. Target: `extension`.

### `instruction`

Use AGENTS.md, SYSTEM.md, skills, or subagent prompts for semantic judgment and procedures that tools cannot safely decide.

### `memory`

Use only for durable facts, decisions, preferences, and gotchas that must be recalled but cannot be encoded faithfully in stronger enforcement.

## Target mapping

### `static-enforcement`

Use for repository or harness lint rules, type checks, schemas, tests, CI guards, and configuration validators that automatically reject a known bad state. The target reference must name the concrete config or checker path to create or update.

### `project-agents`

Use for repository-specific commands, architecture constraints, validation rules, and workflow policy that future work in the same project should follow.

### `global-system`

Use only for stable behavior required across nearly all projects. Require two independent cross-project cases, an explicit user-wide policy, or a justified safety-critical exception. This target is always high risk.

### `skill`

Use for a repeatable procedure with recognizable inputs, ordered steps, tool guidance, and validation. A lesson is not a skill merely because it involved tools. Project-local evidence should default to a project skill; user/global skill changes require cross-project breadth, explicit user-wide policy, or a justified safety-critical exception.

### `memory`

Use project scope for project facts, decisions, and tool gotchas. Use user scope for durable personal preferences and cross-project rules. Do not store transient task progress.

### `subagent`

Use when a distinct delegated role, prompt contract, or verification responsibility repeatedly improved results. Ordinary one-off delegation does not justify a subagent change. Findings repeated inside one feature do not justify changing a user/global subagent; require cross-project evidence or an explicit user-wide policy.

### `extension`

Use for code or configuration changes to tool execution: repo-local scripts/CLIs, skill helper scripts, or Pi extensions. `Target locality` is mandatory. Prefer repo-local ownership for project policy. A global Pi extension requires cross-project breadth, a repo-independent deterministic predicate, and no semantic inference of user intent or task dependency.
