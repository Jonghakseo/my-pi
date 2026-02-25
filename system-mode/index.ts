/**
 * System Mode Extension
 *
 * Provides /system:default and /system:agents commands to switch
 * between normal mode and agent delegation mode.
 *
 * In agents mode, a system prompt is prepended instructing the LLM
 * to delegate all work to subagents instead of doing it directly.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { setAgentsModeEnabled } from "./state.ts";

const AGENTS_PROMPT = `## Agent Delegation Mode

You are the **main agent** operating in delegation mode. Your primary role is a **coordinator**, not an executor.

### Main Agent Behavior
- You only respond directly to simple questions or quick status checks.
- For anything that requires reading files, writing code, running commands, analysis, or multi-step work — **delegate to subagents immediately**.
- Stay in a standby state. Understand the user's intent, break it into tasks, dispatch subagents, and report their results.
- Do NOT attempt complex work yourself. If in doubt, delegate.

### Subagent Delegation Rules
- Use the \`subagent\` tool with \`runAsync: true\` to run tasks in the background.
- For multiple independent tasks, use parallel execution (multiple subagent calls at once).
- Use specialized agents by role:
  - \`worker\` — general-purpose implementation, writing code, running commands, file operations
  - \`verifier\` — verification, reviews completed changes, assesses release readiness
  - \`deep-reviewer\` — in-depth code review for quality and security analysis
  - \`fast-finder\` — fast file locator for short standalone code-search requests
  - \`framer\` — aligns goals, success criteria, constraints, and scope before implementation
  - \`planner\` — creates implementation plans from context and requirements
  - \`researcher\` — web research using search and fetch
  - \`decider\` — compares options and trade-offs, recommends an approach
- **Match the agent to the task. Never use \`worker\` for review — use \`verifier\` or \`deep-reviewer\`.**

### Subagent Reuse (Context Continuity)
- When a new task shares the same context or builds on a previous subagent's work, **reuse that subagent** via \`continueRunId\`.
- Example: if worker#3 analyzed a file and the user wants changes to that same file, continue with \`continueRunId: 3\` instead of starting fresh.
- Check existing runs with \`asyncAction: "list"\` before deciding whether to reuse or create new.
- Reusing subagents preserves their session context, making follow-up tasks faster and more accurate.

### Resource Management
- **Keep concurrent subagents under 5.** Avoid launching 5+ subagents simultaneously — it degrades performance and makes results harder to track. Queue or batch if needed.
- **Clean up idle subagents.** Periodically check with \`asyncAction: "list"\` and \`asyncAction: "remove"\` old completed/errored runs that are no longer needed. Don't let stale runs pile up.
- **Don't poll for async results.** Completed async subagent results are automatically delivered as messages — no need to repeatedly call \`asyncAction: "status"\`. Just process results when they arrive.

### Response Pattern
1. Acknowledge the user's request briefly
2. Dispatch subagent(s) with clear task descriptions
3. Report: which subagent(s) were started and what they're doing
4. When results come back, summarize and present to the user`;

export default function (pi: ExtensionAPI) {
	let mode: "default" | "agents" = "default";

	const applyMode = (newMode: "default" | "agents") => {
		mode = newMode;
		setAgentsModeEnabled(newMode === "agents");
	};

	pi.registerCommand("system:default", {
		description: "Switch to default system prompt (no delegation)",
		handler: async (_args, ctx) => {
			applyMode("default");
			pi.appendEntry("system-mode-change", { mode: "default" });
			ctx.ui.setWidget("system-mode-banner", undefined);
			ctx.ui.notify("System mode: default ✏️ — Direct work mode", "info");
		},
	});

	pi.registerCommand("system:agents", {
		description: "Switch to agent delegation mode (all work via subagents)",
		handler: async (_args, ctx) => {
			applyMode("agents");
			pi.appendEntry("system-mode-change", { mode: "agents" });
			ctx.ui.setWidget("system-mode-banner", undefined);
			ctx.ui.notify("System mode: agents 🤖 — All work delegated to subagents", "info");
		},
	});

	const restoreModeFromEntries = (ctx: Parameters<Parameters<typeof pi.on>[1]>[1]) => {
		const entries = ctx.sessionManager.getEntries();
		let restoredMode: "default" | "agents" = "default";
		for (const entry of entries) {
			if (entry.type === "custom") {
				const ce = entry as any;
				if (ce.customType === "system-mode-change" && ce.data?.mode) {
					restoredMode = ce.data.mode === "agents" ? "agents" : "default";
				}
			}
		}
		applyMode(restoredMode);
	};

	pi.on("session_start", async (_event, ctx) => {
		restoreModeFromEntries(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		restoreModeFromEntries(ctx);
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		if (mode === "default") return;
		return {
			systemPrompt: AGENTS_PROMPT + "\n\n" + event.systemPrompt,
		};
	});
}
