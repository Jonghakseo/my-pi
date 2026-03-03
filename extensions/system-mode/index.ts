/**
 * System Mode Extension
 *
 * Provides /system:default, /system:agents, and /system:master commands to switch
 * between normal mode, soft delegation mode, and hard delegation-only master mode.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type ExtensionAPI, type ExtensionContext, isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { STATUS_LOG_FOOTER, SUBAGENT_STARTED_STATUS_FOOTER } from "../subagent/constants.ts";
import { SYSTEM_MODE_STATUS_KEY } from "../utils/status-keys.ts";
import { setAgentsModeEnabled } from "./state.ts";

type SystemMode = "default" | "agents" | "master" | "intent";

const STATUS_POLL_WINDOW_MS = 12_000;
const STATUS_POLL_BLOCK_THRESHOLD = 3;
const STATUS_POLL_NOTIFY_COOLDOWN_MS = 30_000;
const FIRST_ASYNC_ABORT_MARKER_ENTRY_TYPE = "system-first-async-abort-triggered";
const FIRST_ASYNC_ABORT_STATE_FILE = path.join(
	os.homedir(),
	".pi",
	"agent",
	"state",
	"system-mode-first-async-abort.json",
);

function normalizeSessionKey(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const cleaned = raw.replace(/[\r\n\t]+/g, "").trim();
	return cleaned || null;
}

function getSessionKey(ctx: ExtensionContext): string | null {
	try {
		const byId = (ctx.sessionManager as any)?.getSessionId?.();
		const normalizedId = normalizeSessionKey(byId);
		if (normalizedId) return `id:${normalizedId}`;
		const byFile = ctx.sessionManager?.getSessionFile?.();
		const normalizedFile = normalizeSessionKey(byFile);
		if (normalizedFile) return `file:${normalizedFile}`;
	} catch {
		/* ignore */
	}
	return null;
}

function loadPersistedFirstAbortSessions(): Set<string> {
	try {
		if (!fs.existsSync(FIRST_ASYNC_ABORT_STATE_FILE)) return new Set();
		const raw = fs.readFileSync(FIRST_ASYNC_ABORT_STATE_FILE, "utf-8");
		const parsed = JSON.parse(raw) as { sessionKeys?: unknown };
		if (!Array.isArray(parsed?.sessionKeys)) return new Set();
		const normalized = parsed.sessionKeys
			.map((value) => normalizeSessionKey(value))
			.filter((value): value is string => Boolean(value));
		return new Set(normalized);
	} catch {
		return new Set();
	}
}

function savePersistedFirstAbortSessions(sessionKeys: Set<string>): void {
	try {
		const parentDir = path.dirname(FIRST_ASYNC_ABORT_STATE_FILE);
		if (!fs.existsSync(parentDir)) {
			fs.mkdirSync(parentDir, { recursive: true });
		}
		const payload = JSON.stringify({ sessionKeys: Array.from(sessionKeys).sort() });
		fs.writeFileSync(FIRST_ASYNC_ABORT_STATE_FILE, payload, "utf-8");
	} catch {
		/* ignore */
	}
}

const PROMPTS_DIR = path.join(import.meta.dirname, "prompts");

function loadPrompt(name: string): string {
	const filePath = path.join(PROMPTS_DIR, `${name}.md`);
	if (!fs.existsSync(filePath)) {
		console.error(`[system-mode] Prompt file not found: ${filePath}`);
		return "";
	}
	const raw = fs.readFileSync(filePath, "utf-8");
	return raw
		.replace(/\{\{STATUS_LOG_FOOTER\}\}/g, STATUS_LOG_FOOTER)
		.replace(/\{\{SUBAGENT_STARTED_STATUS_FOOTER\}\}/g, SUBAGENT_STARTED_STATUS_FOOTER);
}

function modeEmoji(mode: SystemMode): string | undefined {
	if (mode === "agents") return "🤖";
	if (mode === "master") return "👑";
	if (mode === "intent") return "🎯";
	return undefined;
}

function getAllToolNames(pi: ExtensionAPI): string[] {
	return pi.getAllTools().map((tool) => tool.name);
}

/** Memory-layer tools allowed in master mode for cross-session knowledge management. */
const MEMORY_TOOLS = ["remember", "recall", "forget", "memory_list"] as const;

