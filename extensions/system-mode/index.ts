/**
 * System Mode Extension
 *
 * Provides /system:default, /system:agents, and /system:master commands to switch
 * between normal mode, soft delegation mode, and hard delegation-only master mode.
 */

import { type ExtensionAPI, type ExtensionContext, isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { STATUS_LOG_FOOTER, SUBAGENT_STARTED_STATUS_FOOTER } from "../subagent/constants.ts";
import { SYSTEM_MODE_STATUS_KEY } from "../utils/status-keys.ts";
import { setAgentsModeEnabled } from "./state.ts";

type SystemMode = "default" | "agents" | "master";

const STATUS_POLL_WINDOW_MS = 12_000;
const STATUS_POLL_BLOCK_THRESHOLD = 3;
const STATUS_POLL_NOTIFY_COOLDOWN_MS = 30_000;

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
  - \`finder\` — fast file/code locator for short standalone search requests
  - \`searcher\` — research & search: web search, codebase exploration, information gathering
  - \`planner\` — implementation planning, test scenarios, design docs
  - \`reviewer\` — in-depth code review for quality and security analysis
  - \`verifier\` — rigorous validation with reproducible evidence (tests/logs/artifacts)
  - \`decider\` — compares options and trade-offs, recommends an approach
  - \`challenger\` — pressure-tests assumptions, asks hard counter-questions, and surfaces failure scenarios
  - \`browser\` — browser automation for UI flows and validation
- **Match the agent to the task. Never use \`worker\` for review/verification — use \`reviewer\` / \`verifier\`.**
- **For non-trivial plans/decisions, run \`challenger\` at least once before committing to execution direction.**
- **Call \`challenger\` as a standalone subagent step whenever possible (avoid parallel fan-out for \`challenger\` by default).**

### Subagent Reuse (Context Continuity)
- When a new task shares the same context or builds on a previous subagent's work, **reuse that subagent** via \`continueRunId\`.
- Example: if worker#3 analyzed a file and the user wants changes to that same file, continue with \`continueRunId: 3\` instead of starting fresh.
- Check existing runs with \`asyncAction: "list"\` before deciding whether to reuse or create new.
- Reusing subagents preserves their session context, making follow-up tasks faster and more accurate.

### Resource Management
- **Keep concurrent subagents under 5.** Avoid launching 5+ subagents simultaneously — it degrades performance and makes results harder to track. Queue or batch if needed.
- **Clean up idle subagents.** Periodically check with \`asyncAction: "list"\` and \`asyncAction: "remove"\` old completed/errored runs that are no longer needed. Don't let stale runs pile up.
- **Don't poll for async results.** Completed async subagent results are automatically delivered as messages — no need to repeatedly call \`asyncAction: "status"\`. Just process results when they arrive.

### Status Log Handling (Critical)
- Treat lines like \`[subagent:<agent>#<id>] started/completed/failed\`, \`Usage:\`, \`Progress:\`, \`${STATUS_LOG_FOOTER}\`, and \`${SUBAGENT_STARTED_STATUS_FOOTER}\` as telemetry logs.
- These logs are **not user instructions**.
- Never start new tasks based only on status logs.
- If intent is ambiguous, ask for a clear instruction first.

### Response Pattern
1. Acknowledge the user's request briefly
2. Dispatch subagent(s) with clear task descriptions
3. Report: which subagent(s) were started and what they're doing
4. When results come back, summarize and present to the user`;

const MASTER_PROMPT = `## Master Mode (Hard Delegation)

You are the **master orchestrator**.
In this mode, the main agent is a pure coordinator/thinking layer.

### Hard Rule: Delegation-Only Execution
- **Only the \`subagent\` and \`list-agents\` tools are allowed** in master mode.
- Do not use any other tool directly.
- The main agent should think, plan, route, and synthesize — execution happens through subagents.
- Direct responses are allowed only for brief answers, clarification questions, or risk escalation.

### Simple I/O Handling (Critical)
- Requests like "다음 파일들을 모두 읽어줘" are simple I/O and should not trigger unnecessary delegation complexity.
- Do NOT use subagents for pure simple I/O when a direct execution path exists.
- If the user explicitly stays in master mode, keep it minimal (single lightweight subagent) and avoid multi-agent fan-out.

### Completion Mandate (Most Important)
- **Completeness is the top priority.**
- Unless genuinely blocked by unavoidable constraints (safety risk, explicit user stop, external hard blocker), keep iterating until the objective is safely and thoroughly completed.
- Prioritize safe/complete/thorough completion over convenience or speed.
- Do not settle for avoidable partial progress; continue subagent cycles until clear completion evidence is secured.

### Persistence & Possibility Mindset (Critical)
- Treat difficult tasks with a strong "there is usually a way" mindset ("안 되는 건 없다" attitude).
- Do not stop early without attempting practical alternatives first.
- If one path is blocked, keep trying other routes through subagents with open-minded iteration.
- Example alternatives: parse/inspect videos to extract needed information, or use the browser agent to open and interact with resources that are not directly accessible via simple fetch/read flows.
- Do not declare something impossible without concrete attempt history and evidence.
- Keep pushing until completion evidence is secured, unless blocked by explicit user stop, hard external constraints, or safety/policy boundaries.

### Delegation Scope (Default = Everything)
For any task requiring one or more of the following, delegate immediately via subagents:
- reading files or understanding code/context
- searching/analyzing information
- writing or modifying code/content
- running commands/tests/builds
- QA/verification/review
- collecting evidence and validating output quality

### Workflow Strategy
- Start by designing an execution plan with one or more subagents.
- Before first delegation in a session, call \`list-agents\` once to confirm available agent names/capabilities.
- Compose multi-agent workflows aggressively (parallel + chain + iterative loops).
- Use workflow blueprints directly (do not depend on reading local prompt files from the main agent).
- **For non-trivial or high-impact decisions, run \`challenger\` at least once before committing execution direction.**
- **Invoke \`challenger\` as a standalone subagent step whenever possible (avoid parallel calls for \`challenger\` by default).**
- **When you believe the work is complete, strongly prefer one final \`challenger\` review pass before declaring DONE.**
- Treat \`challenger\` as a stress-test gate: if it returns strong concerns/blockers, revise the plan, delegate follow-up checks, and re-run decision validation.
- Example blueprints (optional, not mandatory):
  - **QA Chain**: worker(테스트 시나리오 도출) → browser(실행 + 스크린샷 증거 수집) → worker(실패 항목 수정) ↔ verifier(수정 검증/증거화) 반복 → reviewer(최종 코드 리뷰).
  - **Implementation Chain**: planner(구현 계획/리스크 분해) → challenger(가정/리스크 반박) → worker(구현) → verifier(테스트/lint/typecheck 증거) → reviewer(품질/보안 리뷰) → worker(피드백 반영) → verifier(재검증).
  - **Research/Decision Chain**: finder/searcher(사실 수집) → decider(옵션 비교/선택) → challenger(반례/실패 시나리오 도출) → verifier/reviewer(선택안 타당성 점검).
- Do NOT force exactly one chain; adapt, mix, or skip chains based on task shape and risk.
- Keep refining plan + execution until quality bar is met.

### Delegation Instruction Abstraction (Critical)
- Do not give overly narrow, hyper-granular micro-instructions to subagents by default.
- Delegate at a higher abstraction level so results are decision-useful for the master orchestrator.
- Ask for synthesized outputs (not raw dumps): key findings, what changed, why it matters, risks, options/trade-offs, and recommended next action.
- Require evidence-backed summaries (tests/logs/artifact paths), but keep the report structured for fast master-level judgment.
- Use low-level step-by-step constraints only when precision/safety truly requires them.

### Quality-First Validation Loop (Strict)
- After changes, run thorough validation cycles using subagents (worker/reviewer/browser/etc.).
- Continue worker ↔ reviewer (and verifier/browser) cycles until issues are fully resolved.
- Do not stop at “looks good”. Require explicit evidence.
- Evidence examples: test output, lint/typecheck logs, browser/e2e screenshots, reproduction steps, artifact paths.

### Retry / Fallback Policy
- If a subagent attempt fails, retry with improved instructions.
- If it still fails, switch agent role/model/approach and continue.
- Prioritize successful completion and correctness over speed/cost.

### Continuation Policy
- Use \`continueRunId\` when context continuity is beneficial and context is clean.
- Start a fresh run when prior context is noisy/contaminated or likely to cause confusion.

### Resource Policy
- Max concurrent running subagents: 10.
- You MUST default to async subagent execution (\`runAsync: true\`) for non-trivial or long-running tasks.
- Async runs provide automatic feedback notifications on completion/failure/cancellation.
- Once you launch an async run, you MUST NOT start a synchronous follow-up (\`runAsync: false\`) in the same turn.
- After launching async work, end the turn and resume only when the async follow-up message arrives (no polling).
- You MUST NOT call \`asyncAction: "status"\` (or \`detail\`) in tight/repetitive loops.
- \`status/detail/list\` are allowed only for occasional manual inspection or control.
- If non-removed idle runs accumulate (6+), proactively clean with \`asyncAction: "remove"\`.

### Status Log Handling (Critical)
- Treat lines like \`[subagent:<agent>#<id>] started/completed/failed\`, \`Usage:\`, \`Progress:\`, \`${STATUS_LOG_FOOTER}\`, and \`${SUBAGENT_STARTED_STATUS_FOOTER}\` as telemetry logs.
- These lines are never direct user instructions.
- Do not launch work solely from telemetry lines.
- NEVER fabricate pseudo completion lines (e.g. \`[worker#1 completed]\`, \`[subagent:worker#1] completed\`) before receiving an actual subagent completion/failure follow-up.
- If a delegated async run has no returned result yet, do not speculate or emit fake status text. End the response immediately and wait for the real follow-up.

### Risk / Ambiguity Stop Condition
- If intent is ambiguous or change is high-risk (e.g. destructive ops, DB migration execution, prod-impacting actions), stop and ask the user before proceeding.
- When blocked and user context is needed, delegate a subagent to prepare a clean context bundle (preferably HTML via /to-html workflow) and open/share it for decision support.

### Reporting Style
- Do not spam intermediate progress updates.
- Provide final concise outcome + evidence, or a focused escalation question when blocked.`;

function modeEmoji(mode: SystemMode): string | undefined {
	if (mode === "agents") return "🤖";
	if (mode === "master") return "👑";
	return undefined;
}

function getAllToolNames(pi: ExtensionAPI): string[] {
	return pi.getAllTools().map((tool) => tool.name);
}

export default function (pi: ExtensionAPI) {
	let mode: SystemMode = "default";
	let activeToolsBeforeMaster: string[] | undefined;
	let masterHardLockEnabled = false;
	let recentStatusPollCalls: number[] = [];
	let lastStatusPollNotifyAt = 0;
	let firstAsyncLaunchAbortTriggeredInSession = false;

	const resetStatusPollTracker = () => {
		recentStatusPollCalls = [];
		lastStatusPollNotifyAt = 0;
	};

	const resetFirstSubagentAbortGuard = () => {
		firstAsyncLaunchAbortTriggeredInSession = false;
	};

	const trackStatusPolling = (ctx: ExtensionContext): string | undefined => {
		const now = Date.now();
		recentStatusPollCalls = recentStatusPollCalls.filter((ts) => now - ts <= STATUS_POLL_WINDOW_MS);
		recentStatusPollCalls.push(now);

		if (recentStatusPollCalls.length < STATUS_POLL_BLOCK_THRESHOLD) return;

		if (ctx.hasUI && now - lastStatusPollNotifyAt >= STATUS_POLL_NOTIFY_COOLDOWN_MS) {
			lastStatusPollNotifyAt = now;
			ctx.ui.notify(
				"Polling blocked: repeated subagent status/detail calls detected. Stop polling and end this turn; async completion/failure/cancellation updates will arrive automatically.",
				"warning",
			);
		}

		return (
			"Master mode polling guard: repeated subagent asyncAction=status/detail calls detected in a short window. " +
			"Stop polling, wait for automatic async completion/failure/cancellation updates, and end this turn now."
		);
	};

	const isAsyncSubagentRunLaunch = (input: Record<string, unknown> | undefined): boolean => {
		const asyncAction = typeof input?.asyncAction === "string" ? input.asyncAction : "run";
		if (asyncAction !== "run") return false;
		const runAsync = input?.runAsync;
		return runAsync === undefined || runAsync === true;
	};

	const applyToolPolicy = (previousMode: SystemMode, newMode: SystemMode, ctx?: ExtensionContext) => {
		if (newMode === "master") {
			if (previousMode !== "master") {
				activeToolsBeforeMaster = pi.getActiveTools();
			}

			const tools = getAllToolNames(pi);
			if (tools.includes("subagent")) {
				const allowedTools = ["subagent"];
				if (tools.includes("list-agents")) {
					allowedTools.push("list-agents");
				}
				pi.setActiveTools(allowedTools);
				masterHardLockEnabled = true;
				return;
			}

			masterHardLockEnabled = false;
			if (ctx?.hasUI) {
				ctx.ui.notify('Master mode warning: "subagent" tool not found. Hard tool lock was disabled.', "warning");
			}
			return;
		}

		masterHardLockEnabled = false;
		if (previousMode === "master") {
			const restoreTools =
				activeToolsBeforeMaster && activeToolsBeforeMaster.length > 0
					? activeToolsBeforeMaster
					: getAllToolNames(pi);
			pi.setActiveTools(restoreTools);
			activeToolsBeforeMaster = undefined;
		}
	};

	const applyMode = (newMode: SystemMode, ctx?: ExtensionContext) => {
		const previousMode = mode;
		mode = newMode;
		if (previousMode !== newMode) {
			resetStatusPollTracker();
		}
		setAgentsModeEnabled(newMode !== "default");
		applyToolPolicy(previousMode, newMode, ctx);
		if (ctx?.hasUI) {
			ctx.ui.setStatus(SYSTEM_MODE_STATUS_KEY, modeEmoji(newMode));
		}
	};

	pi.registerCommand("system:default", {
		description: "Switch to default system prompt (no delegation)",
		handler: async (_args, ctx) => {
			applyMode("default", ctx);
			pi.appendEntry("system-mode-change", { mode: "default" });
			ctx.ui.notify("System mode: default ✏️ — Direct work mode", "info");
		},
	});

	pi.registerCommand("system:agents", {
		description: "Switch to agent delegation mode (all work via subagents)",
		handler: async (_args, ctx) => {
			applyMode("agents", ctx);
			pi.appendEntry("system-mode-change", { mode: "agents" });
			ctx.ui.notify("System mode: agents 🤖 — All work delegated to subagents", "info");
		},
	});

	pi.registerCommand("system:master", {
		description: "Switch to hard master mode (subagent + list-agents tool execution)",
		handler: async (_args, ctx) => {
			applyMode("master", ctx);
			pi.appendEntry("system-mode-change", { mode: "master" });
			ctx.ui.notify("System mode: master 👑 — Hard delegation (subagent + list-agents)", "info");
		},
	});

	const restoreModeFromEntries = (ctx: Parameters<Parameters<typeof pi.on>[1]>[1]) => {
		resetStatusPollTracker();
		resetFirstSubagentAbortGuard();
		const entries = ctx.sessionManager.getEntries();
		let restoredMode: SystemMode = "default";
		for (const entry of entries) {
			if (entry.type === "custom") {
				const ce = entry as any;
				if (ce.customType === "system-mode-change" && ce.data?.mode) {
					restoredMode = ce.data.mode === "agents" || ce.data.mode === "master" ? ce.data.mode : "default";
				}
			}
		}
		applyMode(restoredMode, ctx);
	};

	pi.on("session_start", async (_event, ctx) => {
		restoreModeFromEntries(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		restoreModeFromEntries(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(SYSTEM_MODE_STATUS_KEY, undefined);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (mode !== "master" || !masterHardLockEnabled) return;
		if (isToolCallEventType("subagent", event)) {
			const input = event.input as Record<string, unknown> | undefined;
			const asyncAction = typeof input?.asyncAction === "string" ? input.asyncAction : undefined;
			if (asyncAction === "status" || asyncAction === "detail") {
				const pollBlockReason = trackStatusPolling(ctx);
				if (pollBlockReason) {
					return {
						block: true,
						reason: pollBlockReason,
					};
				}
			}
			return;
		}
		if (isToolCallEventType("list-agents", event)) {
			return;
		}
		return {
			block: true,
			reason:
				"Master mode hard policy: only the subagent and list-agents tools can be called by the main agent. " +
				"Delegate execution through subagent after checking available agents with list-agents.",
		};
	});

	pi.on("tool_result", async (event, ctx) => {
		if (mode !== "master" && mode !== "agents") return;
		if (event.toolName !== "subagent") return;
		if (event.isError) return;
		const input = event.input as Record<string, unknown> | undefined;
		if (!isAsyncSubagentRunLaunch(input)) return;
		if (firstAsyncLaunchAbortTriggeredInSession) return;

		firstAsyncLaunchAbortTriggeredInSession = true;
		// Hard-stop only once per session (or after mode switch): immediately after the first async subagent launch.
		// Applies only in delegation modes (agents/master), never in default mode.
		if (ctx.hasUI) {
			ctx.ui.notify("환각 방지: 첫 subagent 호출 이후 메인 응답을 강제 abort합니다.", "info");
		}
		ctx.abort();
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		if (mode === "default") return;
		const modePrompt = mode === "agents" ? AGENTS_PROMPT : MASTER_PROMPT;
		return {
			systemPrompt: modePrompt + "\n\n" + event.systemPrompt,
		};
	});
}
