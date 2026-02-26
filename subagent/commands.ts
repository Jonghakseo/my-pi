/**
 * Tool handler, slash-command handlers, and event handlers for the Subagent extension.
 *
 * All handlers receive the shared SubagentStore and ExtensionAPI as parameters
 * instead of capturing closure variables — making dependencies explicit.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentScope } from "./agents.js";
import { discoverAgents } from "./agents.js";
import { formatUsageStats, truncateLines } from "./format.js";
import { SubagentSessionReplayOverlay, readSessionReplayItems } from "./replay.js";
import {
	getFinalOutput,
	getLastNonEmptyLine,
	getSubCommandAgentCompletions,
	matchSubCommandAgent,
	runSingleAgent,
} from "./runner.js";
import { buildMainContextText, makeSubagentSessionFile, wrapTaskWithMainContext } from "./session.js";
import { type SubagentStore, truncateText, updateRunFromResult } from "./store.js";
import type { CommandRunState, SingleResult, SubagentDetails } from "./types.js";
import { SubagentParams } from "./types.js";
import { getLatestRun, removeRun, trimCommandRunHistory } from "./run-utils.js";
import { updateCommandRunsWidget } from "./widget.js";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { matchesKey } from "@mariozechner/pi-tui";
import { renderSubagentToolCall, renderSubagentToolResult } from "./tool-render.js";
import { createSubagentToolExecute } from "./tool-execute.js";
import {
	AGENT_SYMBOL_MAP,
	COMMAND_COMPLETION_LIMIT,
	COMMAND_TASK_PREVIEW_CHARS,
	CONTINUATION_OUTPUT_CONTEXT_MAX_CHARS,
	DEFAULT_TURN_COUNT,
	MS_PER_SECOND,
	PARENT_ENTRY_TYPE,
	RUN_OUTPUT_MESSAGE_MAX_CHARS,
	RUN_TICK_INTERVAL_MS,
	STALE_PENDING_COMPLETION_MS,
	STATUS_LOG_FOOTER,
	SUBVIEW_OVERLAY_MAX_HEIGHT,
	SUBVIEW_OVERLAY_WIDTH,
	formatSymbolHints,
} from "./constants.js";

/**
 * Capture switchSession from an ExtensionCommandContext into the shared store.
 * Command handlers receive ExtensionCommandContext (which has switchSession),
 * while input/event handlers only get ExtensionContext (no switchSession).
 * This allows input handlers (<>, ><) to use the captured function as fallback.
 */
function captureSwitchSession(store: SubagentStore, ctx: any): void {
	if (typeof ctx?.switchSession === "function" && !store.switchSessionFn) {
		store.switchSessionFn = ctx.switchSession.bind(ctx);
	}
}

/**
 * Resolve a working switchSession function from either the context or the store.
 * Returns null if neither is available (no command has been run yet).
 */
function resolveSwitchSession(ctx: any, store: SubagentStore): ((sessionPath: string) => Promise<{ cancelled: boolean }>) | null {
	if (typeof ctx?.switchSession === "function") return ctx.switchSession.bind(ctx);
	return store.switchSessionFn;
}

/**
 * Ensure the current session file exists on disk before switching away.
 *
 * pi's SessionManager only flushes JSONL to disk after the session has at least one
 * assistant message. If users run only extension shortcuts/commands in a fresh session,
 * the in-memory session can exist while the file path does not yet exist.
 *
 * To make `><` reliable, materialize the current in-memory entries to the current
 * session path right before `<>` / `/sub:trans` switches into a child session.
 */
function ensureSessionFileMaterialized(ctx: any, sessionFile: string | null): void {
	if (!sessionFile) return;
	const normalized = normalizePath(sessionFile);
	if (!normalized || fs.existsSync(normalized)) return;

	try {
		const rawHeader = ctx.sessionManager?.getHeader?.();
		const header =
			rawHeader && rawHeader.type === "session"
				? rawHeader
				: {
					type: "session",
					version: 3,
					id: ctx.sessionManager?.getSessionId?.() ?? `fallback-${Date.now()}`,
					timestamp: new Date().toISOString(),
					cwd: ctx.sessionManager?.getCwd?.() ?? ctx.cwd ?? process.cwd(),
				};
		const entries = ctx.sessionManager?.getEntries?.();
		const fileEntries = [header, ...(Array.isArray(entries) ? entries : [])];

		const parentDir = path.dirname(normalized);
		if (!fs.existsSync(parentDir)) {
			fs.mkdirSync(parentDir, { recursive: true });
		}
		const content = `${fileEntries.map((e: any) => JSON.stringify(e)).join("\n")}\n`;
		fs.writeFileSync(normalized, content, "utf8");
	} catch (_e) {
		// Ignore materialization errors; fallback messaging will handle missing parent.
	}
}

/**
 * Shared handler for switching to a subagent session (used by both /sub:trans and <>).
 * After a successful switch, persists a `subagent-parent` entry in the child session
 * so that `><` / `sub:back` can navigate back even across pi restarts.
 */
async function subTransHandler(args: string, ctx: any, store: SubagentStore, pi: ExtensionAPI): Promise<void> {
	const raw = (args ?? "").trim();
	let runId: number;
	let run: CommandRunState | undefined;

	if (!raw) {
		// No args: auto-switch to latest completed run
		const latest = getLatestRun(store, ["done", "error"]);
		if (!latest) {
			ctx.ui.notify("No completed runs to switch to.", "info");
			return;
		}
		runId = latest.id;
		run = latest;
	} else {
		runId = parseInt(raw);
		if (isNaN(runId)) {
			ctx.ui.notify("Usage: <> [runId] or /sub:trans <runId>", "error");
			return;
		}
		run = store.commandRuns.get(runId);
	}

	if (!run) {
		ctx.ui.notify(`Run #${runId} not found. Use /sub:open to see recent runs.`, "error");
		return;
	}
	if (run.status === "running") {
		ctx.ui.notify(`Run #${runId} is still running. Wait for it to finish or abort it first.`, "error");
		return;
	}
	if (!run.sessionFile) {
		ctx.ui.notify(`Run #${runId} has no session file.`, "error");
		return;
	}

	const switchFn = resolveSwitchSession(ctx, store);
	if (!switchFn) {
		ctx.ui.notify("Session switch not ready. Run /sub:enable-switch first.", "warning");
		return;
	}

	// Capture current session path before switching — this becomes the parent link.
	const parentSessionFile = normalizePath(ctx.sessionManager.getSessionFile()) ?? undefined;
	ensureSessionFileMaterialized(ctx, parentSessionFile ?? null);

	try {
		const result = await switchFn(run.sessionFile);
		if (result.cancelled) {
			ctx.ui.notify(`Failed to switch to session for run #${runId}.`, "error");
			return;
		}

		// Persist parent link in the child session we just switched into.
		if (parentSessionFile) {
			pi.appendEntry(PARENT_ENTRY_TYPE, {
				parentSessionFile,
				runId,
				via: "<>",
				v: 1,
			});
			store.currentParentSessionFile = parentSessionFile;
			updateCommandRunsWidget(store);
		}
	} catch (err) {
		ctx.ui.notify(`Session switch error: ${err}`, "error");
	}
}

/**
 * Stage A: normalize a path — trim outer whitespace, strip CR/LF/TAB only.
 * Preserves interior spaces (valid in macOS paths).
 */
