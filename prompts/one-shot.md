---
description: Problem-solving template that enforces research, alternatives, verification, broad subagent use, and 3 HTML deliverables
---
To solve the problem, follow the procedures and principles below.

Primary requirement from template arguments (`/one-shot ...`):
$@

Treat the requirement above as the task objective, then execute the workflow below.

<intent_gate>
Before acting, classify the request:

| What they say | What they probably mean | Your move |
|---|---|---|
| "explain X", "how does Y work" | Wants understanding, not changes | explore → synthesize → answer |
| "implement X", "add Y", "create Z" | Wants code changes | plan → delegate or execute |
| "look into X", "check Y" | Wants investigation, not fixes (unless they also say "fix") | explore → report → wait |
| "what do you think about X?" | Wants evaluation before committing | evaluate → propose → wait |
| "X is broken", "seeing error Y" | Wants a minimal fix | diagnose → fix minimally → verify |
| "refactor", "improve", "clean up" | Open-ended — needs scoping first | assess → propose → wait |
| "fix this whole thing" | Multiple issues — wants a thorough pass | assess scope → create todo → work through |

State your interpretation: "I read this as [complexity]-[domain] — [one line plan]." Then proceed.
</intent_gate>

<procedures>
1. Every problem must begin with sufficient and meticulous research to understand the context.
2. There may be multiple ways to solve a problem. Explore alternatives broadly for decision-making, and carefully consider their trade-offs. Smaller changes are better, stronger recurrence prevention is better, and alternatives with fewer hidden side effects are better. However, your chosen approach may not always be correct, so thoroughly validate and re-validate both the selected solution and the alternatives you considered.
3. You can call subagents with virtually unlimited capability. You can provide the main(current) context to subagents as needed, and delegate independent thinking without context(isolated) contamination. There is no risk in calling many diverse subagents, so use them freely and broadly to augment your capabilities. Since they can think on their own, it is more effective to ask for their judgment or explanation than to ask them to return raw output from specific files. However, before launching 3+ parallel subagents, run a single lightweight probe to confirm the approach is viable. If a subagent fails, read the error message, retry once if transient, or pivot to an alternative approach — do not loop on the same failure path more than twice.
4. You may face obstacles while solving the problem. For example, you may need context from a video you cannot read directly, encounter a data source that seems inaccessible, or fail validation because local dependencies are not installed. However, subagents can solve problems that seem unsolvable to you. They can download videos, split them into images, summarize the content for you, use tools that access data sources, and install local dependencies to run a development server. When a tool or MCP does not support the needed capability, try these fallbacks in order: (a) alternative tool/CLI that achieves the same result, (b) browser agent for web-based interfaces, (c) manual workaround with explicit documentation of limitations. Keep this in mind and handle obstacles wisely.
5. Validation is a critical part of problem-solving. This includes quality validation of artifacts such as code, and also securing real execution evidence—such as screenshots and behavior verification using browser agents. Use the highest feasible verification tier: Tier 1 (automated tests/lint/typecheck) → Tier 2 (browser/interactive verification) → Tier 3 (source analysis + official docs, explicitly marked as PARTIAL). When your findings rely on source code analysis or empirical tests alone, strengthen credibility by locating and citing official documentation references (e.g., library docs, specification pages, migration guides). If official docs are unavailable, explicitly state that the evidence is based solely on source code or experimentation. Also, incidental changes beyond the original issue may occur. Ask a reviewer to inspect those areas carefully.
6. For non-trivial work (architectural decisions, 3+ file changes, or 30+ min estimated work), call the challenger subagent at two mandatory gates: (a) before committing to an execution direction, and (b) before declaring completion. For multi-phase work, consider an optional mid-point review. The challenger can ask situation-aware counter-questions, helping you simulate what might have been missed and what a human would ask. For trivial tasks, challenger gates may be skipped.
7. For multi-step work (3+ subagent cycles), produce a brief context checkpoint after each major phase: decisions made, key files/artifacts, remaining risks, and next step. This prevents costly re-exploration when context is truncated in long sessions.
</procedures>

<delegation_protocol>
When delegating to subagents, always use this 6-section structure for exhaustive, unambiguous prompts:

```
1. TASK: Atomic, specific goal
2. EXPECTED OUTCOME: Concrete deliverables with success criteria
3. REQUIRED TOOLS: Explicit tool whitelist
4. MUST DO: Exhaustive requirements — nothing implicit
5. MUST NOT DO: Forbidden actions — anticipate rogue behavior
6. CONTEXT: File paths, existing patterns, constraints
```

Post-delegation: delegation never substitutes for verification. Always verify delegated results yourself.

Session continuity: when following up on a subagent's work, use `continue` with the same session instead of launching fresh. This preserves full context and saves significant tokens.
</delegation_protocol>

<failure_recovery>
If an approach fails after 3 attempts:
1. Stop all edits.
2. Revert to last known working state.
3. Document what was attempted.
4. Try a materially different approach (different algorithm, pattern, or library).
5. If still blocked → ask the user.

Never leave code in a broken state. Never delete failing tests to "pass."
</failure_recovery>

<completeness_contract>
Do not declare completion until ALL of:
- Every planned task/todo item is marked completed
- Diagnostics are clean on all changed files
- Build passes (if applicable)
- The original request is FULLY addressed — not partially, not "you can extend later"
- Any blocked items are explicitly marked [blocked] with what is missing
</completeness_contract>

8. Once the work is completed, you must produce and return HTML deliverables that follow the /skill:to-html specification. You need three deliverables: 1) Final result report: a document that provides a high-level understanding of what thought process you followed, what work you performed, and how you solved the problem. 2) Alternative exploration report: a document describing the alternative options with different trade-offs that were considered, and how the work might have proceeded if those options had been chosen. 3) Retrospective report: a reflection document on what parts were blocked or difficult during execution, and what improvements to tools/system prompts/harness/visibility would have made solving the problem easier. The HTML deliverables must be written in Korean, and you do not need to predefine document paths. Call a worker subagent that inherits the main context and explain the deliverables above. Then ask it to autonomously generate them using the to-html skill. This allows the worker to inherit messages in the main context and produce context-aware deliverables.

This is a difficult set of instructions, but I believe you can do it. Good luck.
