/**
 * Tool handler, slash-command handlers, and event handlers for the Subagent extension.
 *
 * All handlers receive the shared SubagentStore and ExtensionAPI as parameters
 * instead of capturing closure variables — making dependencies explicit.
 */

import * as fs from "node:fs";
import type { AgentScope } from "./agents.js";
import { discoverAgents } from "./agents.js";
import { formatUsageStats } from "./format.js";
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
import { formatCommandRunSummary, getLatestRun, trimCommandRunHistory } from "./run-utils.js";
import { updateCommandRunsWidget } from "./widget.js";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { renderSubagentToolCall, renderSubagentToolResult } from "./tool-render.js";
import { createSubagentToolExecute } from "./tool-execute.js";
import {
	COMMAND_COMPLETION_LIMIT,
	COMMAND_TASK_PREVIEW_CHARS,
	CONTINUATION_OUTPUT_CONTEXT_MAX_CHARS,
	DEFAULT_TURN_COUNT,
	MS_PER_SECOND,
	RUN_OUTPUT_MESSAGE_MAX_CHARS,
	RUN_TICK_INTERVAL_MS,
	SUBVIEW_OVERLAY_MAX_HEIGHT,
	SUBVIEW_OVERLAY_WIDTH,
} from "./constants.js";

export function registerAll(pi: ExtensionAPI, store: SubagentStore): void {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			"Supports background async jobs via runAsync + asyncAction (list/status/abort/remove).",
			"Use contextMode: \"main\" to inherit current main-session context, or \"isolated\" for dedicated sub-session.",
			"Default agent scope is \"user\" (from ~/.pi/agent/agents).",
			"To enable project-local agents in .pi/agents, set agentScope: \"both\" (or \"project\").",
			"Important: Do NOT keep calling subagent for polling. Async runs push completion/failure/error updates automatically as follow-up messages; status/list is for occasional manual checks only.",
		].join(" "),
		parameters: SubagentParams,

		execute: createSubagentToolExecute(pi, store),

		renderCall: renderSubagentToolCall,

		renderResult: renderSubagentToolResult,
	});

	const subCommand = {
		description:
			"Run a subagent in a dedicated sub-session: /subnew <agent|alias> <task>, /subnew <runId> <task>, /subnew <task> (defaults to worker)",
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
			let input = (args ?? "").trim();
			const usageText =
				"Usage: /sub <agent|alias> <task> | /sub <runId> <task> | /sub <task> | /subnew <agent|alias> <task> | /subnew <runId> <task> | /subnew <task>";
			let forceMainContext = forceMainContextFromWrapper;

			if (input === "--main" || input.startsWith("--main ")) {
				ctx.ui.notify("'--main' 접두어는 사용할 수 없습니다. /sub 또는 /subnew 명령 자체로 컨텍스트를 선택하세요.", "warning");
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
				ctx.ui.notify("No agents found in ~/.pi/agent/agents", "error");
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
						`Run #${targetRunId} references unknown agent "${previousAgentName}". Use /sub <agent> <task> instead.`,
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
				// /sub 와 /subnew 간 모드 전환은 기존 run에는 소급 적용하지 않는다.
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
						`[sub:${selectedAgent}#${runId}] ${startedState}` +
						`\nTask: ${taskForDisplay}` +
						(continuedFromRunId !== undefined ? `\nContinued from: #${continuedFromRunId}` : "") +
						`\nContext: ${contextLabel} · turn ${runState.turnCount}`,
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
						rawOutput.length > RUN_OUTPUT_MESSAGE_MAX_CHARS
							? `${rawOutput.slice(0, RUN_OUTPUT_MESSAGE_MAX_CHARS)}\n\n... [truncated]`
							: rawOutput;
					const usage = formatUsageStats(result.usage, result.model);

					runState.lastOutput = rawOutput;
					if (rawOutput) runState.lastLine = getLastNonEmptyLine(rawOutput);

					pi.sendMessage(
						{
							customType: "subagent-command",
							content:
								`[sub:${selectedAgent}#${runId}] ${isError ? "failed" : "completed"}` +
								`\nTask: ${taskForDisplay}` +
								(continuedFromRunId !== undefined ? `\nContinued from: #${continuedFromRunId}` : "") +
								(usage ? `\nUsage: ${usage}` : "") +
								(runState.progressText ? `\nProgress: ${runState.progressText}` : "") +
								(isError ? `\n\n${output}` : ""),
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
							},
						},
						{ deliverAs: "followUp" },
					);

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
					ctx.ui.notify(`subagent #${runId} failed: ${runState.lastLine}`, "error");
				} finally {
					clearInterval(tick);
					runState.abortController = undefined;
					trimCommandRunHistory(store);
					updateCommandRunsWidget(store);
				}
			})();
		},
	};

	pi.registerCommand("subnew", subCommand);

	pi.registerCommand("sub", {
		description: "Run a subagent with main-session context inheritance: /sub <agent|alias> <task>",
		getArgumentCompletions: subCommand.getArgumentCompletions,
		handler: async (args, ctx) => {
			const forwarded = (args ?? "").trim();
			await subCommand.handler(forwarded, ctx, true);
		},
	});

	pi.registerCommand("subagents", {
		description: "List available subagents and their model/tool settings",
		handler: async (args, ctx) => {
			const scopeArg = (args ?? "").trim().toLowerCase();
			const scope: AgentScope = scopeArg === "project" || scopeArg === "both" ? (scopeArg as AgentScope) : "user";
			const discovery = discoverAgents(ctx.cwd, scope);
			const agents = discovery.agents;
			if (agents.length === 0) {
				ctx.ui.notify("No subagents found.", "warning");
				return;
			}

			const lines = agents.map((a) => {
				const tools = a.tools?.join(",") ?? "default";
				const model = a.model ?? "(inherit current model)";
				return `- ${a.name} [${a.source}]\n  model: ${model}\n  tools: ${tools}\n  ${a.description}`;
			});

			pi.sendMessage(
				{
					customType: "subagent-command",
					content: `Available subagents (scope: ${scope})\n\n${lines.join("\n\n")}`,
					display: true,
				},
				{ deliverAs: "followUp" },
			);
		},
	});

	pi.registerCommand("subjobs", {
		description: "Show running/completed /sub jobs",
		handler: async (_args, ctx) => {
			store.commandWidgetCtx = ctx;
			if (store.commandRuns.size === 0) {
				ctx.ui.notify("No subagent jobs yet.", "info");
				return;
			}

			const lines = Array.from(store.commandRuns.values())
				.sort((a, b) => b.id - a.id)
				.map((run) => `${formatCommandRunSummary(run)}\n  task: ${run.task}`);

			ctx.ui.notify(`Subagent jobs\n\n${lines.join("\n\n")}`, "info");
		},
	});

	pi.registerCommand("subview", {
		description: "Open a subagent session replay overlay: /subview [runId]",
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
				ctx.ui.notify("Usage: /subview [runId]", "info");
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
			const content =
				`Subagent #${run.id} [${run.status}] ${run.agent} ctx:${run.contextMode ?? "sub"} turn:${run.turnCount ?? DEFAULT_TURN_COUNT} ${elapsedSec}s tools:${run.toolCalls}` +
				`\nTask: ${run.task}` +
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

	pi.registerCommand("subtrans", {
		description: "Switch to a subagent session in interactive mode: /subtrans [runId]",
		handler: async (args, ctx) => {
			const raw = (args ?? "").trim();
			let runId: number;
			let run: CommandRunState | undefined;

			if (!raw) {
				run = getLatestRun(store, ["done", "error"]);
				if (!run) {
					ctx.ui.notify("No finished subagent runs to switch to.", "info");
					return;
				}
				runId = run.id;
			} else {
				runId = parseInt(raw);
				if (isNaN(runId)) {
					ctx.ui.notify("Usage: /subtrans [runId]", "error");
					return;
				}
				run = store.commandRuns.get(runId);
			}
			if (!run) {
				ctx.ui.notify(`Run #${runId} not found. Use /subjobs to list runs.`, "error");
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
			const success = await ctx.switchSession(run.sessionFile);
			if (!success) {
				ctx.ui.notify(`Failed to switch to session: ${run.sessionFile}`, "error");
			}
		},
	});

	pi.registerCommand("subrm", {
		description: "Remove one /sub job entry (aborts it if running): /subrm [runId]",
		handler: async (args, ctx) => {
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
				ctx.ui.notify("Usage: /subrm [runId]", "info");
				return;
			}
			if (!run) {
				ctx.ui.notify(`Unknown subagent run #${id}.`, "error");
				return;
			}

			let aborted = false;
			run.removed = true;
			if (run.status === "running" && run.abortController) {
				run.lastLine = "Aborting by /subrm...";
				run.lastOutput = run.lastLine;
				run.abortController.abort();
				aborted = true;
			}

			run.abortController = undefined;
			store.commandRuns.delete(id);
			pi.appendEntry("subagent-removed", { runId: id });
			updateCommandRunsWidget(store, ctx);
			ctx.ui.notify(
				aborted
					? `Removed subagent #${id} (aborting in background).`
					: `Removed subagent #${id}.`,
				aborted ? "warning" : "info",
			);
		},
	});

	pi.registerCommand("subclear", {
		description: "Clear /sub job widget entries. /subclear (finished only) or /subclear all",
		handler: async (args, ctx) => {
			const mode = (args ?? "").trim().toLowerCase();
			if (mode === "all") {
				const count = store.commandRuns.size;
				for (const id of store.commandRuns.keys()) {
					pi.appendEntry("subagent-removed", { runId: id });
				}
				store.commandRuns.clear();
				updateCommandRunsWidget(store, ctx);
				ctx.ui.notify(`Cleared ${count} subagent job(s).`, "info");
				return;
			}

			let removed = 0;
			for (const [id, run] of Array.from(store.commandRuns.entries())) {
				if (run.status !== "running") {
					pi.appendEntry("subagent-removed", { runId: id });
					store.commandRuns.delete(id);
					removed++;
				}
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
			if (!run.abortController) return false;
			run.lastLine = "Aborting by user...";
			run.lastOutput = run.lastLine;
			run.abortController.abort();
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
		description: "Abort running /sub job(s). /sub:abort [runId|all]",
		handler: async (args, ctx) => {
			await handleSubAbort(args, ctx);
		},
	});

	pi.registerCommand("subabort", {
		description: "Alias of /sub:abort",
		handler: async (args, ctx) => {
			await handleSubAbort(args, ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		store.commandRuns.clear();
		store.commandWidgetCtx = ctx;

		// Restore subagent run history from session entries so that
		// reload / session-switch preserves the run list and allows resume.
		try {
			const entries = ctx.sessionManager.getEntries();
			const restoredRuns = new Map<number, CommandRunState>();
			const removedRunIds = new Set<number>();
			let maxRunId = 0;

			// First pass: collect removed run IDs
			for (const entry of entries) {
				if (entry.type === "custom") {
					const ce = entry as any;
					if (ce.customType === "subagent-removed" && ce.data?.runId != null) {
						removedRunIds.add(ce.data.runId);
					}
				}
			}

			for (const entry of entries) {
				if (entry.type !== "custom_message") continue;
				const cm = entry as any;
				if (cm.customType !== "subagent-command" && cm.customType !== "subagent-tool") continue;
				const d = cm.details;
				if (!d || typeof d.runId !== "number") continue;

				const runId = d.runId;
				if (runId > maxRunId) maxRunId = runId;

				const existing = restoredRuns.get(runId);

				// Determine status from the message content
				const content = typeof cm.content === "string" ? cm.content : "";
				const isCompleted = content.includes("] completed");
				const isFailed = content.includes("] failed");
				const isError = content.includes("] error");

				if (isCompleted || isFailed || isError) {
					// Final message — create or overwrite with done/error state
					const status = isCompleted ? "done" : "error";
					const run: CommandRunState = {
						id: runId,
						agent: d.agent ?? existing?.agent ?? "unknown",
						task: d.task ?? existing?.task ?? "",
						status,
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
						const progressLine = lines.find((l: string) => l.startsWith("Progress: "));
						if (progressLine) run.progressText = progressLine.slice("Progress: ".length).trim();
					}
					const bodyStart = lines.findIndex((l: string) => l === "") + 1;
					if (bodyStart > 0 && bodyStart < lines.length) {
						run.lastOutput = lines.slice(bodyStart).join("\n");
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

		updateCommandRunsWidget(store, ctx);
	});

	// Hide subagent-command messages from the main agent's LLM context.
	// They remain visible in the TUI but are stripped before each LLM call.
	pi.on("context", async (event, _ctx) => {
		const filtered = event.messages.filter(
			(m: any) => !(m.role === "custom" && m.customType === "subagent-command"),
		);
		return { messages: filtered };
	});
}