function normalizePath(raw: unknown): string | null {
	if (!raw || typeof raw !== "string") return null;
	const cleaned = raw.replace(/[\r\n\t]+/g, "").trim();
	return cleaned || null;
}

/**
 * Stage B: compact a path — strip ALL whitespace (repair wrap/corruption artifacts).
 * Only used as fallback when Stage A path does not exist on disk.
 */
function compactPath(raw: unknown): string | null {
	if (!raw || typeof raw !== "string") return null;
	const cleaned = raw.replace(/\s+/g, "").trim();
	return cleaned || null;
}

function stripStatusLogFooter(text: string): string {
	if (!text) return text;
	const doubleBreakSuffix = `\n\n${STATUS_LOG_FOOTER}`;
	if (text.endsWith(doubleBreakSuffix)) return text.slice(0, -doubleBreakSuffix.length);
	const singleBreakSuffix = `\n${STATUS_LOG_FOOTER}`;
	if (text.endsWith(singleBreakSuffix)) return text.slice(0, -singleBreakSuffix.length);
	if (text.endsWith(STATUS_LOG_FOOTER)) return text.slice(0, -STATUS_LOG_FOOTER.length).trimEnd();
	return text;
}

/**
 * Try to resolve a valid on-disk path from a raw value using 2-stage strategy.
 * Returns null when neither stage yields an existing file.
 */
function resolveValidPath(raw: unknown): string | null {
	const stageA = normalizePath(raw);
	if (stageA && fs.existsSync(stageA)) return stageA;
	const stageB = compactPath(raw);
	if (stageB && stageB !== stageA && fs.existsSync(stageB)) return stageB;
	return null;
}

/**
 * Resolve the best parent session path.
 * Uses `store.currentParentSessionFile` first, then rescans session entries as fallback.
 * Applies 2-stage normalization (preserve spaces → compact fallback) and validates existence.
 */
function resolveParentSessionFile(ctx: any, store: SubagentStore): string | null {
	// Primary: in-memory cached value.
	const cached = resolveValidPath(store.currentParentSessionFile);
	if (cached) return cached;

	// Fallback: rescan current session entries for the latest valid parent link.
	try {
		const entries = ctx.sessionManager?.getEntries?.() ?? [];
		let best: string | null = null;
		for (const entry of entries) {
			if ((entry as any).type === "custom" && (entry as any).customType === PARENT_ENTRY_TYPE) {
				const candidate = resolveValidPath((entry as any).data?.parentSessionFile);
				if (candidate) best = candidate;
			}
		}
		if (best) {
			store.currentParentSessionFile = best;
			return best;
		}
	} catch (_e) {
		// Ignore rescan errors; fall through to null.
	}

	return null;
}

/**
 * Shared handler for returning to parent session (used by both /sub:back and ><).
 * Resolves the parent from `store.currentParentSessionFile` (persisted in session entries).
 */
async function subBackHandler(ctx: any, store: SubagentStore): Promise<void> {
	const parentSession = resolveParentSessionFile(ctx, store);
	if (!parentSession) {
		// Clear stale in-memory reference so widget hides the hint.
		if (store.currentParentSessionFile) {
			store.currentParentSessionFile = null;
			updateCommandRunsWidget(store);
		}
		ctx.ui.notify("No parent session (file deleted or not linked).", "info");
		return;
	}

	const switchFn = resolveSwitchSession(ctx, store);
	if (!switchFn) {
		ctx.ui.notify("Session switch not ready. Run /sub:enable-switch first.", "warning");
		return;
	}

	try {
		const result = await switchFn(parentSession);
		if (result.cancelled) {
			ctx.ui.notify("Failed to return to parent session.", "error");
		}
		// Note: currentParentSessionFile will be set correctly by restoreRunsFromSession
		// when the parent session loads (via session_switch event).
	} catch (err) {
		ctx.ui.notify(`Session switch error: ${err}`, "error");
	}
}

/**
 * Clear commandRuns and restore from current session entries.
 * Used by both session_start and session_switch handlers.
 * Also restores `currentParentSessionFile` from the latest `subagent-parent` entry.
 *
 * After restoring session entries, merges any still-running global live runs
 * into commandRuns so they remain visible and controllable across sessions.
 * Also delivers any pending completion messages for runs that finished while
 * the user was in a different session.
 */
