---
description: Problem-solving template dedicated to Intent mode. Blueprint-based orchestration, research-first workflow, alternatives analysis, verification, and three HTML deliverables.
---
Solve the problem according to the following procedure and principles.

Primary requirements passed as template arguments (`/one-shot-intent ...`):
$@

Use the requirements above as the work objective and execute the workflow below.

---

## 1. Research First

Complete **sufficient upfront research** before deciding execution direction.

- Explore inside the codebase → `intent({ mode: "run", purpose: "explore", ... })`
- Search external docs/web information → `intent({ mode: "run", purpose: "search", ... })`
- Do not start implementation before research.

---

## 2. Single Task vs Blueprint Decision

When requirements are received, decide **first**.

- **1–2 steps**: run immediately with `intent({ mode: "run", purpose: "...", difficulty: "...", task: "..." })`
- **3+ steps + dependencies**: proceed with the Blueprint workflow below
- **If uncertain**: confirm with `AskUserQuestion` — “Should we do it quickly now, or make a plan first?”

---

## 3. Blueprint Workflow (Complex Work)

### 3-1. Interview (up to 3 rounds)
Use `AskUserQuestion` only for items that directly affect Blueprint design.
- Scope: how far to implement
- Constraints: files/logic that must not be touched
- Priority: what matters most

If enough information is already provided, skip or reduce interview questions.

### 3-2. Blueprint Design
Decompose work as a DAG.

```
Research/Plan nodes → Implement nodes → Verify nodes
```

- `dependsOn`: controls execution order
- `chainFrom`: automatically injects previous node results into the next node
- Run independent nodes in parallel (without dependsOn)
- Challenge gates are **auto-inserted** — if plan/explore → implement exists, Gate 1 is inserted (before implement); if implement → review exists, Gate 2 is inserted (before review). If there are already 2+ challenge nodes, injection is skipped. No manual insertion is needed (except when there are fewer than 3 nodes or custom challenge logic is required)
- Verify nodes are not auto-inserted — include them explicitly
- Keep node count between 3 and 7. If larger, split into sequential Blueprints

### 3-3. Execution
```
create_blueprint → user confirm → run_next (once) → wait for completion
```

Call `run_next` only once; the executor will automatically process subsequent nodes.  
Wait until the `[Intent Blueprint 완료]` notification arrives.

### 3-4. Failure Recovery
- If a node fails → rerun that node with `intent({ mode: "retry_node", blueprintId, nodeId })`
- If the same failure repeats, modify/redesign the Blueprint
- If the same failure happens 2+ times, escalate to the user

---

## 4. Explore Alternatives

Do not converge on a single solution too early. Compare options during design.

- `intent({ mode: "run", purpose: "decide", task: "Compare trade-offs: A vs B" })`
- Prefer approaches with smaller changes and fewer hidden side effects
- Record rejected alternatives in the HTML report as well

---

## 5. Obstacle Handling

Do not give up when blocked. Try workarounds step by step.

1. Check whether alternative tools/CLI can produce the same result
2. Use a `browse` intent to access the web interface directly
3. If no workaround is possible, clearly state constraints and report to the user

---

## 6. Validation

After implementation, **do not declare completion without evidence**.

Run the highest practical verification tier:
- **Tier 1** — automated tests, lint, typecheck (highest reliability)
- **Tier 2** — browser/interactive behavior checks
- **Tier 3** — source analysis + official documentation citations (must be marked PARTIAL)

```
intent({ mode: "run", purpose: "verify", difficulty: "medium", task: "Validate the changes — prioritize Tier 1" })
```

If official documentation cannot be cited, explicitly state that findings are based on source-code analysis.

---

## 7. HTML Report Deliverables (Required)

After completion, generate **three Korean** HTML reports under `~/Documents/`.

Delegate via `implement` intent to a worker using the to-html skill.  
The worker inherits main context, so it can reflect the full work details.

1. **Result Report** — problem understanding process, executed work, and resolution method
2. **Alternatives Report** — considered options, trade-offs, and adoption/rejection rationale
3. **Retrospective Report** — blocking points and improvements for tools/prompts/system elements

---

These instructions are demanding, but fully achievable. I expect a strong result.
