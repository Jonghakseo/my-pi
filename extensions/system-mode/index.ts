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
import { isSubagentAsyncLaunchCommand, parseSubagentCommandVerb } from "../subagent/cli.ts";
import { STATUS_LOG_FOOTER, SUBAGENT_STARTED_STATUS_FOOTER } from "../subagent/constants.ts";
import { SYSTEM_MODE_STATUS_KEY } from "../utils/status-keys.ts";
import { setAgentsModeEnabled } from "./state.ts";

type SystemMode = "default" | "agents" | "master";

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
		const byId = (ctx.sessionManager as { getSessionId?: () => unknown })?.getSessionId?.();
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
const TODO_COMPLETION_POLICY = [
	"### Todo Transition Guard",
	"- Todo state changes must be recorded immediately when they happen.",
	"- If a task or phase finishes, your very next action must be `todo_write`.",
	"- Do not retroactively batch-complete multiple tasks at the end.",
	"- In one `todo_write` call, complete at most one task. You may start the next task as `in_progress` in the same call.",
	"- Before giving any completion-style response, check whether `todo_write` still has remaining items.",
	"- If remaining items exist, do not imply that the overall task is finished.",
].join("\n");


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
	return undefined;
}

function getAllToolNames(pi: ExtensionAPI): string[] {
	return pi.getAllTools().map((tool) => tool.name);
}

/** Memory-layer tools allowed in master mode for cross-session knowledge management. */
const MEMORY_TOOLS = ["remember", "recall", "forget", "memory_list"] as const;

/** Lightweight orchestration tools allowed directly in master mode. */
const MASTER_DIRECT_TOOLS = ["list-agents", "read", "find", "grep", "ls", "AskUserQuestion", "todo_write"] as const;

export default function (pi: ExtensionAPI) {
	let mode: SystemMode = "default";
	let activeToolsBeforeMaster: string[] | undefined;
	let masterHardLockEnabled = false;
	let recentStatusPollCalls: number[] = [];
	let lastStatusPollNotifyAt = 0;
	let firstAsyncLaunchAbortTriggeredInSession = false;
	let suppressNextSystemAbortMessage = false;
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
				"Polling blocked: repeated `subagent status/detail` calls detected. Stop polling and end this turn; async completion/failure/cancellation updates will arrive automatically.",
				"warning",
			);
		}

		return (
			"Master mode polling guard: repeated `subagent status/detail` calls detected in a short window. " +
			"Stop polling, wait for automatic async completion/failure/cancellation updates, and end this turn now."
		);
	};

	const isAsyncSubagentRunLaunch = (input: Record<string, unknown> | undefined): boolean => {
		return isSubagentAsyncLaunchCommand(input?.command);
	};

	const applyToolPolicy = (previousMode: SystemMode, newMode: SystemMode, ctx?: ExtensionContext) => {
		const isHardMode = newMode === "master";

		if (isHardMode) {
			if (previousMode !== "master") {
				activeToolsBeforeMaster = pi.getActiveTools();
			}

			const tools = getAllToolNames(pi);
			const baseTool = "subagent";
			if (tools.includes(baseTool)) {
				const allowedTools = [baseTool];
				for (const toolName of MASTER_DIRECT_TOOLS) {
					if (tools.includes(toolName)) {
						allowedTools.push(toolName);
					}
				}
				for (const memTool of MEMORY_TOOLS) {
					if (tools.includes(memTool)) {
						allowedTools.push(memTool);
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
		if (previousMode === "master") {
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
		description: "Switch to hard master mode (subagent + lightweight orchestration tools only)",
		handler: async (_args, ctx) => {
			applyMode("master", ctx);
			pi.appendEntry("system-mode-change", { mode: "master" });
			ctx.ui.notify("System mode: master 👑 - Hard delegation (subagent + read/search/planning helpers)", "info");
		},
	});

	const restoreModeFromEntries = (ctx: Parameters<Parameters<typeof pi.on>[1]>[1]) => {
		resetStatusPollTracker();
		suppressNextSystemAbortMessage = false;
		persistedFirstAbortSessionKeys = loadPersistedFirstAbortSessions();
		const entries = ctx.sessionManager.getEntries();
		let restoredMode: SystemMode = "default";
		let abortGuardTriggered = false;
		for (const entry of entries) {
			if (entry.type !== "custom") continue;
			const ce = entry as { customType?: unknown; data?: { mode?: unknown } };
			if (ce.customType === "system-mode-change" && ce.data?.mode) {
				restoredMode = ce.data.mode === "agents" || ce.data.mode === "master" ? ce.data.mode : "default";
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
		suppressNextSystemAbortMessage = false;
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(SYSTEM_MODE_STATUS_KEY, undefined);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (mode !== "master" || !masterHardLockEnabled) return;

		// --- Master mode: subagent is the dispatch tool (with polling guard) ---
		if (isToolCallEventType("subagent", event)) {
			const input = event.input as Record<string, unknown> | undefined;
			const verb = parseSubagentCommandVerb(input?.command);
			if (verb === "status" || verb === "detail") {
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

		// --- explicitly allowed direct tools in master mode ---
		for (const toolName of MASTER_DIRECT_TOOLS) {
			if (isToolCallEventType(toolName, event)) {
				return;
			}
		}

		for (const memTool of MEMORY_TOOLS) {
			if (isToolCallEventType(memTool, event)) {
				return;
			}
		}

		// --- Block everything else ---
		return {
			block: true,
			reason:
				"Master mode hard policy: only subagent, lightweight orchestration tools (list-agents/read/find/grep/ls/AskUserQuestion/todo_write), and memory tools (remember/recall/forget/memory_list) can be called by the main agent. " +
				"Delegate execution through subagent.",
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
		suppressNextSystemAbortMessage = true;
		persistFirstAbortForSession(ctx);
		pi.appendEntry(FIRST_ASYNC_ABORT_MARKER_ENTRY_TYPE, { triggeredAt: Date.now(), mode });
		if (ctx.hasUI) {
			ctx.ui.notify("환각 방지: 첫 subagent 호출 이후 메인 응답을 강제 abort합니다.", "info");
		}
		ctx.abort();
	});

	pi.on("message_end", async (event, _ctx) => {
		if (!suppressNextSystemAbortMessage) return;
		if (event.message.role !== "assistant") return;
		if (event.message.stopReason !== "aborted") return;

		const hasSubagentToolCall = event.message.content.some(
			(content) => content.type === "toolCall" && content.name === "subagent",
		);
		if (hasSubagentToolCall) {
			event.message.stopReason = "toolUse";
			event.message.errorMessage = undefined;
		}
		suppressNextSystemAbortMessage = false;
	});

	pi.on("agent_end", async () => {
		suppressNextSystemAbortMessage = false;
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		const promptBlocks = [TODO_COMPLETION_POLICY];
		if (mode !== "default") {
			const modePrompt = loadPrompt(mode); // "agents" | "master"
			if (modePrompt) promptBlocks.push(modePrompt);
		}
		return {
			systemPrompt: `${promptBlocks.join("\n\n")}\n\n${event.systemPrompt}`,	
		};
	});
}