function restoreRunsFromSession(store: SubagentStore, ctx: any, pi?: ExtensionAPI): void {
	let currentSessionFile: string | null = null;
	try {
		currentSessionFile = normalizePath(ctx.sessionManager.getSessionFile());
	} catch {
		currentSessionFile = null;
	}

	// Snapshot previous session view before switching away so we can recover
	// transient runs when JSONL persistence lags behind session switching.
	if (store.currentSessionFile && store.currentSessionFile !== currentSessionFile) {
		const snapshot = Array.from(store.commandRuns.values())
			.filter((run) => !run.removed)
			.map((run) => ({ ...run }));
		if (snapshot.length > 0) {
			store.sessionRunCache.set(store.currentSessionFile, snapshot);
		}
	}
	store.currentSessionFile = currentSessionFile;

	store.commandRuns.clear();
	store.commandWidgetCtx = ctx;
	let sawSubagentMarkers = false;

	try {
		const entries = ctx.sessionManager.getEntries();
		const restoredRuns = new Map<number, CommandRunState>();
		const removedRunIds = new Set<number>();
		let maxRunId = 0;

		// Restore parent link from latest subagent-parent entry (if any).
		let latestParentSessionFile: string | null = null;
		for (const entry of entries) {
			if (entry.type === "custom") {
				const ce = entry as any;
				if (ce.customType === PARENT_ENTRY_TYPE) {
					sawSubagentMarkers = true;
					if (ce.data?.parentSessionFile) {
						const cleaned = normalizePath(ce.data.parentSessionFile);
						if (cleaned) latestParentSessionFile = cleaned;
					}
				}
			}
		}
		store.currentParentSessionFile = latestParentSessionFile;

		// First pass: collect removed run IDs
		for (const entry of entries) {
			if (entry.type === "custom") {
				const ce = entry as any;
				if (ce.customType === "subagent-removed") {
					sawSubagentMarkers = true;
					if (ce.data?.runId != null) {
						removedRunIds.add(ce.data.runId);
					}
				}
			}
		}

		for (const entry of entries) {
			if (entry.type !== "custom_message") continue;
			const cm = entry as any;
			if (cm.customType !== "subagent-command" && cm.customType !== "subagent-tool") continue;
			sawSubagentMarkers = true;
			const d = cm.details;
			if (!d || typeof d.runId !== "number") continue;

			const runId = d.runId;
			if (runId > maxRunId) maxRunId = runId;

			const existing = restoredRuns.get(runId);

			// Determine final status primarily from structured metadata.
			const content = typeof cm.content === "string" ? cm.content : "";
			const statusRaw = typeof d.status === "string" ? d.status.trim().toLowerCase() : "";
			const statusFromDetails: "done" | "error" | null =
				statusRaw === "done" || statusRaw === "completed"
					? "done"
					: statusRaw === "error" || statusRaw === "failed"
						? "error"
						: null;
			const statusFromExitCode: "done" | "error" | null =
				typeof d.exitCode === "number" ? (d.exitCode === 0 ? "done" : "error") : null;
			const statusFromErrorField: "done" | "error" | null =
				typeof d.error === "string" && d.error.trim() ? "error" : null;

			// Legacy fallback for old sessions where structured fields are missing.
			const legacyStatusFromContent: "done" | "error" | null = content.includes("] completed")
				? "done"
				: content.includes("] failed") || content.includes("] error")
					? "error"
					: null;

			const finalStatus = statusFromDetails ?? statusFromExitCode ?? statusFromErrorField ?? legacyStatusFromContent;

			if (finalStatus) {
				// Final message — create or overwrite with done/error state
				const run: CommandRunState = {
					id: runId,
					agent: d.agent ?? existing?.agent ?? "unknown",
					task: d.task ?? existing?.task ?? "",
					status: finalStatus,
					startedAt: existing?.startedAt ?? Date.now(),
					elapsedMs: existing?.elapsedMs ?? 0,
					toolCalls: existing?.toolCalls ?? 0,
					lastLine: "",
					lastOutput: "",
					continuedFromRunId: d.continuedFromRunId,
					turnCount: d.turnCount ?? existing?.turnCount ?? DEFAULT_TURN_COUNT,
					sessionFile: d.sessionFile ?? existing?.sessionFile,
					contextMode: d.contextMode ?? existing?.contextMode,
					usage: d.usage ?? existing?.usage,
					model: d.model ?? existing?.model,
					progressText: d.progressText ?? existing?.progressText,
				};
				// Extract progress and output from content payload
				const lines = content.split("\n");
				if (!run.progressText) {
					const progressLine = lines.find((l: string) => l.startsWith("Result: ") || l.startsWith("Progress: "));
					if (progressLine) run.progressText = progressLine.replace(/^(Result|Progress): /, "").trim();
				}
				const bodyStart = lines.findIndex((l: string) => l === "") + 1;
				if (bodyStart > 0 && bodyStart < lines.length) {
					run.lastOutput = stripStatusLogFooter(lines.slice(bodyStart).join("\n"));
					run.lastLine = getLastNonEmptyLine(run.lastOutput);
				}
				restoredRuns.set(runId, run);
			} else {
				// Started/resumed message — always update so we track the latest continuation.
				// If a completion message follows, it will overwrite this.
				// If not (crash/abort), this "interrupted" state persists.
				restoredRuns.set(runId, {
					id: runId,
					agent: d.agent ?? existing?.agent ?? "unknown",
					task: d.task ?? existing?.task ?? "",
					status: "error",
					startedAt: existing?.startedAt ?? Date.now(),
					elapsedMs: existing?.elapsedMs ?? 0,
					toolCalls: existing?.toolCalls ?? 0,
					lastLine: "(interrupted — started but no completion found)",
					lastOutput: existing?.lastOutput,
					continuedFromRunId: d.continuedFromRunId,
					turnCount: d.turnCount ?? existing?.turnCount ?? DEFAULT_TURN_COUNT,
					sessionFile: d.sessionFile ?? existing?.sessionFile,
					contextMode: d.contextMode ?? existing?.contextMode,
					usage: existing?.usage,
					model: existing?.model,
					progressText: d.progressText ?? existing?.progressText,
				});
			}
		}

		for (const [id, run] of restoredRuns) {
			if (removedRunIds.has(id)) continue;
			store.commandRuns.set(id, run);
		}
		if (maxRunId >= store.nextCommandRunId) {
			store.nextCommandRunId = maxRunId + 1;
		}
	} catch (_e) {
		// Silently ignore restore errors — fresh state is fine
	}

	// ── Merge global live runs (origin session only) ────────────────────
	// Only re-integrate runs that originated from the current session.
	// Runs from other sessions stay hidden — they will appear when the
	// user switches back to their origin session.
	const mergeSessionFile = currentSessionFile;
	if (mergeSessionFile) {
		for (const [runId, entry] of store.globalLiveRuns) {
			if (entry.originSessionFile !== mergeSessionFile) continue;
			if (entry.runState.status === "running" && !entry.runState.removed) {
				store.commandRuns.set(runId, entry.runState);
			}
		}
	}

	// ── Deliver pending completions ─────────────────────────────────────
	// If a run finished while the user was in a different session and the
	// user has now switched back to the origin session, deliver the stored
	// completion message via pi.sendMessage().
	if (pi && currentSessionFile) {
		for (const [runId, entry] of store.globalLiveRuns) {
			if (!entry.pendingCompletion) continue;
			if (entry.originSessionFile === currentSessionFile) {
				try {
					pi.sendMessage(entry.pendingCompletion.message, entry.pendingCompletion.options);
				} catch { /* ignore delivery errors */ }
				// Restore the completed run state into commandRuns for display.
				store.commandRuns.set(runId, entry.runState);
				store.globalLiveRuns.delete(runId);
			}
		}
	}

	// ── Evict stale pending completions (memory leak guard) ─────────────
	// If a completed run's pending completion has been sitting for longer
	// than the threshold without the user returning to its origin session,
	// discard it to prevent unbounded memory growth.
	for (const [runId, entry] of store.globalLiveRuns) {
		if (!entry.pendingCompletion) continue;
		if (entry.runState.status === "running") continue;
		const age = Date.now() - (entry.runState.startedAt + entry.runState.elapsedMs);
		if (age > STALE_PENDING_COMPLETION_MS) {
			store.globalLiveRuns.delete(runId);
		}
	}

	updateCommandRunsWidget(store, ctx);
}

