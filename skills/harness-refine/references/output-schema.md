# Harness Refine Output Contract

Return one Markdown report. The report is a dry-run proposal, not an applied change.

## Required structure

```markdown
# Harness Refine Report

## Coverage
- Session: <id>
- CWD: <path>
- Active branch: <N entries>
- Analysis cutoff: <cutoff leaf id; excluded N current-turn entries>
- History: <raw_branch | raw_branch_with_compaction_entries>
- Evidence limits: <truncation, missing parent session, parse warnings, or none>

## Session metrics
- Assistant turns: <N>
- Tool calls: <N> (<calls per assistant turn>)
- Tool errors: <N>

| Tool | Calls | Frequency | Errors | Avg duration |
|---|---:|---:|---:|---:|
| ... |

## Candidates

### HR-001 — <short title>
- Target: `project-agents | global-system | skill | memory | subagent`
- Scope: `project | user | global`
- Action: `create | update | merge | delete`
- Target reference: `<path, skill name, memory title/topic, or subagent name>`
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

## Recommendation
- `<highest-value next action; remind that nothing was applied>`
```

## Field rules

- Use stable candidate IDs in report order: `HR-001`, `HR-002`, ...
- Include at most five candidates.
- Session metrics must come from the fixed pre-refine cutoff and should report `pending=0`.
- Every candidate needs at least one concrete transcript entry ID, timestamp, or tool-call ID.
- `Confidence` measures evidence quality, not expected impact.
- `Risk` measures blast radius if the proposal were applied.
- `Proposed change` must be precise enough to apply later without reinterpreting the lesson.
- Keep evidence excerpts short and redact secrets or personal data.
- Do not duplicate the same lesson across multiple targets. Pick the smallest suitable target.
- If no candidate passes the promotion gate, write `No refine-worthy lesson` under Candidates.
- Always include rejected signals when obvious failures or corrections were intentionally not promoted.

## Target mapping

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
