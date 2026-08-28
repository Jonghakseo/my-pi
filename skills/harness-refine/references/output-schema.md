# Harness Refine Output Contract

결과물은 두 가지다. **풀 리포트는 파일로 저장**하고, **채팅에는 요약만 출력**한다. 둘 다 dry-run 제안이며 적용된 변경이 아니다.

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
- Evidence:
  - `<entry id / timestamp / tool call id>: <observed fact>`
- Lesson: <durable generalized lesson>
- Proposed change:
  - <exact draft content or focused patch description>
- Validation:
  - <how a later session can prove the change helps>

## Rejected signals
- `<signal>` — `<why it is transient, unsupported, duplicated, or not reusable>`

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
- Replace with: `static | tool | instruction` → `<target and target reference>`
- Why stronger: <how this prevents or removes reliance on recall>
- Proposed replacement: <focused implementation or patch description>
- Validation before deletion: <proof that the replacement covers the memory's behavior>
- Memory action after validation: `delete | split-and-trim`

`없음 — <why no related memory can be safely replaced>` is valid and must be written when there is no upgrade. This must be the final report section.
```

## 채팅 요약

리포트 저장 후 채팅에는 아래 형식만 출력한다. **Coverage, Session metrics, Rejected signals, Evidence ID, Validation은 채팅에 출력하지 않는다** — 리포트 파일로 충분하다.

```markdown
Refine 제안 <N>건 — 상세: <리포트 파일 경로>

### Memory
- **HR-001 <제목>** — 왜: <증거 요약 한 줄> · 변경: <제안 요약 한 줄>

### Skill
- **HR-002 <제목>** — 왜: ... · 변경: ...

### Static enforcement
- ...

### Extension
- ...

### 메모리 승격·폐기 제안
- **MU-001 <메모리 제목>** — `<대체 enforcement/target>`로 옮겨 검증한 뒤 삭제: <대체안 한 줄>

아무 변경도 적용하지 않았습니다. 적용할 후보 번호를 지정해 주세요.
```

- Target 종류별로 그룹핑하고, 후보가 없는 종류의 헤더는 생략한다.
- 후보당 정확히 한 항목: **제목 + 왜(증거 요약) + 변경(제안 요약)**, 각각 한 줄.
- 후보가 0개여도 `메모리 승격·폐기 제안`은 마지막에 출력한다. 해당 항목도 없으면 `없음`이라고 쓴다.

## Field rules

- Use stable candidate IDs in report order: `HR-001`, `HR-002`, ...
- Include at most five candidates.
- Session metrics must come from the fixed pre-refine cutoff and should report `pending=0`.
- Every candidate needs at least one concrete transcript entry ID, timestamp, or tool-call ID.
- `Confidence` measures evidence quality, not expected impact.
- `Risk` measures blast radius if the proposal were applied.
- `Proposed change` must be precise enough to apply later without reinterpreting the lesson.
- Keep evidence excerpts short and redact secrets or personal data.
- Choose the strongest feasible enforcement in this order: `static > tool > instruction > memory`. If a weaker level is chosen, explain why stronger enforcement is unsafe or cannot express the lesson.
- Do not duplicate the same lesson across multiple targets. Pick the strongest and smallest suitable target.
- `Enforcement upgrades` are migration follow-ups for existing memories, so they are exempt from the one-lesson-one-target rule and the five-candidate limit. Include at most three.
- Never propose deleting a memory before the replacement is implemented and validated. For partial replacement, use `split-and-trim` and preserve the irreducible fact or preference.
- If no candidate passes the promotion gate, write `No refine-worthy lesson` under Candidates.
- Always include rejected signals when obvious failures or corrections were intentionally not promoted.

## Enforcement hierarchy

### `static`

Prefer lint rules, type constraints, schemas, tests, CI guards, and configuration validation when a machine can decide pass or fail with acceptable false positives. Target: `static-enforcement`.

### `tool`

Prefer extensions, scripts, CLI defaults, and generated arguments when the correct action can be embedded in execution but cannot be expressed as a static pass/fail rule. Target: `extension`.

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

Use only for stable behavior required across nearly all projects. Require either two independent pieces of evidence or one explicit high-severity user correction. This target is always high risk.

### `skill`

Use for a repeatable procedure with recognizable inputs, ordered steps, tool guidance, and validation. A lesson is not a skill merely because it involved tools.

### `memory`

Use project scope for project facts, decisions, and tool gotchas. Use user scope for durable personal preferences and cross-project rules. Do not store transient task progress.

### `subagent`

Use when a distinct delegated role, prompt contract, or verification responsibility repeatedly improved results. Ordinary one-off delegation does not justify a subagent change.

### `extension`

Use for code or configuration changes to harness tooling itself — pi extensions (`~/.pi/agent/extensions/`), skill helper scripts (`skills/*/scripts/`), or standalone CLI tools the harness relies on. Choose this when the fix is in tool code/output/options, not in instructions or procedure.
