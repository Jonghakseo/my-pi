# Harness Refine Output Contract

결과물은 두 가지다. **풀 리포트는 파일로 저장**하고, **채팅에는 수정 대상·바꿀 내용·근거를 각각 한 줄로 요약**한다. 사용자가 리포트를 열지 않아도 적용 여부를 판단할 수 있어야 한다. 둘 다 dry-run 제안이며 적용된 변경이 아니다.

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

## 채팅 요약

리포트를 저장한 뒤 후보마다 아래 세 줄만 쓴다. 배경 설명, 상세 경로, 로그, 통계, Evidence ID와 검증 절차는 리포트에 둔다.

```markdown
Refine 제안 <N>건. 상세 리포트: <리포트 파일 경로>

**HR-001 <짧은 제목>**
- 수정 대상: 스킬 (<필요할 때만 이름이나 위치>)
- 바꿀 내용: <어떤 규칙이나 동작을 어떻게 바꿀지 한 문장>
- 근거: <관찰한 사실과 기대 효과를 연결한 한 문장>

### 메모리 승격·폐기 제안

**MU-001 <짧은 제목>**
- 수정 대상: 메모리 (<필요할 때만 메모리 이름>)
- 바꿀 내용: <대체 지침·도구가 내용을 보존하는지 확인한 뒤 삭제 또는 일부 정리>
- 근거: <대체 수단으로 충분하다고 판단한 이유 한 문장>

제안은 적용하지 않았습니다. 적용할 후보 번호를 지정해 주세요.
```

### 작성 기준

- 후보 제목 아래에는 `수정 대상`, `바꿀 내용`, `근거`만 각각 한 줄로 쓴다. 별도 `문제` 항목이나 설명 문단은 붙이지 않는다.
- 수정 대상은 `메모리`, `스킬`, `익스텐션`, `도구`, `자동 검사`, `프로젝트 지침`, `전역 지침`, `서브에이전트` 등 종류부터 밝힌다. 이름·파일·섹션은 생략해도 되며, 넣을 때는 괄호 안에 쓴다.
- 종류는 수정 대상 줄에 이미 있으므로 종류별 그룹 제목을 반복하지 않는다.
- 바꿀 내용은 `점검 강화`처럼 추상적으로 쓰지 말고 실제로 추가·삭제할 규칙이나 달라질 동작을 한 문장으로 쓴다.
- 근거는 관찰한 사실이 왜 이 변경을 뒷받침하는지 한 문장으로 연결한다. 관찰된 성공과 아직 검증하지 않은 기대 효과를 구분한다.
- 메모리 제안도 같은 세 줄을 쓴다. 대체 수단과 삭제 전 확인 조건은 `바꿀 내용`에 짧게 포함한다.
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
