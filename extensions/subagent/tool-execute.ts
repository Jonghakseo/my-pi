/**
 * Subagent tool execute handler — extracted from commands.ts for modularity.
 *
 * createSubagentToolExecute(pi, store) returns the async execute function
 * that is passed to pi.registerTool({ execute: ... }).
 */

import * as fs from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentConfig, AgentScope } from "./agents.js";
import { discoverAgents } from "./agents.js";
import {
	DEFAULT_TURN_COUNT,
	IDLE_RUN_WARNING_THRESHOLD,
	MAX_CONCURRENT_ASYNC_SUBAGENT_RUNS,
	STATUS_OUTPUT_PREVIEW_MAX_CHARS,
} from "./constants.js";
import {
	formatContextUsageBar,
	formatUsageStats,
	getUsedContextPercent,
	resolveContextWindow,
	truncateLines,
} from "./format.js";
import { formatCommandRunSummary, removeRun, trimCommandRunHistory } from "./run-utils.js";
import { getFinalOutput, getLastNonEmptyLine, runSingleAgent } from "./runner.js";
import { buildMainContextText, makeSubagentSessionFile, wrapTaskWithMainContext } from "./session.js";
import { type SubagentStore, updateRunFromResult } from "./store.js";
import type { ChainItemFields, CommandRunState, OnUpdateCallback, SingleResult, SubagentDetails } from "./types.js";
import { ESCALATION_EXIT_CODE, readAndConsumeEscalation } from "./escalation.js";
import { updateCommandRunsWidget } from "./widget.js";

type SessionToolCall = {
	name: string;
	argsText: string;
};

type SessionTurnToolCalls = {
	turn: number;
	toolCalls: SessionToolCall[];
};

type SessionDetailSummary = {
	finalOutput: string;
	turns: SessionTurnToolCalls[];
	error?: string;
};

function stringifyToolCallArguments(args: unknown): string {
	if (args === undefined || args === null) return "";
	if (typeof args === "string") return args;
	try {
		return JSON.stringify(args);
	} catch {
		return String(args);
	}
}

function getAssistantTextPart(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		if ((part as any).type === "text" && typeof (part as any).text === "string") {
			return (part as any).text;
		}
	}
	return "";
}

function parseSessionDetailSummary(sessionFile?: string): SessionDetailSummary {
	if (!sessionFile) {
		return { finalOutput: "", turns: [], error: "Session file is not available for this run." };
	}
	if (!fs.existsSync(sessionFile)) {
		return { finalOutput: "", turns: [], error: `Session file not found: ${sessionFile}` };
	}

	let raw = "";
	try {
		raw = fs.readFileSync(sessionFile, "utf-8");
	} catch (error: any) {
		const message = error?.message ? String(error.message) : "Unknown read error";
		return { finalOutput: "", turns: [], error: `Failed to read session file: ${message}` };
	}

	const assistantMessages: any[] = [];
	const turns: SessionTurnToolCalls[] = [];

	for (const line of raw.split(/\r?\n/)) {
		if (!line.trim()) continue;

		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}

		if (entry?.type !== "message" || !entry.message || entry.message.role !== "assistant") continue;

		assistantMessages.push(entry.message);
		const turn = assistantMessages.length;
		const toolCalls: SessionToolCall[] = [];
		const content = entry.message.content;

		if (Array.isArray(content)) {
			for (const part of content) {
				if (!part || typeof part !== "object") continue;
				if ((part as any).type !== "toolCall") continue;
				const name = typeof (part as any).name === "string" ? (part as any).name : "tool";
				const argsText = stringifyToolCallArguments((part as any).arguments);
				toolCalls.push({ name, argsText });
			}
		}

		if (toolCalls.length > 0) {
			turns.push({ turn, toolCalls });
		}
	}

	let finalOutput = "";
	for (let i = assistantMessages.length - 1; i >= 0; i--) {
		const text = getAssistantTextPart(assistantMessages[i]?.content);
		if (text) {
			finalOutput = text;
			break;
		}
	}

	return { finalOutput, turns };
}