/** Extra tools allowed in intent mode (intent itself is the base dispatch tool, not listed here). */
const INTENT_MODE_EXTRA_TOOLS = ["AskUserQuestion"] as const;

export default function (pi: ExtensionAPI) {
	let mode: SystemMode = "default";
	let activeToolsBeforeMaster: string[] | undefined;
	let masterHardLockEnabled = false;
	let recentStatusPollCalls: number[] = [];
	let lastStatusPollNotifyAt = 0;
	let firstAsyncLaunchAbortTriggeredInSession = false;
	let persistedFirstAbortSessionKeys = loadPersistedFirstAbortSessions();

	const hasPersistedFirstAbortForSession = (ctx: ExtensionContext): boolean => {
		const sessionKey = getSessionKey(ctx);
		if (!sessionKey) return false;
		return persistedFirstAbortSessionKeys.has(sessionKey);
	};

	const persistFirstAbortForSession = (ctx: ExtensionContext): void => {
		const sessionKey = getSessionKey(ctx);
		if (!sessionKey) return;
		if (persistedFirstAbortSessionKeys.has(sessionKey)) return;
		persistedFirstAbortSessionKeys.add(sessionKey);
		savePersistedFirstAbortSessions(persistedFirstAbortSessionKeys);
	};

	const resetStatusPollTracker = () => {
		recentStatusPollCalls = [];
		lastStatusPollNotifyAt = 0;
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
		const isHardMode = newMode === "master" || newMode === "intent";

		if (isHardMode) {
			if (previousMode !== "master" && previousMode !== "intent") {
				activeToolsBeforeMaster = pi.getActiveTools();
			}

			const tools = getAllToolNames(pi);
			// Intent mode dispatches via "intent" tool; master mode via "subagent"
			const baseTool = newMode === "intent" ? "intent" : "subagent";
			if (tools.includes(baseTool)) {
				const allowedTools = [baseTool];
				// list-agents only in master mode; intent mode auto-selects agents
				if (newMode !== "intent" && tools.includes("list-agents")) {
					allowedTools.push("list-agents");
				}
				// Memory tools are allowed in hard modes for cross-session knowledge
				for (const memTool of MEMORY_TOOLS) {
					if (tools.includes(memTool)) {
						allowedTools.push(memTool);
					}
				}
				// Intent mode adds: AskUserQuestion, todo
				if (newMode === "intent") {
					for (const extraTool of INTENT_MODE_EXTRA_TOOLS) {
						if (tools.includes(extraTool)) {
							allowedTools.push(extraTool);
						}
					}
				}
				pi.setActiveTools(allowedTools);
				masterHardLockEnabled = true;
				return;
			}

			masterHardLockEnabled = false;
			if (ctx?.hasUI) {
				ctx.ui.notify(`${newMode} mode warning: "${baseTool}" tool not found. Hard tool lock was disabled.`, "warning");
			}
			return;
		}

		masterHardLockEnabled = false;
		if (previousMode === "master" || previousMode === "intent") {
			const restoreTools =
				activeToolsBeforeMaster && activeToolsBeforeMaster.length > 0 ? activeToolsBeforeMaster : getAllToolNames(pi);
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
			ctx.ui.notify("System mode: default ✏️ - Direct work mode", "info");
		},
	});

	pi.registerCommand("system:agents", {
		description: "Switch to agent delegation mode (all work via subagents)",
		handler: async (_args, ctx) => {
			applyMode("agents", ctx);
			pi.appendEntry("system-mode-change", { mode: "agents" });
			ctx.ui.notify("System mode: agents 🤖 - All work delegated to subagents", "info");
		},
	});

	pi.registerCommand("system:master", {
		description: "Switch to hard master mode (subagent + list-agents tool execution)",
		handler: async (_args, ctx) => {
			applyMode("master", ctx);
			pi.appendEntry("system-mode-change", { mode: "master" });
			ctx.ui.notify("System mode: master 👑 - Hard delegation (subagent + list-agents)", "info");
		},
	});

	pi.registerCommand("system:intent", {
		description: "Switch to intent master mode (Blueprint-driven orchestration via intent tool)",
		handler: async (_args, ctx) => {
			applyMode("intent", ctx);
			pi.appendEntry("system-mode-change", { mode: "intent" });
			ctx.ui.notify("System mode: intent 🎯 - Blueprint-driven orchestration (intent only, subagent blocked)", "info");
		},
	});

	const restoreModeFromEntries = (ctx: Parameters<Parameters<typeof pi.on>[1]>[1]) => {
		resetStatusPollTracker();
		persistedFirstAbortSessionKeys = loadPersistedFirstAbortSessions();
		const entries = ctx.sessionManager.getEntries();
		let restoredMode: SystemMode = "default";
		let abortGuardTriggered = false;
		for (const entry of entries) {
			if (entry.type !== "custom") continue;
			const ce = entry as any;
			if (ce.customType === "system-mode-change" && ce.data?.mode) {
				restoredMode =
					ce.data.mode === "agents" || ce.data.mode === "master" || ce.data.mode === "intent"
						? ce.data.mode
						: "default";
			}
			if (ce.customType === FIRST_ASYNC_ABORT_MARKER_ENTRY_TYPE) {
				abortGuardTriggered = true;
			}
		}
		firstAsyncLaunchAbortTriggeredInSession = abortGuardTriggered || hasPersistedFirstAbortForSession(ctx);
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
		if ((mode !== "master" && mode !== "intent") || !masterHardLockEnabled) return;

		// --- Intent mode: intent is the dispatch tool, subagent is blocked ---
		if (mode === "intent") {
			if (isToolCallEventType("intent", event)) {
				return;
			}
			if (isToolCallEventType("subagent", event)) {
				return {
					block: true,
					reason: "intent 모드에서는 subagent 대신 intent 도구를 사용하세요.",
				};
			}
		}

		// --- Master mode: subagent is the dispatch tool (with polling guard) ---
		if (mode === "master" && isToolCallEventType("subagent", event)) {
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

		// --- list-agents: allowed in master mode only (intent mode auto-selects agents) ---
		if (isToolCallEventType("list-agents", event)) {
			if (mode === "intent") {
				return {
					block: true,
					reason:
						"Intent mode does not allow list-agents. Agent selection is automatic based on purpose/difficulty. Use the intent tool.",
				};
			}
			return;
		}
		// Allow memory-layer tools in hard modes
		for (const memTool of MEMORY_TOOLS) {
			if (isToolCallEventType(memTool, event)) {
				return;
			}
		}
		// Intent mode allows extra tools (AskUserQuestion, todo)
		if (mode === "intent") {
			for (const extraTool of INTENT_MODE_EXTRA_TOOLS) {
				if (isToolCallEventType(extraTool, event)) {
					return;
				}
			}
		}

		// --- Block everything else ---
		const modeLabel = mode === "intent" ? "Intent master" : "Master";
		const allowedLabel =
			mode === "intent"
				? "intent, AskUserQuestion, todo, and memory tools"
				: "subagent, list-agents, and memory tools (remember/recall/forget/memory_list)";
		return {
			block: true,
			reason:
				`${modeLabel} mode hard policy: only ${allowedLabel} can be called by the main agent. ` +
				`Delegate execution through ${mode === "intent" ? "intent" : "subagent"}.`,
		};
	});

	pi.on("tool_result", async (event, ctx) => {
		if (mode !== "master" && mode !== "agents" && mode !== "intent") return;
		if (event.toolName !== "subagent") return;
		if (event.isError) return;
		const input = event.input as Record<string, unknown> | undefined;
		if (!isAsyncSubagentRunLaunch(input)) return;
		if (firstAsyncLaunchAbortTriggeredInSession) return;

		firstAsyncLaunchAbortTriggeredInSession = true;
		// Hard-stop only once per session: immediately after the first async subagent launch.
		// Persist both in-session marker entry and file-backed guard so reload/switch still keeps once-per-session behavior.
		persistFirstAbortForSession(ctx);
		pi.appendEntry(FIRST_ASYNC_ABORT_MARKER_ENTRY_TYPE, { triggeredAt: Date.now(), mode });
		if (ctx.hasUI) {
			ctx.ui.notify("환각 방지: 첫 subagent 호출 이후 메인 응답을 강제 abort합니다.", "info");
		}
		ctx.abort();
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		if (mode === "default") return;
		const modePrompt = loadPrompt(mode); // "agents" | "master"
		if (!modePrompt) return;
		return {
			systemPrompt: modePrompt + "\n\n" + event.systemPrompt,
		};
	});
}