export function registerAll(pi: ExtensionAPI, store: SubagentStore): void {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			"Supports background async jobs via runAsync + asyncAction (list/status/detail/abort/remove).",
			"Use contextMode: \"main\" to inherit current main-session context, or \"isolated\" for dedicated sub-session.",
			"Default agent scope is \"user\" (from ~/.pi/agent/agents).",
			"To enable project-local agents in .pi/agents or .claude/agents, set agentScope: \"both\" (or \"project\").",
			"Important: Do NOT keep calling subagent for polling. Async runs push completion/failure/error updates automatically as follow-up messages; status/detail/list is for occasional manual checks only.",
		].join(" "),
		parameters: SubagentParams,

		execute: createSubagentToolExecute(pi, store),

		renderCall: renderSubagentToolCall,

		renderResult: renderSubagentToolResult,
	});

	const subCommand = {
		description:
			"Run a subagent in a dedicated sub-session: /sub:new <agent|alias> <task>, /sub:new <runId> <task>, /sub:new <task> (defaults to worker)",
		getArgumentCompletions: (argumentPrefix) => {
			const trimmedStart = argumentPrefix.trimStart();
			if (trimmedStart.includes(" ")) return null;

			const discovery = discoverAgents(process.cwd(), "user");
			const agentItems = getSubCommandAgentCompletions(discovery.agents, argumentPrefix) ?? [];

			const runItems = Array.from(store.commandRuns.values())
				.sort((a, b) => b.id - a.id)
				.filter((run) => !trimmedStart || run.id.toString().startsWith(trimmedStart))
				.slice(0, COMMAND_COMPLETION_LIMIT)
				.map((run) => ({
					value: `${run.id} `,
					label: `${run.id}`,
					description: `continue ${run.agent}: ${truncateText(run.task, COMMAND_TASK_PREVIEW_CHARS)}`,
				}));

			const merged = [...runItems, ...agentItems];
			return merged.length > 0 ? merged : null;
		},
		handler: async (args, ctx, forceMainContextFromWrapper = false) => {
			captureSwitchSession(store, ctx);
			let input = (args ?? "").trim();
			const usageText =
				"Usage: /sub:run <agent|alias> <task> | /sub:run <runId> <task> | /sub:run <task> | /sub:new <agent|alias> <task> | /sub:new <runId> <task> | /sub:new <task>";
			let forceMainContext = forceMainContextFromWrapper;

			if (input === "--main" || input.startsWith("--main ")) {
				ctx.ui.notify("'--main' 접두어는 사용할 수 없습니다. /sub:run 또는 /sub:new 명령 자체로 컨텍스트를 선택하세요.", "warning");
				return;
			}

			if (!input) {
				ctx.ui.notify(usageText, "info");
				return;
			}

			const agentScope: AgentScope = "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;

			if (agents.length === 0) {
				ctx.ui.notify(
					"No agents found in ~/.pi/agent/agents (sub:new/sub:run uses user scope). Use /subagents both to inspect project agents.",
					"error",
				);
				return;
			}

			const firstSpace = input.indexOf(" ");
			const firstToken = firstSpace === -1 ? input : input.slice(0, firstSpace);
			const continuationRun = /^\d+$/.test(firstToken) ? store.commandRuns.get(Number(firstToken)) : undefined;

			let selectedAgent: string;
			let taskForDisplay: string;
			let taskForAgent: string;
			let continuedFromRunId: number | undefined;
			let sessionFileForRun: string | undefined;

			if (continuationRun) {
				if (firstSpace === -1) {
					ctx.ui.notify(usageText, "info");
					return;
				}

				const targetRunId = Number(firstToken);
				const targetRun = continuationRun;

				if (targetRun.status === "running") {
					ctx.ui.notify(`Subagent #${targetRunId} is already running.`, "warning");
					return;
				}

				const nextInstruction = input.slice(firstSpace + 1).trim();
				if (!nextInstruction) {
					ctx.ui.notify(usageText, "info");
					return;
				}

				const previousAgentName = targetRun.agent;
				const directAgent = agents.find((agent) => agent.name.toLowerCase() === previousAgentName.toLowerCase());
				const fuzzyAgent = matchSubCommandAgent(agents, previousAgentName).matchedAgent;
				selectedAgent = directAgent?.name ?? fuzzyAgent?.name ?? previousAgentName;

				if (!agents.some((agent) => agent.name === selectedAgent)) {
					ctx.ui.notify(
						`Run #${targetRunId} references unknown agent "${previousAgentName}". Use /sub:run <agent> <task> instead.`,
						"error",
					);
					return;
				}

				taskForDisplay = `[continue #${targetRunId}] ${nextInstruction}`;
				continuedFromRunId = targetRunId;
				sessionFileForRun = targetRun.sessionFile;

				if (sessionFileForRun) {
					// True continuation: reuse the same per-run session file.
					taskForAgent = nextInstruction;
				} else {
					// Fallback for older runs that were started in isolated/no-session mode.
					const previousOutputRaw = (targetRun.lastOutput ?? targetRun.lastLine ?? "").trim();
					const previousOutput =
						previousOutputRaw.length > CONTINUATION_OUTPUT_CONTEXT_MAX_CHARS
							? `${previousOutputRaw.slice(0, CONTINUATION_OUTPUT_CONTEXT_MAX_CHARS)}\n... [truncated]`
							: previousOutputRaw;

					taskForAgent = [
						`Continue subagent run #${targetRunId} using the same agent (${selectedAgent}).`,
						`Previous task:\n${targetRun.task}`,
						previousOutput ? `Previous output:\n${previousOutput}` : "Previous output: (not available)",
						`New instruction:\n${nextInstruction}`,
					].join("\n\n");
				}
			} else {
				const { matchedAgent, ambiguousAgents } = matchSubCommandAgent(agents, firstToken);
				let resolvedAgent = matchedAgent;

				if (ambiguousAgents.length > 1) {
					const names = ambiguousAgents.map((agent) => agent.name).join(", ");

					if (firstSpace === -1) {
						ctx.ui.notify(`${usageText}. Ambiguous agent alias "${firstToken}": ${names}.`, "error");
						return;
					}

					// NOTE(user-approved): no-UI 모드에서의 안내 처리 방식은 현재 구현을 유지한다.
					// (headless/RPC 경고 경로 개선은 이번 변경 범위에서 제외)
					if (!ctx.hasUI) {
						ctx.ui.notify(
							`Ambiguous agent alias "${firstToken}": ${names}. Use a longer alias or exact name.`,
							"error",
						);
						return;
					}

					const selectedName = await ctx.ui.select(
						`Ambiguous alias "${firstToken}" — choose subagent`,
						ambiguousAgents.map((agent) => agent.name),
					);
					if (!selectedName) {
						ctx.ui.notify("Subagent selection cancelled.", "info");
						return;
					}

					resolvedAgent = ambiguousAgents.find((agent) => agent.name === selectedName);
					if (!resolvedAgent) {
						ctx.ui.notify("Could not resolve selected subagent.", "error");
						return;
					}
				}

				if (resolvedAgent && firstSpace === -1) {
					ctx.ui.notify(usageText, "info");
					return;
				}

				selectedAgent = resolvedAgent?.name ?? "worker";
				taskForDisplay = resolvedAgent ? input.slice(firstSpace + 1).trim() : input;

				if (!taskForDisplay) {
					ctx.ui.notify(usageText, "info");
					return;
				}

				taskForAgent = taskForDisplay;
			}

			let runId: number;
			let runState: CommandRunState;

			if (continuedFromRunId !== undefined) {
				const existingRun = store.commandRuns.get(continuedFromRunId);
				if (!existingRun) {
					ctx.ui.notify(`Unknown subagent run #${continuedFromRunId}.`, "error");
					return;
				}

				runId = existingRun.id;
				runState = existingRun;
				runState.agent = selectedAgent;
				runState.task = taskForDisplay;
				runState.status = "running";
				runState.startedAt = Date.now();
				runState.elapsedMs = 0;
				runState.toolCalls = 0;
				runState.lastLine = "";
				runState.lastOutput = "";
				runState.continuedFromRunId = continuedFromRunId;
				runState.usage = undefined;
				runState.model = undefined;
				runState.removed = false;
				runState.turnCount = Math.max(DEFAULT_TURN_COUNT, runState.turnCount || DEFAULT_TURN_COUNT) + 1;
				// NOTE(user-approved): continuation 시 기존 context/session을 유지한다.
				// /sub:run 과 /sub:new 간 모드 전환은 기존 run에는 소급 적용하지 않는다.
				runState.contextMode = runState.contextMode ?? (forceMainContext ? "main" : "sub");
				runState.sessionFile = runState.sessionFile ?? sessionFileForRun ?? makeSubagentSessionFile(runId);
				sessionFileForRun = runState.sessionFile;
			} else {
				runId = store.nextCommandRunId++;
				if (forceMainContext) {
					// Extract main session context as text instead of copying the session file.
					// This prevents subagents from inheriting the main agent's persona.
					const subContextText = buildMainContextText(ctx);
					if (subContextText) {
						taskForAgent = wrapTaskWithMainContext(taskForAgent, subContextText);
					} else {
						ctx.ui.notify(
							"Main session context is unavailable in this mode. Running with dedicated sub-session.",
							"warning",
						);
						forceMainContext = false;
					}
					sessionFileForRun = makeSubagentSessionFile(runId);
				} else {
					sessionFileForRun = makeSubagentSessionFile(runId);
				}

				runState = {
					id: runId,
					agent: selectedAgent,
					task: taskForDisplay,
					status: "running",
					startedAt: Date.now(),
					elapsedMs: 0,
					toolCalls: 0,
					lastLine: "",
					lastOutput: "",
					continuedFromRunId,
					turnCount: DEFAULT_TURN_COUNT,
					sessionFile: sessionFileForRun,
					removed: false,
					contextMode: forceMainContext ? "main" : "sub",
				};
				store.commandRuns.set(runId, runState);
			}

			const abortController = new AbortController();
			runState.abortController = abortController;

			// Register in global live run registry (survives session switches).
			let originSessionFile = "";
			try {
				originSessionFile = normalizePath(ctx.sessionManager.getSessionFile()) ?? "";
			} catch { /* ignore */ }
			store.globalLiveRuns.set(runId, {
				runState,
				abortController,
				originSessionFile,
			});

			store.commandWidgetCtx = ctx;
			updateCommandRunsWidget(store, ctx);

			const makeDetails = (results: SingleResult[]): SubagentDetails => ({
				mode: "single",
				agentScope,
				inheritMainContext: runState.contextMode === "main",
				projectAgentsDir: discovery.projectAgentsDir,
				results,
			});

			const contextLabel = runState.contextMode === "main" ? "main context" : "dedicated sub-session";
			const startedState = continuedFromRunId !== undefined ? "resumed" : "started";

			pi.sendMessage(
				{
					customType: "subagent-command",
					content:
						`[subagent:${selectedAgent}#${runId}] ${startedState}` +
						`\n${truncateLines(taskForDisplay, 2)}` +
						`\nContext: ${contextLabel} · turn ${runState.turnCount}` +
						`\n\n${STATUS_LOG_FOOTER}`,
					display: true,
					details: {
						runId,
						agent: selectedAgent,
						task: taskForDisplay,
						continuedFromRunId,
						turnCount: runState.turnCount,
						contextMode: runState.contextMode,
						sessionFile: runState.sessionFile,
						status: startedState,
						progressText: runState.progressText,
					},
				},
				{ deliverAs: "followUp", triggerTurn: false },
			);

			ctx.ui.notify(
				(continuedFromRunId !== undefined
					? `Resumed subagent #${runId}: ${selectedAgent}`
					: `Started subagent #${runId}: ${selectedAgent}`) +
					` (${contextLabel} · turn ${runState.turnCount})`,
				"info",
			);

			const tick = setInterval(() => {
				const current = store.commandRuns.get(runId);
				if (!current || current.status !== "running") {
					clearInterval(tick);
					return;
				}
				current.elapsedMs = Date.now() - current.startedAt;
				updateCommandRunsWidget(store);
			}, RUN_TICK_INTERVAL_MS);

			void (async () => {
				try {
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						selectedAgent,
						taskForAgent,
						undefined,
						undefined,
						abortController.signal,
						(partial) => {
							if (runState.removed) return;
							const current = partial.details?.results?.[0];
							if (!current) return;
							updateRunFromResult(runState, current);
							updateCommandRunsWidget(store);
						},
						makeDetails,
						runState.sessionFile,
					);

					if (runState.removed) return;

					updateRunFromResult(runState, result);
					const isError =
						result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
					runState.status = isError ? "error" : "done";
					runState.elapsedMs = Date.now() - runState.startedAt;
					updateCommandRunsWidget(store);

					const rawOutput = isError
						? result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)"
						: getFinalOutput(result.messages) || "(no output)";
					const output =
						isError && rawOutput.length > RUN_OUTPUT_MESSAGE_MAX_CHARS
							? `${rawOutput.slice(0, RUN_OUTPUT_MESSAGE_MAX_CHARS)}\n\n... [truncated]`
							: rawOutput;
					const usage = formatUsageStats(result.usage, result.model);

					runState.lastOutput = rawOutput;
					if (rawOutput) runState.lastLine = getLastNonEmptyLine(rawOutput);

					const completionMessage = {
						customType: "subagent-command" as const,
						content:
							`[subagent:${selectedAgent}#${runId}] ${isError ? "failed" : "completed"}` +
							`\n${truncateLines(taskForDisplay, 2)}` +
							(usage ? `\nUsage: ${usage}` : "") +
							(runState.progressText ? `\nProgress: ${runState.progressText}` : "") +
							`\n\n${output}` +
							`\n\n${STATUS_LOG_FOOTER}`,
						display: true,
						details: {
							runId,
							agent: selectedAgent,
							task: taskForDisplay,
							continuedFromRunId,
							turnCount: runState.turnCount,
							contextMode: runState.contextMode,
							sessionFile: runState.sessionFile,
							exitCode: result.exitCode,
							usage: result.usage,
							model: result.model,
							source: result.agentSource,
							progressText: runState.progressText,
							status: runState.status,
						},
					};
					// Intentionally keep triggerTurn off for subagent status logs.
					// These are telemetry follow-ups, not user-facing turn triggers.
					const completionOptions = { deliverAs: "followUp" as const };

					// Check if the user is still in the origin session.
					const globalEntry = store.globalLiveRuns.get(runId);
					let currentSessionFile: string | null = null;
					try {
						currentSessionFile = normalizePath(ctx.sessionManager.getSessionFile());
					} catch { /* ignore */ }

					const inOriginSession = !globalEntry
						|| !currentSessionFile
						|| !globalEntry.originSessionFile
						|| currentSessionFile === globalEntry.originSessionFile;

					if (inOriginSession) {
						pi.sendMessage(completionMessage, completionOptions);
						store.globalLiveRuns.delete(runId);
					} else {
						// User is in a different session — queue for later delivery.
						globalEntry.pendingCompletion = {
							message: completionMessage,
							options: completionOptions,
						};
						// Re-insert into commandRuns so the widget shows completion.
						store.commandRuns.set(runId, runState);
					}

					ctx.ui.notify(
						isError
							? `subagent #${runId} (${selectedAgent}) failed`
							: `subagent #${runId} (${selectedAgent}) completed`,
						isError ? "error" : "info",
					);
				} catch (error: any) {
					if (runState.removed) return;
					runState.status = "error";
					runState.elapsedMs = Date.now() - runState.startedAt;
					runState.lastLine = error?.message ? String(error.message) : "Subagent execution failed";
					runState.lastOutput = runState.lastLine;

					const cmdErrorMessage = {
						customType: "subagent-command" as const,
						content:
							`[subagent:${selectedAgent}#${runId}] failed` +
							`\n${truncateLines(taskForDisplay, 2)}` +
							`\n\n${runState.lastLine}` +
							`\n\n${STATUS_LOG_FOOTER}`,
						display: true,
						details: {
							runId,
							agent: selectedAgent,
							task: taskForDisplay,
							continuedFromRunId,
							turnCount: runState.turnCount,
							contextMode: runState.contextMode,
							sessionFile: runState.sessionFile,
							error: runState.lastLine,
							progressText: runState.progressText,
							status: runState.status,
						},
					};

					const cmdErrGlobalEntry = store.globalLiveRuns.get(runId);
					let cmdErrCurrentSession: string | null = null;
					try {
						cmdErrCurrentSession = normalizePath(ctx.sessionManager.getSessionFile());
					} catch { /* ignore */ }

					const cmdErrInOrigin = !cmdErrGlobalEntry
						|| !cmdErrCurrentSession
						|| !cmdErrGlobalEntry.originSessionFile
						|| cmdErrCurrentSession === cmdErrGlobalEntry.originSessionFile;

					// Keep triggerTurn disabled for error telemetry as well.
					if (cmdErrInOrigin) {
						pi.sendMessage(cmdErrorMessage, { deliverAs: "followUp" });
						store.globalLiveRuns.delete(runId);
					} else {
						cmdErrGlobalEntry.pendingCompletion = {
							message: cmdErrorMessage,
							options: { deliverAs: "followUp" },
						};
						store.commandRuns.set(runId, runState);
					}

					ctx.ui.notify(`subagent #${runId} failed: ${runState.lastLine}`, "error");
				} finally {
					clearInterval(tick);
					runState.abortController = undefined;
					trimCommandRunHistory(store, {
						maxRuns: 10,
						ctx,
						pi,
						updateWidget: false,
						removalReason: "trim",
					});
					updateCommandRunsWidget(store);
				}
			})();
		},
	};

	pi.registerCommand("sub:new", subCommand);

	pi.registerCommand("sub:run", {
		description: "Run a subagent with main-session context inheritance: /sub:run <agent|alias> <task>",
		getArgumentCompletions: subCommand.getArgumentCompletions,
		handler: async (args, ctx) => {
			captureSwitchSession(store, ctx);
			const forwarded = (args ?? "").trim();
			await subCommand.handler(forwarded, ctx, true);
		},
	});

	pi.registerCommand("subagents", {
		description: "List available subagents and their model/tool settings (default scope: both)",
		handler: async (args, ctx) => {
			captureSwitchSession(store, ctx);
			const scopeArg = (args ?? "").trim().toLowerCase();
			const scope: AgentScope =
				scopeArg === "user" || scopeArg === "project" || scopeArg === "both"
					? (scopeArg as AgentScope)
					: "both";
			const discovery = discoverAgents(ctx.cwd, scope);
			const agents = discovery.agents;
			if (agents.length === 0) {
				ctx.ui.notify("No subagents found.", "warning");
				return;
			}

			const lines = agents.map((a) => {
				const tools = a.tools?.join(",") ?? "default";
				const model = a.model ?? "(inherit current model)";
				const description = a.description ? ` · ${a.description}` : "";
				return truncateText(`${a.name} [${a.source}] · model: ${model} · tools: ${tools}${description}`, 220);
			});

			ctx.ui.notify(`Available subagents (scope: ${scope})\n${lines.map((line) => `• ${line}`).join("\n")}`, "info");
		},
	});

	pi.registerCommand("sub:open", {
		description: "Open a subagent session replay overlay: /sub:open [runId]",
		getArgumentCompletions: (argumentPrefix) => {
			const trimmedStart = argumentPrefix.trimStart();
			if (trimmedStart.includes(" ")) return null;

			const items = Array.from(store.commandRuns.values())
				.sort((a, b) => b.id - a.id)
				.filter((run) => !trimmedStart || run.id.toString().startsWith(trimmedStart))
				.slice(0, COMMAND_COMPLETION_LIMIT)
				.map((run) => ({
					value: `${run.id}`,
					label: `${run.id}`,
					description: `${run.status} ${run.agent}: ${truncateText(run.task, COMMAND_TASK_PREVIEW_CHARS)}`,
				}));

			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			captureSwitchSession(store, ctx);
			const raw = (args ?? "").trim();
			let id: number;
			let run: CommandRunState | undefined;

			if (!raw) {
				run = getLatestRun(store);
				if (!run) {
					ctx.ui.notify("No subagent runs yet.", "info");
					return;
				}
				id = run.id;
			} else if (/^\d+$/.test(raw)) {
				id = Number(raw);
				run = store.commandRuns.get(id);
			} else {
				ctx.ui.notify("Usage: /sub:open [runId]", "info");
				return;
			}
			if (!run) {
				const availableRunIds = Array.from(store.commandRuns.keys()).sort((a, b) => a - b);
				const availableText =
					availableRunIds.length > 0
						? `Available run IDs: ${availableRunIds.join(", ")}`
						: "No recent subagent runs available.";
				ctx.ui.notify(`Unknown subagent run #${id}. ${availableText}`, "error");
				return;
			}

			const elapsedSec = Math.max(0, Math.round(run.elapsedMs / MS_PER_SECOND));
			const usageLine = run.usage ? `\nUsage: ${formatUsageStats(run.usage, run.model)}` : "";
			const output = (run.lastOutput ?? "").trim();
			const fallback =
				run.status === "running"
					? "(still running; no final output yet)"
					: run.lastLine || "(no output captured)";
			const contextLabel = run.contextMode === "main" ? "main" : "isolated";
			const content =
				`Subagent #${run.id} [${run.status}] ${run.agent} ctx:${contextLabel} turn:${run.turnCount ?? DEFAULT_TURN_COUNT} ${elapsedSec}s tools:${run.toolCalls}` +
				`\n${run.task}` +
				usageLine +
				`\n\n${output || fallback}`;

			if (!ctx.hasUI) {
				return;
			}

			if (!run.sessionFile || !fs.existsSync(run.sessionFile)) {
				ctx.ui.notify(content, "info");
				return;
			}

			const replayItems = readSessionReplayItems(run.sessionFile);
			if (replayItems.length === 0) {
				ctx.ui.notify(content, "info");
				return;
			}

			await ctx.ui.custom(
				(tui, theme, _kb, done) => {
					const overlay = new SubagentSessionReplayOverlay(run, replayItems, () => done(undefined));
					return {
						render: (w) => overlay.render(w, 0 /* height computed internally */, theme),
						handleInput: (data) => overlay.handleInput(data, tui),
						invalidate: () => {},
					};
				},
				{
					overlay: true,
					overlayOptions: { width: SUBVIEW_OVERLAY_WIDTH, maxHeight: SUBVIEW_OVERLAY_MAX_HEIGHT, anchor: "center" },
				},
			);
		},
	});

	pi.registerCommand("sub:trans", {
		description: "Switch to a subagent session in interactive mode: /sub:trans <runId>",
		handler: async (args, ctx) => {
			captureSwitchSession(store, ctx);
			await subTransHandler(args, ctx, store, pi);
		},
	});

	pi.registerCommand("sub:rm", {
		description: "Remove one /sub job entry (aborts it if running): /sub:rm [runId]",
		handler: async (args, ctx) => {
			captureSwitchSession(store, ctx);
			const raw = (args ?? "").trim();
			let id: number;
			let run: CommandRunState | undefined;

			if (!raw) {
				run = getLatestRun(store);
				if (!run) {
					ctx.ui.notify("No subagent runs to remove.", "info");
					return;
				}
				id = run.id;
			} else if (/^\d+$/.test(raw)) {
				id = Number(raw);
				run = store.commandRuns.get(id);
			} else {
				ctx.ui.notify("Usage: /sub:rm [runId]", "info");
				return;
			}
			if (!run) {
				ctx.ui.notify(`Unknown subagent run #${id}.`, "error");
				return;
			}

			const { aborted } = removeRun(store, id, {
				ctx,
				pi,
				reason: "Aborting by /sub:rm...",
				removalReason: "sub-rm",
			});
			ctx.ui.notify(
				aborted
					? `Removed subagent #${id} (aborting in background).`
					: `Removed subagent #${id}.`,
				aborted ? "warning" : "info",
			);
		},
	});

	pi.registerCommand("sub:clear", {
		description: "Clear /sub job widget entries. /sub:clear (finished only) or /sub:clear all",
		handler: async (args, ctx) => {
			captureSwitchSession(store, ctx);
			const mode = (args ?? "").trim().toLowerCase();
			if (mode === "all") {
				let removed = 0;
				let aborted = 0;
				for (const id of Array.from(store.commandRuns.keys())) {
					const result = removeRun(store, id, {
						ctx,
						pi,
						updateWidget: false,
						reason: "Aborting by /sub:clear all...",
						removalReason: "sub-clear",
					});
					if (!result.removed) continue;
					removed++;
					if (result.aborted) aborted++;
				}
				updateCommandRunsWidget(store, ctx);
				ctx.ui.notify(
					aborted > 0
						? `Cleared ${removed} subagent job(s), aborting ${aborted} running job(s).`
						: `Cleared ${removed} subagent job(s).`,
					aborted > 0 ? "warning" : "info",
				);
				return;
			}

			let removed = 0;
			for (const [id, run] of Array.from(store.commandRuns.entries())) {
				if (run.status === "running") continue;
				const result = removeRun(store, id, {
					ctx,
					pi,
					updateWidget: false,
					abortIfRunning: false,
					removalReason: "sub-clear",
				});
				if (result.removed) removed++;
			}
			updateCommandRunsWidget(store, ctx);
			ctx.ui.notify(`Cleared ${removed} finished subagent job(s).`, "info");
		},
	});

	const handleSubAbort = async (args: string, ctx: any) => {
		const raw = (args ?? "").trim().toLowerCase();
		const running = Array.from(store.commandRuns.values())
			.filter((run) => run.status === "running")
			.sort((a, b) => b.id - a.id);

		if (running.length === 0) {
			ctx.ui.notify("No running subagent jobs.", "info");
			return;
		}

		const abortRun = (run: CommandRunState): boolean => {
			// Try the run's own controller first, then fall back to globalLiveRuns
			// (the run's controller may have been cleared after a session switch).
			const controller = run.abortController ?? store.globalLiveRuns.get(run.id)?.abortController;
			if (!controller) return false;
			run.lastLine = "Aborting by user...";
			run.lastOutput = run.lastLine;
			controller.abort();
			return true;
		};

		if (!raw) {
			const target = running[0];
			if (!abortRun(target)) {
				ctx.ui.notify(`Subagent #${target.id} is not abortable right now.`, "warning");
				return;
			}
			updateCommandRunsWidget(store, ctx);
			ctx.ui.notify(`Aborting subagent #${target.id} (${target.agent})...`, "warning");
			return;
		}

		if (raw === "all") {
			let count = 0;
			for (const run of running) {
				if (abortRun(run)) count++;
			}
			updateCommandRunsWidget(store, ctx);
			ctx.ui.notify(
				count > 0 ? `Aborting ${count} running subagent job(s)...` : "No abortable subagent jobs.",
				count > 0 ? "warning" : "info",
			);
			return;
		}

		if (/^\d+$/.test(raw)) {
			const id = Number(raw);
			const run = store.commandRuns.get(id);
			if (!run) {
				ctx.ui.notify(`Unknown subagent run #${id}.`, "error");
				return;
			}
			if (run.status !== "running") {
				ctx.ui.notify(`Subagent #${id} is not running.`, "info");
				return;
			}
			if (!abortRun(run)) {
				ctx.ui.notify(`Subagent #${id} is not abortable right now.`, "warning");
				return;
			}
			updateCommandRunsWidget(store, ctx);
			ctx.ui.notify(`Aborting subagent #${id} (${run.agent})...`, "warning");
			return;
		}

		ctx.ui.notify("Usage: /sub:abort [runId|all]", "info");
	};

	pi.registerCommand("sub:abort", {
		description: "Abort running subagent job(s). /sub:abort [runId|all]",
		handler: async (args, ctx) => {
			captureSwitchSession(store, ctx);
			await handleSubAbort(args, ctx);
		},
	});


	// /hotkeys "Extensions" 섹션에 >> shorthand 사용법을 노출한다.
	// 실제 입력 처리는 아래 input 핸들러에서 수행된다.
	pi.registerShortcut(">>", {
		description: "Run subagent task",
		handler: async () => {
			// Documentation-only entry.
		},
	});

	pi.registerShortcut(">>>", {
		description: "Run subagent in dedicated sub-session (= /sub:new, supports symbols)",
		handler: async () => {
			// Documentation-only entry.
		},
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") {
			return { action: "continue" as const };
		}

		const text = event.text ?? "";
		if (!text.startsWith(">>")) {
			return { action: "continue" as const };
		}

		// ── >>> shortcut: dedicated sub-session (same as /sub:new) ──
		// Must be matched before >> symbol/space patterns.
		if (text.startsWith(">>>")) {
			const forwardedArgs = text.slice(3).trim();
			if (!forwardedArgs) {
				ctx.ui.notify(
					`>>> [agent] <task> | >>> <runId> <task> | >>><symbol> <task>\n${formatSymbolHints(">>>")}`,
					"info",
				);
				return { action: "handled" as const };
			}

			// Dedicated symbol shortcut: >>>? task, >>>/ task, >>>* task, etc.
			const dedicatedSymbol = AGENT_SYMBOL_MAP[forwardedArgs[0]];
			if (dedicatedSymbol) {
				const task = forwardedArgs.slice(1).trim();
				if (!task) {
					ctx.ui.notify(formatSymbolHints(">>>"), "info");
					return { action: "handled" as const };
				}
				await subCommand.handler(`${dedicatedSymbol} ${task}`, ctx, false);
				return { action: "handled" as const };
			}

			const firstSpace = forwardedArgs.indexOf(" ");
			const firstToken = firstSpace === -1 ? forwardedArgs : forwardedArgs.slice(0, firstSpace);
			if (/^\d+$/.test(firstToken) && !store.commandRuns.has(Number(firstToken))) {
				ctx.ui.notify(`Unknown subagent run #${firstToken}.`, "error");
				return { action: "handled" as const };
			}
			await subCommand.handler(forwardedArgs, ctx, false);
			return { action: "handled" as const };
		}

		// ── Symbol shortcut: >>? task, >>@ task, >>! task, etc. ──
		if (text.length >= 3) {
			const symbolChar = text[2];
			const symbolAgent = symbolChar !== " " ? AGENT_SYMBOL_MAP[symbolChar] : undefined;
			if (symbolAgent) {
				const task = text.slice(3).trim();
				if (!task) {
					ctx.ui.notify(formatSymbolHints(), "info");
					return { action: "handled" as const };
				}
				await subCommand.handler(`${symbolAgent} ${task}`, ctx, true);
				return { action: "handled" as const };
			}
		}

		// ── Original >> <args> pattern ──
		if (text[2] !== " ") {
			return { action: "continue" as const };
		}

		const forwardedArgs = text.slice(3).trim();
		if (!forwardedArgs) {
			ctx.ui.notify(
				`>> [agent] <task> | >> <runId> <task> | >><symbol> <task>\n${formatSymbolHints()}`,
				"info",
			);
			return { action: "handled" as const };
		}

		const firstSpace = forwardedArgs.indexOf(" ");
		const firstToken = firstSpace === -1 ? forwardedArgs : forwardedArgs.slice(0, firstSpace);
		if (/^\d+$/.test(firstToken) && !store.commandRuns.has(Number(firstToken))) {
			ctx.ui.notify(`Unknown subagent run #${firstToken}.`, "error");
			return { action: "handled" as const };
		}

		await subCommand.handler(forwardedArgs, ctx, true);
		return { action: "handled" as const };
	});

	// #<runId> shortcut: resume a subagent run (e.g. #42 keep going)
	pi.registerShortcut("#<runId>", {
		description: "Resume subagent run: #<runId> <task>",
		handler: async () => {
			// Documentation-only entry.
		},
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") {
			return { action: "continue" as const };
		}

		const text = event.text ?? "";

		// Match #<digits> pattern (e.g. #42 task, #7 keep going)
		const match = /^#(\d+)\s(.+)/.exec(text);
		if (!match) {
			return { action: "continue" as const };
		}

		const runId = match[1];
		const task = match[2].trim();

		if (!task) {
			ctx.ui.notify("Usage: #<runId> <task>", "info");
			return { action: "handled" as const };
		}

		if (!store.commandRuns.has(Number(runId))) {
			ctx.ui.notify(`Unknown subagent run #${runId}.`, "error");
			return { action: "handled" as const };
		}

		await subCommand.handler(`${runId} ${task}`, ctx, true);
		return { action: "handled" as const };
	});

	// <> shortcut: switch to subagent session (equivalent to /sub:trans)
	pi.registerShortcut("<>", {
		description: "Switch to subagent session",
		handler: async () => {
			// Documentation-only entry.
		},
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") {
			return { action: "continue" as const };
		}

		const text = event.text ?? "";
		if (!text.startsWith("<>")) {
			return { action: "continue" as const };
		}

		const raw = text.slice(2).trim();
		await subTransHandler(raw, ctx, store, pi);
		return { action: "handled" as const };
	});

	// sub:back command: return to parent session (used by >< shortcut)
	pi.registerCommand("sub:back", {
		description: "Return to parent session (pop from session stack): /sub:back",
		handler: async (_args, ctx) => {
			captureSwitchSession(store, ctx);
			await subBackHandler(ctx, store);
		},
	});

	pi.registerCommand("sub:enable-switch", {
		description: "Enable <> / >< session-switch shortcuts for the current runtime",
		handler: async (_args, ctx) => {
			captureSwitchSession(store, ctx);
			if (store.switchSessionFn) {
				ctx.ui.notify("Session switching enabled. Use <> and >< shortcuts.", "info");
			} else {
				ctx.ui.notify("Could not capture session switch function. Try running any /sub:* command instead.", "warning");
			}
		},
	});

	// >< shortcut: back to parent session (pop from session stack)
	pi.registerShortcut("><", {
		description: "Back to parent session",
		handler: async () => {
			// Documentation-only entry.
		},
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") {
			return { action: "continue" as const };
		}

		const text = event.text ?? "";
		if (text.trim() !== "><") {
			return { action: "continue" as const };
		}

		await subBackHandler(ctx, store);
		return { action: "handled" as const };
	});

	// << shortcut: abort running jobs or clear finished jobs
	pi.registerShortcut("<<", {
		description: "Abort or clear subagent runs",
		handler: async () => {
			// Documentation-only entry.
		},
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") {
			return { action: "continue" as const };
		}

		const text = event.text ?? "";
		if (!text.startsWith("<<")) {
			return { action: "continue" as const };
		}

		const raw = text.slice(2).trim();

		// << 1,2,3 — multiple run IDs (comma-separated)
		// << 1 — single run ID
		// << (no args) — latest running or latest finished
		const ids = raw
			? raw.split(",").map((s) => s.trim()).filter(Boolean)
			: [];

		if (ids.length === 0) {
			// No args: abort latest running job only.
			// Never auto-clear finished runs — too dangerous on accidental <<.
			const running = Array.from(store.commandRuns.values())
				.filter((r) => r.status === "running")
				.sort((a, b) => b.id - a.id);
			if (running.length > 0) {
				await handleSubAbort("", ctx);
			} else {
				ctx.ui.notify("No running jobs. Use << <id> or /sub:clear.", "info");
			}
			return { action: "handled" as const };
		}

		// Validate all IDs are numeric
		if (!ids.every((id) => /^\d+$/.test(id))) {
			ctx.ui.notify("Usage: << [runId,runId,...]", "info");
			return { action: "handled" as const };
		}

		let aborted = 0;
		let cleared = 0;
		const unknown: string[] = [];
		for (const idStr of ids) {
			const id = Number(idStr);
			const run = store.commandRuns.get(id);
			if (!run) {
				unknown.push(idStr);
				continue;
			}
			const shortcutController = run.abortController ?? store.globalLiveRuns.get(id)?.abortController;
			if (run.status === "running" && shortcutController) {
				run.lastLine = "Aborting by user...";
				run.lastOutput = run.lastLine;
				shortcutController.abort();
				aborted++;
			} else if (run.status !== "running") {
				const result = removeRun(store, id, {
					ctx,
					pi,
					updateWidget: false,
					abortIfRunning: false,
					removalReason: "shortcut-clear",
				});
				if (result.removed) cleared++;
			}
		}
		updateCommandRunsWidget(store, ctx);

		const parts: string[] = [];
		if (aborted) parts.push(`${aborted} aborted`);
		if (cleared) parts.push(`${cleared} cleared`);
		if (unknown.length) parts.push(`#${unknown.join(",#")} not found`);
		ctx.ui.notify(parts.join(", ") || "Nothing to do.", parts.length ? (aborted ? "warning" : "info") : "info");
		return { action: "handled" as const };
	});

	// ── onTerminalInput hack: auto-redirect <> / >< to command path ─────
	// When switchSessionFn is not yet captured, rewrite editor text to the
	// equivalent slash command right before Enter is processed.  The editor
	// reads its state.lines at submit time, so a synchronous setEditorText()
	// in the input listener guarantees the command path sees "/sub:trans …".
	// Once switchSessionFn is captured (first successful command execution),
	// the normal input event handler handles <> / >< directly and this
	// listener becomes a no-op pass-through.
	let unsubTerminalInput: (() => void) | null = null;

	function registerTerminalInputRedirect(ctx: any): void {
		// Unsubscribe previous listener to avoid duplicates on session_switch.
		unsubTerminalInput?.();
		unsubTerminalInput = null;

		unsubTerminalInput = ctx.ui.onTerminalInput((data: string) => {
			// Fast path: already captured — skip entirely.
			if (store.switchSessionFn) return undefined;

			// Only intercept Enter key (all terminal variants).
			if (!matchesKey(data, "enter")) return undefined;

			const editorText = (ctx.ui.getEditorText() ?? "").trim();

			// <> [runId]  →  /sub:trans [runId]
			if (editorText.startsWith("<>")) {
				const args = editorText.slice(2).trim();
				ctx.ui.setEditorText(args ? `/sub:trans ${args}` : "/sub:trans");
				return undefined; // let Enter proceed with rewritten text
			}

			// ><  →  /sub:back
			if (editorText === "><") {
				ctx.ui.setEditorText("/sub:back");
				return undefined;
			}

			return undefined;
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		restoreRunsFromSession(store, ctx, pi);
		registerTerminalInputRedirect(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		restoreRunsFromSession(store, ctx, pi);
		registerTerminalInputRedirect(ctx);
	});

}