function formatRunDetailOutput(run: CommandRunState): string {
	const sessionSummary = parseSessionDetailSummary(run.sessionFile);
	const runOutput = run.lastOutput?.trim() ? run.lastOutput : "";
	const sessionOutput = sessionSummary.finalOutput?.trim() ? sessionSummary.finalOutput : "";
	const lineOutput = run.lastLine?.trim() ? run.lastLine : "";
	const output = runOutput || sessionOutput || lineOutput || "(no output)";
	const lines: string[] = [formatCommandRunSummary(run), `Prompt: ${run.task}`];

	if (run.sessionFile) lines.push(`Session: ${run.sessionFile}`);
	if (run.thoughtText) lines.push(`Thought: ${run.thoughtText}`);

	lines.push("", "Result:", output, "", "Tool calls by turn:");

	if (sessionSummary.error) {
		lines.push(`- (session parse error) ${sessionSummary.error}`);
	}

	if (sessionSummary.turns.length === 0) {
		lines.push("- (no tool calls)");
	} else {
		for (const turn of sessionSummary.turns) {
			lines.push(`Turn ${turn.turn}:`);
			for (const toolCall of turn.toolCalls) {
				lines.push(`  - ${toolCall.name}${toolCall.argsText ? ` ${toolCall.argsText}` : ""}`);
			}
		}
	}

	return lines.join("\n");
}

function getRunCounts(store: SubagentStore): { running: number; idle: number } {
	const dedupedRunning = new Map<number, CommandRunState>();

	for (const [runId, run] of store.commandRuns) {
		if (run.removed) continue;
		dedupedRunning.set(runId, run);
	}

	for (const [runId, entry] of store.globalLiveRuns) {
		if (entry.runState.removed) continue;
		dedupedRunning.set(runId, entry.runState);
	}

	const running = Array.from(dedupedRunning.values()).filter((run) => run.status === "running").length;
	const idle = Array.from(store.commandRuns.values()).filter((run) => !run.removed && run.status !== "running").length;
	return { running, idle };
}

function formatIdleRunWarning(idleRunCount: number): string {
	return (
		`⚠️ Idle subagent runs: ${idleRunCount}. ` +
		`removed되지 않은 완료/오류 run이 ${IDLE_RUN_WARNING_THRESHOLD}개 이상입니다. ` +
		`필요 없는 run은 asyncAction:"remove"로 정리하세요.`
	);
}

/** Return type for the subagent execute function (extends AgentToolResult with optional isError). */
type SubagentExecuteResult = {
	content: { type: "text"; text: string }[];
	details: SubagentDetails;
	isError?: boolean;
};

export function createSubagentToolExecute(pi: ExtensionAPI, store: SubagentStore) {
	return async (
		_toolCallId: string,
		params: Record<string, any>,
		signal: AbortSignal | undefined,
		onUpdate: OnUpdateCallback | undefined,
		ctx: any,
	): Promise<SubagentExecuteResult> => {
		const agentScope: AgentScope = params.agentScope ?? "user";
		const contextMode = params.contextMode ?? "isolated";
		const inheritMainContext = contextMode === "main";
		const discovery = discoverAgents(ctx.cwd, agentScope);
		const agents = discovery.agents;
		const asyncActionRequested = params.asyncAction ?? "run";
		const rawMainSessionFile = inheritMainContext ? (ctx.sessionManager.getSessionFile() ?? undefined) : undefined;
		const mainSessionFile =
			typeof rawMainSessionFile === "string"
				? rawMainSessionFile.replace(/[\r\n\t]+/g, "").trim() || undefined
				: undefined;

		if (inheritMainContext && !mainSessionFile && asyncActionRequested === "run") {
			return {
				content: [
					{
						type: "text",
						text: "contextMode=main requires an active main session. Current session is unavailable (e.g. --no-session).",
					},
				],
				details: {
					mode: "single",
					agentScope,
					inheritMainContext,
					projectAgentsDir: discovery.projectAgentsDir,
					results: [],
				},
				isError: true,
			};
		}

		// Extract main session context as text instead of copying session file.
		// This prevents subagents from inheriting the main agent's persona.
		const mainContextResult = inheritMainContext ? buildMainContextText(ctx) : { text: "", totalMessageCount: 0 };
		const mainContextText = typeof mainContextResult === "string" ? mainContextResult : mainContextResult.text;
		const totalMessageCount = typeof mainContextResult === "string" ? 0 : mainContextResult.totalMessageCount;

		const hasChain = (params.chain?.length ?? 0) > 0;
		// hasSingle: true when (agent + task) OR (continueRunId + task — agent will be resolved from the prior run)
		const hasSingle = Boolean((params.agent && params.task) || (params.continueRunId !== undefined && params.task));
		const modeCount = Number(hasChain) + Number(hasSingle);

		const makeDetails =
			(mode: "single" | "chain") =>
			(results: SingleResult[]): SubagentDetails => ({
				mode,
				agentScope,
				inheritMainContext,
				projectAgentsDir: discovery.projectAgentsDir,
				results,
			});

		const runCounts = getRunCounts(store);
		const idleRunWarning =
			runCounts.idle >= IDLE_RUN_WARNING_THRESHOLD ? formatIdleRunWarning(runCounts.idle) : undefined;

		if (idleRunWarning && ctx.hasUI) {
			ctx.ui.notify(idleRunWarning, "warning");
		}

		const withIdleRunWarning = (text: string): string => (idleRunWarning ? `${idleRunWarning}\n\n${text}` : text);

		const asyncAction = asyncActionRequested;

		if (asyncAction !== "run") {
			if (asyncAction === "list") {
				const runs = Array.from(store.commandRuns.values()).sort((a, b) => b.id - a.id);
				if (runs.length === 0) {
					return {
						content: [{ type: "text", text: withIdleRunWarning("No subagent runs found.") }],
						details: makeDetails("single")([]),
					};
				}
				const lines = runs.map((run) => {
					const contextWindow = resolveContextWindow(ctx, run.model);
					const usedPercent = getUsedContextPercent(run.usage?.contextTokens, contextWindow);
					const usageSuffix = usedPercent === undefined ? "" : ` usage:${formatContextUsageBar(usedPercent)}`;
					const taskPreview = truncateLines(run.task, 2).replace(/\n/g, "\n  ");
					return `${formatCommandRunSummary(run)}${usageSuffix}\n  ${taskPreview}`;
				});
				return {
					content: [{ type: "text", text: withIdleRunWarning(`Subagent runs\n\n${lines.join("\n\n")}`) }],
					details: makeDetails("single")([]),
				};
			}

			const rawRunIds = Array.isArray(params.runIds) ? params.runIds : undefined;
			const invalidRunIds = (rawRunIds ?? []).filter((value) => !Number.isInteger(value));
			if (invalidRunIds.length > 0) {
				return {
					content: [{ type: "text", text: `runIds must be an array of integer run IDs.` }],
					details: makeDetails("single")([]),
					isError: true,
				};
			}

			const runIdsFromArray = ((rawRunIds ?? []) as number[]).filter((value) => Number.isInteger(value));
			const hasRunId = Number.isInteger(params.runId);
			const hasRunIds = runIdsFromArray.length > 0;
			const isBulkAction = asyncAction === "abort" || asyncAction === "remove";

			if (!isBulkAction && rawRunIds !== undefined) {
				return {
					content: [{ type: "text", text: `asyncAction=${asyncAction} does not support runIds. Use runId.` }],
					details: makeDetails("single")([]),
					isError: true,
				};
			}

			if (hasRunId && hasRunIds) {
				return {
					content: [{ type: "text", text: `Use either runId or runIds, not both.` }],
					details: makeDetails("single")([]),
					isError: true,
				};
			}

			if (!hasRunId && !hasRunIds) {
				const required = isBulkAction ? "runId or runIds" : "runId";
				return {
					content: [{ type: "text", text: `asyncAction=${asyncAction} requires ${required}.` }],
					details: makeDetails("single")([]),
					isError: true,
				};
			}

			const targetRunIds = hasRunIds ? Array.from(new Set(runIdsFromArray)) : [params.runId as number];
			const firstRunId = targetRunIds[0];

			if (asyncAction === "status" || asyncAction === "detail") {
				const run = store.commandRuns.get(firstRunId);
				if (!run) {
					return {
						content: [{ type: "text", text: `Unknown subagent run #${firstRunId}.` }],
						details: makeDetails("single")([]),
						isError: true,
					};
				}

				if (asyncAction === "status") {
					const output = run.lastOutput ?? run.lastLine ?? "(no output yet)";
					const preview =
						output.length > STATUS_OUTPUT_PREVIEW_MAX_CHARS
							? `${output.slice(0, STATUS_OUTPUT_PREVIEW_MAX_CHARS)}\n\n... [truncated]`
							: output;
					return {
						content: [
							{
								type: "text",
								text: `${formatCommandRunSummary(run)}\n${run.task}\n\n${preview}`,
							},
						],
						details: makeDetails("single")([]),
					};
				}

				if (run.status === "running") {
					return {
						content: [
							{ type: "text", text: `Subagent run #${run.id} is still running. detail is available after completion.` },
						],
						details: makeDetails("single")([]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: formatRunDetailOutput(run) }],
					details: makeDetails("single")([]),
				};
			}

			if (asyncAction === "abort") {
				const aborting: number[] = [];
				const notRunning: number[] = [];
				const unknown: number[] = [];

				for (const runId of targetRunIds) {
					const run = store.commandRuns.get(runId);
					if (!run) {
						unknown.push(runId);
						continue;
					}

					const abortCtrl = run.abortController ?? store.globalLiveRuns.get(run.id)?.abortController;
					if (run.status !== "running" || !abortCtrl) {
						notRunning.push(runId);
						continue;
					}

					run.lastLine = "Aborting by subagent tool...";
					run.lastOutput = run.lastLine;
					abortCtrl.abort();
					aborting.push(runId);
				}

				if (aborting.length > 0) {
					updateCommandRunsWidget(store, ctx);
				}

				if (targetRunIds.length === 1 && aborting.length === 1 && notRunning.length === 0 && unknown.length === 0) {
					return {
						content: [{ type: "text", text: `Aborting subagent run #${aborting[0]}...` }],
						details: makeDetails("single")([]),
					};
				}

				const lines: string[] = [];
				if (aborting.length > 0) lines.push(`Aborting: ${aborting.map((id) => `#${id}`).join(", ")}.`);
				if (notRunning.length > 0) lines.push(`Not running: ${notRunning.map((id) => `#${id}`).join(", ")}.`);
				if (unknown.length > 0) lines.push(`Unknown: ${unknown.map((id) => `#${id}`).join(", ")}.`);
				if (lines.length === 0) lines.push("No subagent runs matched.");

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: makeDetails("single")([]),
				};
			}

			if (asyncAction === "remove") {
				const removed: number[] = [];
				const abortedWhileRemoving: number[] = [];
				const unknown: number[] = [];

				for (const runId of targetRunIds) {
					const run = store.commandRuns.get(runId);
					if (!run) {
						unknown.push(runId);
						continue;
					}

					const { removed: didRemove, aborted } = removeRun(store, run.id, {
						ctx,
						pi,
						reason: "Aborting by subagent tool remove...",
						removalReason: "tool-remove",
						updateWidget: false,
					});
					if (!didRemove) {
						unknown.push(runId);
						continue;
					}

					removed.push(runId);
					if (aborted) abortedWhileRemoving.push(runId);
				}

				if (removed.length > 0) {
					updateCommandRunsWidget(store, ctx);
				}

				if (targetRunIds.length === 1 && removed.length === 1 && unknown.length === 0) {
					return {
						content: [
							{
								type: "text",
								text:
									abortedWhileRemoving.length > 0
										? `Removed subagent run #${removed[0]} (aborting in background).`
										: `Removed subagent run #${removed[0]}.`,
							},
						],
						details: makeDetails("single")([]),
					};
				}

				const lines: string[] = [];
				if (removed.length > 0) lines.push(`Removed: ${removed.map((id) => `#${id}`).join(", ")}.`);
				if (abortedWhileRemoving.length > 0)
					lines.push(`Aborting in background: ${abortedWhileRemoving.map((id) => `#${id}`).join(", ")}.`);
				if (unknown.length > 0) lines.push(`Unknown: ${unknown.map((id) => `#${id}`).join(", ")}.`);
				if (lines.length === 0) lines.push("No subagent runs matched.");

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: makeDetails("single")([]),
				};
			}
		}

		if (modeCount !== 1) {
			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [
					{
						type: "text",
						text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
					},
				],
				details: makeDetails("single")([]),
			};
		}

		const runAsync = params.runAsync ?? true;

		if (runAsync) {
			if (hasChain) {
				return {
					content: [
						{
							type: "text",
							text: withIdleRunWarning(
								"runAsync supports single mode only. For dependent multi-step work, use chain with runAsync:false.",
							),
						},
					],
					details: makeDetails("single")([]),
					isError: true,
				};
			}

			if (!hasSingle) {
				return {
					content: [
						{
							type: "text",
							text: withIdleRunWarning("runAsync requires single mode: provide agent + task, or continueRunId + task."),
						},
					],
					details: makeDetails("single")([]),
					isError: true,
				};
			}

			if (hasSingle && !params.task) {
				return {
					content: [{ type: "text", text: withIdleRunWarning("single async run requires task.") }],
					details: makeDetails("single")([]),
					isError: true,
				};
			}

			if (runCounts.running >= MAX_CONCURRENT_ASYNC_SUBAGENT_RUNS) {
				return {
					content: [
						{
							type: "text",
							text: withIdleRunWarning(
								`Too many running subagent runs (${runCounts.running}). Max is ${MAX_CONCURRENT_ASYNC_SUBAGENT_RUNS}. ` +
									`Wait for completion, abort unnecessary runs, or remove stale runs before starting a new one.`,
							),
						},
					],
					details: makeDetails("single")([]),
					isError: true,
				};
			}

			// Async runs always use a dedicated session file (not a copy of
			// the main session) to avoid contamination.  The "B" approach is
			// used: mainContextText was already extracted above and will be
			// injected into the task via wrapTaskWithMainContext.
			// inheritMainContext is intentionally kept so that contextMode
			// metadata correctly reflects "main" when the caller requested it.

			// --- continueRunId: resume an existing completed/error run ---
			let continueFromRun: CommandRunState | undefined;
			if (params.continueRunId !== undefined) {
				continueFromRun = store.commandRuns.get(params.continueRunId);
				if (!continueFromRun) {
					return {
						content: [
							{
								type: "text",
								text: withIdleRunWarning(
									`Unknown subagent run #${params.continueRunId}. Use asyncAction:"list" to see available runs.`,
								),
							},
						],
						details: makeDetails("single")([]),
						isError: true,
					};
				}
				if (continueFromRun.status === "running") {
					return {
						content: [
							{
								type: "text",
								text: withIdleRunWarning(
									`Subagent #${params.continueRunId} is still running. Wait for it to finish or abort it first.`,
								),
							},
						],
						details: makeDetails("single")([]),
						isError: true,
					};
				}
			}

			const resolvedAgent = params.agent ?? continueFromRun?.agent ?? "worker";
			const resolvedAgentConfig = agents.find((a) => a.name === resolvedAgent);
			let runId: number;
			let runState: CommandRunState;
			let taskForDisplay: string;
			let sessionFileForRun: string | undefined;

			if (continueFromRun) {
				// Reuse existing run — same pattern as /sub:main command continuation
				runId = continueFromRun.id;
				taskForDisplay = `[continue #${runId}] ${params.task}`;
				sessionFileForRun = continueFromRun.sessionFile;

				runState = continueFromRun;
				runState.agent = resolvedAgent;
				runState.task = taskForDisplay;
				runState.status = "running";
				runState.startedAt = Date.now();
				runState.lastActivityAt = Date.now();
				runState.elapsedMs = 0;
				runState.toolCalls = 0;
				runState.lastLine = "";
				runState.lastOutput = "";
				runState.continuedFromRunId = params.continueRunId;
				runState.usage = undefined;
				runState.model = undefined;
				runState.removed = false;
				runState.turnCount = Math.max(DEFAULT_TURN_COUNT, runState.turnCount || DEFAULT_TURN_COUNT) + 1;
				runState.contextMode = runState.contextMode ?? (inheritMainContext ? "main" : "sub");
				runState.sessionFile = runState.sessionFile ?? makeSubagentSessionFile(runId);
				runState.source = "tool";
				runState.characterField = runState.characterField ?? resolvedAgentConfig?.character;
				sessionFileForRun = runState.sessionFile;
			} else {
				runId = store.nextCommandRunId++;
				taskForDisplay = params.task!;
				sessionFileForRun = makeSubagentSessionFile(runId);

				runState = {
					id: runId,
					agent: resolvedAgent,
					task: taskForDisplay,
					status: "running",
					startedAt: Date.now(),
					lastActivityAt: Date.now(),
					elapsedMs: 0,
					toolCalls: 0,
					lastLine: "",
					lastOutput: "",
					turnCount: DEFAULT_TURN_COUNT,
					sessionFile: sessionFileForRun,
					removed: false,
					contextMode: inheritMainContext ? "main" : "sub",
					source: "tool",
					characterField: resolvedAgentConfig?.character,
				};
				store.commandRuns.set(runId, runState);
			}

			const abortController = new AbortController();
			runState.abortController = abortController;

			// Register in global live run registry (survives session switches).
			let originSessionFile = "";
			try {
				const raw = ctx.sessionManager.getSessionFile() ?? "";
				originSessionFile = raw.replace(/[\r\n\t]+/g, "").trim();
			} catch {
				/* ignore */
			}
			store.globalLiveRuns.set(runId, {
				runState,
				abortController,
				originSessionFile,
			});

			store.commandWidgetCtx = ctx;
			updateCommandRunsWidget(store, ctx);

			const startedState = continueFromRun ? "resumed" : "started";
			const contextLabel = runState.contextMode === "main" ? "main context" : "dedicated sub-session";

			pi.sendMessage(
				{
					customType: "subagent-tool",
					content:
						`[subagent:${resolvedAgent}#${runId}] ${startedState}` +
						`\nContext: ${contextLabel} · turn ${runState.turnCount}` +
						``,
					display: false,
					details: {
						runId,
						agent: resolvedAgent,
						task: taskForDisplay,
						continuedFromRunId: params.continueRunId,
						turnCount: runState.turnCount,
						contextMode: runState.contextMode,
						sessionFile: runState.sessionFile,
						status: startedState,
						thoughtText: runState.thoughtText,
						characterField: runState.characterField,
					},
				},
				{ deliverAs: "followUp", triggerTurn: false },
			);

			if (ctx.hasUI) {
				ctx.ui.notify(
					(continueFromRun
						? `Resumed subagent #${runId}: ${resolvedAgent}`
						: `Started subagent #${runId}: ${resolvedAgent}`) + ` (${contextLabel} · turn ${runState.turnCount})`,
					"info",
				);
			}

			void (async () => {
				try {
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						resolvedAgent,
						wrapTaskWithMainContext(params.task!, mainContextText, { mainSessionFile, totalMessageCount }),
						params.cwd,
						undefined,
						abortController.signal,
						(partial) => {
							if (runState.removed) return;
							const current = partial.details?.results?.[0];
							if (!current) return;
							updateRunFromResult(runState, current);
							updateCommandRunsWidget(store);
						},
						makeDetails("single"),
						runState.sessionFile,
					);

					if (runState.removed) return;

					updateRunFromResult(runState, result);

					// Escalation detection: subagent used escalate tool (exit code 42)
					if (result.exitCode === ESCALATION_EXIT_CODE && runState.sessionFile) {
						const escalation = readAndConsumeEscalation(runState.sessionFile);
						const escalationMsg = escalation?.message ?? "Subagent escalated without a message.";
						runState.status = "error";
						runState.elapsedMs = Date.now() - runState.startedAt;
						runState.lastOutput = `[ESCALATION] ${escalationMsg}`;
						runState.lastLine = `[ESCALATION] ${escalationMsg}`;
						updateCommandRunsWidget(store);

						const usage = formatUsageStats(result.usage, result.model);
						const completionMessage = {
							customType: "subagent-tool" as const,
							content:
								`[subagent:${resolvedAgent}#${runId}] escalated` +
								`\nPrompt: ${truncateLines(taskForDisplay, 2)}` +
								(usage ? `\nUsage: ${usage}` : "") +
								`\n\n[ESCALATION] ${escalationMsg}`,
							display: true,
							details: {
								runId,
								agent: resolvedAgent,
								task: taskForDisplay,
								status: "error" as const,
								exitCode: result.exitCode,
								usage: result.usage,
								model: result.model,
							},
						};
						pi.sendMessage(completionMessage, { triggerTurn: true });
						return;
					}

					const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
					runState.status = isError ? "error" : "done";
					runState.elapsedMs = Date.now() - runState.startedAt;
					updateCommandRunsWidget(store);

					const rawOutput = isError
						? result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)"
						: getFinalOutput(result.messages) || "(no output)";
					const usage = formatUsageStats(result.usage, result.model);

					runState.lastOutput = rawOutput;
					if (rawOutput) runState.lastLine = getLastNonEmptyLine(rawOutput);

					const completionMessage = {
						customType: "subagent-tool" as const,
						content:
							`[subagent:${resolvedAgent}#${runId}] ${isError ? "failed" : "completed"}` +
							`\nPrompt: ${truncateLines(taskForDisplay, 2)}` +
							(usage ? `\nUsage: ${usage}` : "") +
							(runState.thoughtText ? `\nThought: ${runState.thoughtText}` : "") +
							`\n\n${rawOutput}`,
						display: true,
						details: {
							runId,
							agent: resolvedAgent,
							task: taskForDisplay,
							continuedFromRunId: params.continueRunId,
							turnCount: runState.turnCount,
							contextMode: runState.contextMode,
							sessionFile: runState.sessionFile,
							exitCode: result.exitCode,
							usage: result.usage,
							model: result.model,
							source: result.agentSource,
							thoughtText: runState.thoughtText,
							status: runState.status,
							characterField: runState.characterField,
						},
					};
					const completionOptions = { deliverAs: "followUp" as const, triggerTurn: true };

					// Check if the user is still in the origin session.
					const toolGlobalEntry = store.globalLiveRuns.get(runId);
					let toolCurrentSession: string | null = null;
					try {
						const rawSession = ctx.sessionManager.getSessionFile() ?? null;
						toolCurrentSession = rawSession ? rawSession.replace(/[\r\n\t]+/g, "").trim() : null;
					} catch {
						/* ignore */
					}

					const toolInOrigin =
						!toolGlobalEntry ||
						!toolCurrentSession ||
						!toolGlobalEntry.originSessionFile ||
						toolCurrentSession === toolGlobalEntry.originSessionFile;

					if (toolInOrigin) {
						pi.sendMessage(completionMessage, completionOptions);
						store.globalLiveRuns.delete(runId);
					} else {
						// User is in a different session — queue for later delivery.
						toolGlobalEntry.pendingCompletion = {
							message: completionMessage,
							options: completionOptions,
						};
						store.commandRuns.set(runId, runState);
					}

					if (ctx.hasUI) {
						ctx.ui.notify(
							isError
								? `subagent tool run #${runId} (${resolvedAgent}) failed`
								: `subagent tool run #${runId} (${resolvedAgent}) completed`,
							isError ? "error" : "info",
						);
					}
				} catch (error: any) {
					if (runState.removed) return;
					runState.status = "error";
					runState.elapsedMs = Date.now() - runState.startedAt;
					runState.lastLine = error?.message ? String(error.message) : "Subagent execution failed";
					runState.lastOutput = runState.lastLine;

					const errorMessage = {
						customType: "subagent-tool" as const,
						content:
							`[subagent:${resolvedAgent}#${runId}] failed` +
							`\nPrompt: ${truncateLines(taskForDisplay, 2)}` +
							`\n\n${runState.lastLine}`,
						display: true,
						details: {
							runId,
							agent: resolvedAgent,
							task: taskForDisplay,
							continuedFromRunId: params.continueRunId,
							turnCount: runState.turnCount,
							contextMode: runState.contextMode,
							sessionFile: runState.sessionFile,
							error: runState.lastLine,
							thoughtText: runState.thoughtText,
							status: runState.status,
							characterField: runState.characterField,
						},
					};

					// Error path: also check origin session for deferred delivery.
					const errGlobalEntry = store.globalLiveRuns.get(runId);
					let errCurrentSession: string | null = null;
					try {
						const rawErrSession = ctx.sessionManager.getSessionFile() ?? null;
						errCurrentSession = rawErrSession ? rawErrSession.replace(/[\r\n\t]+/g, "").trim() : null;
					} catch {
						/* ignore */
					}

					const errInOrigin =
						!errGlobalEntry ||
						!errCurrentSession ||
						!errGlobalEntry.originSessionFile ||
						errCurrentSession === errGlobalEntry.originSessionFile;

					if (errInOrigin) {
						pi.sendMessage(errorMessage, { deliverAs: "followUp", triggerTurn: true });
						store.globalLiveRuns.delete(runId);
					} else {
						errGlobalEntry.pendingCompletion = {
							message: errorMessage,
							options: { deliverAs: "followUp", triggerTurn: true },
						};
						store.commandRuns.set(runId, runState);
					}

					if (ctx.hasUI) ctx.ui.notify(`subagent tool run #${runId} failed: ${runState.lastLine}`, "error");
					updateCommandRunsWidget(store);
				} finally {
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

			return {
				content: [
					{
						type: "text",
						text: withIdleRunWarning(
							continueFromRun
								? `Resumed async subagent run #${runId} (${resolvedAgent}) turn ${runState.turnCount}.`
								: `Started async subagent run #${runId} (${resolvedAgent}).`,
						),
					},
				],
				details: makeDetails("single")([]),
			};
		}

		if (params.chain && params.chain.length > 0) {
			const chainSteps = params.chain as ChainItemFields[];
			const results: SingleResult[] = [];
			let previousOutput = "";

			for (let i = 0; i < chainSteps.length; i++) {
				const step = chainSteps[i];
				const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

				// Create update callback that includes all previous results
				const chainUpdate: OnUpdateCallback | undefined = onUpdate
					? (partial) => {
							// Combine completed results with current streaming result
							const currentResult = partial.details?.results[0];
							if (currentResult) {
								const allResults = [...results, currentResult];
								onUpdate({
									content: partial.content,
									details: makeDetails("chain")(allResults),
								});
							}
						}
					: undefined;

				const result = await runSingleAgent(
					ctx.cwd,
					agents,
					step.agent,
					wrapTaskWithMainContext(taskWithContext, mainContextText, { mainSessionFile, totalMessageCount }),
					step.cwd,
					i + 1,
					signal,
					chainUpdate,
					makeDetails("chain"),
					undefined,
				);
				results.push(result);

				// Escalation detection in chain
				if (result.exitCode === ESCALATION_EXIT_CODE) {
					const sessionFile = result.sessionFile;
					const escalation = sessionFile ? readAndConsumeEscalation(sessionFile) : null;
					const escalationMsg = escalation?.message ?? "Subagent escalated without a message.";
					return {
						content: [{ type: "text", text: `[ESCALATION] Chain step ${i + 1} (${step.agent}): ${escalationMsg}` }],
						details: makeDetails("chain")(results),
						isError: true,
					};
				}

				const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
				if (isError) {
					const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
					return {
						content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
						details: makeDetails("chain")(results),
						isError: true,
					};
				}
				previousOutput = getFinalOutput(result.messages);
			}
			return {
				content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
				details: makeDetails("chain")(results),
			};
		}

		if (params.agent && params.task) {
			const result = await runSingleAgent(
				ctx.cwd,
				agents,
				params.agent,
				wrapTaskWithMainContext(params.task, mainContextText, { mainSessionFile, totalMessageCount }),
				params.cwd,
				undefined,
				signal,
				onUpdate,
				makeDetails("single"),
				undefined,
			);

			// Escalation detection in single run
			if (result.exitCode === ESCALATION_EXIT_CODE) {
				const sessionFile = result.sessionFile;
				const escalation = sessionFile ? readAndConsumeEscalation(sessionFile) : null;
				const escalationMsg = escalation?.message ?? "Subagent escalated without a message.";
				return {
					content: [{ type: "text", text: `[ESCALATION] ${escalationMsg}` }],
					details: makeDetails("single")([result]),
					isError: true,
				};
			}

			const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
			if (isError) {
				const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
				return {
					content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
					details: makeDetails("single")([result]),
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
				details: makeDetails("single")([result]),
			};
		}

		const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
		return {
			content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
			details: makeDetails("single")([]),
		};
	};
}
